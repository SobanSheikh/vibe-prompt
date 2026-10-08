import { spawn } from "node:child_process";

export interface FfmpegStatus {
  ready: boolean;
  message: string;
  version?: string;
}

export interface ProcessResult {
  code: number | null;
  output: string;
}

const CACHE_DURATION_MS = 30_000;
const CHECK_TIMEOUT_MS = 8_000;

export class FfmpegManager {
  private cached: { binaryPath: string; checkedAt: number; status: FfmpegStatus } | undefined;

  public async check(binaryPath: string, force = false): Promise<FfmpegStatus> {
    if (
      !force
      && this.cached?.binaryPath === binaryPath
      && Date.now() - this.cached.checkedAt < CACHE_DURATION_MS
    ) {
      return this.cached.status;
    }

    const status = await this.inspect(binaryPath);
    this.cached = { binaryPath, checkedAt: Date.now(), status };
    return status;
  }

  private async inspect(binaryPath: string): Promise<FfmpegStatus> {
    try {
      const versionResult = await run(binaryPath, ["-hide_banner", "-version"]);
      if (versionResult.code !== 0) {
        return evaluateFfmpeg(process.platform, versionResult, { code: null, output: "" });
      }
      const deviceResult = await run(binaryPath, ["-hide_banner", "-devices"]);
      return evaluateFfmpeg(process.platform, versionResult, deviceResult);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        message: detail.includes("ENOENT")
          ? "FFmpeg was not found. Install it or configure Codex Voice: FFmpeg Path."
          : `FFmpeg check failed: ${detail}`,
      };
    }
  }
}

export function evaluateFfmpeg(
  platform: NodeJS.Platform,
  versionResult: ProcessResult,
  deviceResult: ProcessResult,
): FfmpegStatus {
  if (versionResult.code !== 0) {
    return { ready: false, message: "FFmpeg could not be started successfully." };
  }

  const backend = platform === "win32"
    ? "dshow"
    : platform === "linux"
      ? "pulse"
      : platform === "darwin"
        ? "avfoundation"
        : undefined;
  if (!backend) {
    return { ready: false, message: "This operating system is not supported by the current desktop release." };
  }

  const backendPattern = new RegExp(`^\\s*D\\s+${backend}\\s`, "m");
  if (deviceResult.code !== 0 || !backendPattern.test(deviceResult.output)) {
    return {
      ready: false,
      message: `This FFmpeg installation does not include the '${backend}' audio capture backend.`,
    };
  }

  const version = /ffmpeg version\s+([^\s]+)/i.exec(versionResult.output)?.[1];
  return { ready: true, message: version ? `FFmpeg ${version}` : "FFmpeg is ready.", version };
}

function run(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("FFmpeg check timed out.")));
    }, CHECK_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => resolve({ code, output })));
  });
}
