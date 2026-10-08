import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const SAMPLE_RATE = 16_000;
const STDERR_LIMIT = 8_000;

export interface AudioInput {
  label: string;
  value: string;
}

export class AudioRecorder {
  private process: ChildProcessWithoutNullStreams | undefined;
  private starting = false;
  private startGeneration = 0;
  private stopping = false;
  private stderr = "";

  constructor(
    private readonly onAudio: (chunk: Buffer) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  public get isRecording(): boolean {
    return this.process !== undefined || this.starting;
  }

  public async start(device: string, ffmpegPath = "ffmpeg"): Promise<void> {
    if (this.process || this.starting) {
      throw new Error("A recording is already in progress.");
    }

    const generation = ++this.startGeneration;
    this.starting = true;
    this.stopping = false;
    this.stderr = "";
    let resolvedDevice: string;
    try {
      if (!device || device === "default") {
        resolvedDevice = process.platform === "win32"
          ? await this.defaultWindowsInput(ffmpegPath)
          : process.platform === "darwin"
            ? await this.defaultMacInput(ffmpegPath)
            : "default";
      } else {
        resolvedDevice = device;
      }
    } finally {
      if (generation === this.startGeneration) this.starting = false;
    }
    if (generation !== this.startGeneration) return;
    const child = spawn(ffmpegPath, buildAudioArguments(process.platform, resolvedDevice), {
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
    this.startGeneration += 1;
    this.starting = false;
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
    this.startGeneration += 1;
    this.starting = false;
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
    this.startGeneration += 1;
    this.starting = false;
    this.stopping = true;
    this.process?.kill("SIGKILL");
    this.process = undefined;
  }

  public async listAudioInputs(ffmpegPath = "ffmpeg"): Promise<AudioInput[]> {
    if (process.platform === "win32") {
      return (await this.windowsAudioInputs(ffmpegPath)).map((value) => ({ label: value, value }));
    }
    if (process.platform === "darwin") return this.macAudioInputs(ffmpegPath);
    return [{ label: "System default", value: "default" }];
  }

  private async defaultWindowsInput(ffmpegPath: string): Promise<string> {
    const devices = await this.windowsAudioInputs(ffmpegPath);
    if (devices.length === 0) {
      throw new Error("No Windows microphone was found. Check microphone permissions and FFmpeg installation.");
    }
    return devices[0];
  }

  private async defaultMacInput(ffmpegPath: string): Promise<string> {
    const devices = await this.macAudioInputs(ffmpegPath);
    if (devices.length === 0) {
      throw new Error("No macOS microphone was found. Check microphone permissions and FFmpeg installation.");
    }
    return devices[0].value;
  }

  private macAudioInputs(ffmpegPath: string): Promise<AudioInput[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Timed out while discovering macOS microphones."));
      }, 10_000);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => finish(() => reject(new Error(`Could not enumerate macOS audio devices: ${error.message}`))));
      child.once("exit", () => finish(() => resolve(parseMacAudioInputs(stderr))));
    });
  }

  private windowsAudioInputs(ffmpegPath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Timed out while discovering Windows microphones."));
      }, 10_000);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => finish(() => reject(new Error(`Could not enumerate Windows audio devices: ${error.message}`))));
      child.once("exit", () => finish(() => {
        resolve(parseWindowsAudioInputs(stderr));
      }));
    });
  }
}

export function buildAudioArguments(platform: NodeJS.Platform, device: string): string[] {
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

  if (platform === "darwin") {
    return ["-f", "avfoundation", "-i", device || ":0", ...output];
  }
  if (platform === "win32") {
    return ["-f", "dshow", "-i", `audio=${device}`, ...output];
  }
  return ["-f", "pulse", "-i", device || "default", ...output];
}

export function parseWindowsAudioInputs(stderr: string): string[] {
  const devices: string[] = [];
  const pattern = /"([^"]+)"\s+\(audio\)/g;
  for (const match of stderr.matchAll(pattern)) {
    if (!devices.includes(match[1])) devices.push(match[1]);
  }
  return devices;
}

export function parseMacAudioInputs(stderr: string): AudioInput[] {
  const marker = /AVFoundation audio devices:/i.exec(stderr);
  if (!marker) return [];
  const devices: AudioInput[] = [];
  const pattern = /\[(\d+)\]\s+([^\r\n]+)/g;
  for (const match of stderr.slice(marker.index + marker[0].length).matchAll(pattern)) {
    const label = match[2].replace(/^\[[^\]]+\]\s*/, "").trim();
    if (!devices.some((device) => device.value === `:${match[1]}`)) {
      devices.push({ label, value: `:${match[1]}` });
    }
  }
  return devices;
}
