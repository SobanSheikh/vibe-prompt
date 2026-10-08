import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { ClientRequest } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import type * as vscode from "vscode";

interface RuntimeAsset {
  url: string;
  archiveName: string;
  archiveType: "tar.gz" | "zip";
  binaryRelativePath: string;
  bytes: number;
  sha256: string;
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

  constructor(private readonly storageUri: vscode.Uri) {}

  public get supportsAutomaticInstall(): boolean {
    return this.asset !== undefined;
  }

  public async install(onProgress: (downloaded: number, total: number) => void): Promise<string> {
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
    const archivePath = path.join(root, `${asset.archiveName}.download`);
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
    this.request?.destroy(new Error("Runtime download cancelled."));
    this.request = undefined;
  }

  public dispose(): void {
    this.cancel();
  }

  private get asset(): RuntimeAsset | undefined {
    return RUNTIMES[`${process.platform}-${process.arch}`];
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
