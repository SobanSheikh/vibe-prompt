import { createHash } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { ClientRequest } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import os from "node:os";
import type * as vscode from "vscode";

interface RuntimeAsset {
  url: string;
  archiveName: string;
  archiveType: "tar.gz" | "zip";
  binaryRelativePath: string;
  bytes: number;
  sha256: string;
}

const WHISPER_REPOSITORY = "https://github.com/ggml-org/whisper.cpp.git";

export type RuntimeInstallMethod = "archive" | "source" | "unsupported";

export function runtimeInstallMethod(platform: NodeJS.Platform, arch: string): RuntimeInstallMethod {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return "source";
  return RUNTIMES[`${platform}-${arch}`] ? "archive" : "unsupported";
}

export function runtimeArchiveDownloadName(asset: Pick<RuntimeAsset, "archiveName" | "archiveType">): string {
  return `${asset.archiveName}.download.${asset.archiveType}`;
}

const RUNTIMES: Record<string, RuntimeAsset> = {
  "linux-x64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz",
    archiveName: "whisper-bin-ubuntu-x64.tar.gz",
    archiveType: "tar.gz",
    binaryRelativePath: "whisper-bin-ubuntu-x64/whisper-cli",
    bytes: 10_364_195,
    sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c",
  },
  "linux-arm64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-arm64.tar.gz",
    archiveName: "whisper-bin-ubuntu-arm64.tar.gz",
    archiveType: "tar.gz",
    binaryRelativePath: "whisper-bin-ubuntu-arm64/whisper-cli",
    bytes: 4_608_377,
    sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149",
  },
  "win32-x64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
    archiveName: "whisper-bin-x64.zip",
    archiveType: "zip",
    binaryRelativePath: "Release/whisper-cli.exe",
    bytes: 8_928_640,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
  },
  "win32-arm64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cpu-arm64.zip",
    archiveName: "whisper-bin-win-cpu-arm64.zip",
    archiveType: "zip",
    binaryRelativePath: "Release/whisper-cli.exe",
    bytes: 4_371_193,
    sha256: "28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d",
  },
};

export class RuntimeManager implements vscode.Disposable {
  private request: ClientRequest | undefined;
  private readonly processes = new Set<ChildProcess>();
  private cancelled = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  public get supportsAutomaticInstall(): boolean {
    return runtimeInstallMethod(process.platform, process.arch) !== "unsupported";
  }

  public async install(onProgress: (downloaded: number, total: number) => void): Promise<string> {
    this.cancelled = false;
    if (process.platform === "darwin") return this.installMacRuntime(onProgress);
    const asset = this.asset;
    if (!asset) throw new Error("Automatic whisper.cpp runtime installation is not available on this platform.");

    const root = this.storageUri.fsPath;
    const binaryPath = path.join(root, asset.binaryRelativePath);
    try {
      await this.verify(binaryPath);
      return binaryPath;
    } catch {
      // Continue with a clean installation.
    }

    await mkdir(root, { recursive: true });
    const archivePath = path.join(root, runtimeArchiveDownloadName(asset));
    await rm(archivePath, { force: true });
    await rm(path.dirname(binaryPath), { recursive: true, force: true });

    try {
      await this.download(asset, archivePath, onProgress);
      await extractArchive(asset.archiveType, archivePath, root);
      if (process.platform !== "win32") await chmod(binaryPath, 0o755);
      await this.verify(binaryPath);
      return binaryPath;
    } finally {
      await rm(archivePath, { force: true });
    }
  }

  public cancel(): void {
    this.cancelled = true;
    this.request?.destroy(new Error("Runtime download cancelled."));
    this.request = undefined;
    for (const child of this.processes) killProcessTree(child);
    this.processes.clear();
  }

  public dispose(): void {
    this.cancel();
  }

  private get asset(): RuntimeAsset | undefined {
    return RUNTIMES[`${process.platform}-${process.arch}`];
  }

  private async installMacRuntime(onProgress: (completed: number, total: number) => void): Promise<string> {
    const root = this.storageUri.fsPath;
    const sourceDir = path.join(root, "whisper.cpp.source");
    const runtimeDir = path.join(root, "whisper-bin-macos");
    const binaryPath = path.join(runtimeDir, "whisper-cli");
    try {
      await this.verify(binaryPath);
      return binaryPath;
    } catch {
      // Continue with a clean, pinned source build.
    }

    await mkdir(root, { recursive: true });
    await rm(sourceDir, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
    let installed = false;

    try {
      onProgress(5, 100);
      await this.requireCommand("git", ["--version"], "Git");
      await this.requireCommand("cmake", ["--version"], "CMake");
      await this.requireCommand("xcode-select", ["-p"], "Xcode Command Line Tools");
      this.throwIfCancelled();

      onProgress(15, 100);
      await this.runManaged("git", ["clone", "--depth", "1", WHISPER_REPOSITORY, sourceDir]);
      this.throwIfCancelled();

      onProgress(40, 100);
      const buildDir = path.join(sourceDir, "build");
      await this.runManaged("cmake", [
        "-S", sourceDir,
        "-B", buildDir,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_BACKEND_DL=OFF",
        "-DGGML_METAL=ON",
        "-DWHISPER_BUILD_TESTS=OFF",
        "-DWHISPER_BUILD_SERVER=OFF",
      ]);
      this.throwIfCancelled();

      onProgress(60, 100);
      await this.runManaged("cmake", [
        "--build", buildDir,
        "--config", "Release",
        "--target", "whisper-cli",
        "-j", String(Math.max(1, os.cpus().length)),
      ]);
      this.throwIfCancelled();

      onProgress(90, 100);
      await rename(path.join(buildDir, "bin"), runtimeDir);
      await chmod(binaryPath, 0o755);
      await this.verify(binaryPath);
      onProgress(100, 100);
      installed = true;
      return binaryPath;
    } catch (error) {
      if (this.cancelled) throw new Error("Runtime installation cancelled.");
      throw error;
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      if (!installed) await rm(runtimeDir, { recursive: true, force: true });
    }
  }

  private async requireCommand(command: string, args: string[], name: string): Promise<void> {
    try {
      await this.runManaged(command, args);
    } catch {
      const hint = name === "CMake"
        ? "Install it with 'brew install cmake'."
        : name === "Xcode Command Line Tools"
          ? "Install them with 'xcode-select --install'."
          : "Install it and ensure it is available on PATH.";
      throw new Error(`${name} is required to build whisper.cpp on macOS. ${hint}`);
    }
  }

  private runManaged(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.processes.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.processes.delete(child);
        callback();
      };
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) => finish(() => {
        if (signal === "SIGKILL" && this.cancelled) reject(new Error("Runtime installation cancelled."));
        else if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}.`));
      }));
    });
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new Error("Runtime installation cancelled.");
  }

  private async verify(binaryPath: string): Promise<void> {
    await stat(binaryPath);
    await runProcess(binaryPath, ["--version"], path.dirname(binaryPath));
  }

  private download(
    asset: RuntimeAsset,
    destination: string,
    onProgress: (downloaded: number, total: number) => void,
    url = asset.url,
    redirects = 0,
  ): Promise<void> {
    if (redirects > 5) return Promise.reject(new Error("Too many redirects while downloading the runtime."));
    if (!url.startsWith("https:")) return Promise.reject(new Error("Refusing a non-HTTPS runtime download."));

    return new Promise((resolve, reject) => {
      const request = httpsGet(url, { headers: { "User-Agent": "Codex-Voice-VSCode" } }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const redirectUrl = new URL(response.headers.location, url).toString();
          void this.download(asset, destination, onProgress, redirectUrl, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Runtime download failed with HTTP ${response.statusCode ?? "unknown"}.`));
          return;
        }

        const output = createWriteStream(destination, { flags: "wx" });
        const hash = createHash("sha256");
        let downloaded = 0;
        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          hash.update(chunk);
          onProgress(downloaded, asset.bytes);
        });
        response.pipe(output);
        response.once("error", (error) => {
          output.destroy();
          reject(error);
        });
        output.once("error", reject);
        output.once("close", () => {
          if (downloaded !== asset.bytes) {
            reject(new Error(`Runtime download was incomplete (${downloaded} of ${asset.bytes} bytes).`));
          } else if (hash.digest("hex") !== asset.sha256) {
            reject(new Error("Runtime verification failed. The downloaded archive was discarded."));
          } else {
            resolve();
          }
        });
      });
      this.request = request;
      request.once("error", reject);
    });
  }
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct process if its group has already exited.
    }
  }
  child.kill("SIGKILL");
}

function extractArchive(type: RuntimeAsset["archiveType"], archivePath: string, destination: string): Promise<void> {
  if (type === "zip") {
    const command = `Expand-Archive -LiteralPath '${escapePowerShell(archivePath)}' -DestinationPath '${escapePowerShell(destination)}' -Force`;
    return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
  }
  return runProcess("tar", ["-xzf", archivePath, "-C", destination]);
}

function runProcess(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}.`));
    });
  });
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}
