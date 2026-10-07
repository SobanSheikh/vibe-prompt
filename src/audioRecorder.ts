import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const SAMPLE_RATE = 16_000;
const STDERR_LIMIT = 8_000;

export class AudioRecorder {
  private process: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private stderr = "";

  constructor(
    private readonly onAudio: (chunk: Buffer) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  public get isRecording(): boolean {
    return this.process !== undefined;
  }

  public start(device: string): void {
    if (this.process) {
      throw new Error("A recording is already in progress.");
    }

    this.stopping = false;
    this.stderr = "";
    const child = spawn("ffmpeg", this.buildArguments(device), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    child.stdout.on("data", (chunk: Buffer) => this.onAudio(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => {
      this.process = undefined;
      if (!this.stopping) {
        this.onFailure(new Error(`Could not start FFmpeg: ${error.message}`));
      }
    });
    child.once("exit", (code, signal) => {
      this.process = undefined;
      if (!this.stopping && code !== 0) {
        const detail = this.stderr.trim().split("\n").slice(-4).join("\n");
        this.onFailure(
          new Error(`FFmpeg stopped unexpectedly (${signal ?? `exit ${code}`}).${detail ? `\n${detail}` : ""}`),
        );
      }
    });
  }

  public async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    this.stopping = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          clearTimeout(forceTimer);
          resolve();
        }
      };
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 2_000);

      child.once("exit", finish);
      if (child.stdin.writable) {
        child.stdin.write("q\n");
      } else {
        child.kill("SIGINT");
      }
    });
    this.process = undefined;
  }

  public async cancel(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }
    this.stopping = true;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      if (!child.kill("SIGKILL")) {
        resolve();
      }
    });
    this.process = undefined;
  }

  public dispose(): void {
    this.stopping = true;
    this.process?.kill("SIGKILL");
    this.process = undefined;
  }

  private buildArguments(device: string): string[] {
    const output = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-acodec",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ];

    if (process.platform === "darwin") {
      return ["-f", "avfoundation", "-i", device || ":0", ...output];
    }
    if (process.platform === "win32") {
      return ["-f", "dshow", "-i", `audio=${device || "default"}`, ...output];
    }
    return ["-f", "pulse", "-i", device || "default", ...output];
  }
}
