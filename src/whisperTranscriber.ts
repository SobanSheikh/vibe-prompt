import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { encodePcm16Wav } from "./wav";
import { buildWhisperArguments } from "./whisperArguments";

const SAMPLE_RATE = 16_000;

export class WhisperTranscriber implements vscode.Disposable {
  private readonly processes = new Set<ChildProcess>();

  constructor(private readonly storageUri: vscode.Uri) {}

  public async validate(): Promise<void> {
    const { binaryPath, modelPath } = this.configuration();
    if (!modelPath) {
      throw new Error("Set Vibe Prompt: Whisper Model Path before recording.");
    }
    await access(modelPath).catch(() => {
      throw new Error(`Whisper model not found: ${modelPath}`);
    });

    await this.validateBinary(binaryPath);
  }

  public async isBinaryAvailable(): Promise<boolean> {
    try {
      await this.validateBinary(this.configuration().binaryPath);
      return true;
    } catch {
      return false;
    }
  }

  private async validateBinary(binaryPath: string): Promise<void> {
    if (binaryPath.includes(path.sep)) {
      await access(binaryPath).catch(() => {
        throw new Error(`Whisper executable not found: ${binaryPath}`);
      });
      return;
    }

    const lookup = spawnSync(process.platform === "win32" ? "where" : "which", [binaryPath]);
    if (lookup.status !== 0) {
      throw new Error(`Whisper executable '${binaryPath}' was not found on PATH.`);
    }
  }

  public async transcribe(pcm: Buffer): Promise<string> {
    if (pcm.length === 0) {
      return "";
    }

    const { binaryPath, modelPath, language } = this.configuration();
    await mkdir(this.storageUri.fsPath, { recursive: true });
    const inputPath = path.join(this.storageUri.fsPath, `${randomUUID()}.wav`);
    await writeFile(inputPath, encodePcm16Wav(pcm, SAMPLE_RATE));

    try {
      return await this.run(binaryPath, buildWhisperArguments(modelPath, inputPath, language));
    } finally {
      await rm(inputPath, { force: true });
    }
  }

  public cancelAll(): void {
    for (const child of this.processes) {
      child.kill("SIGKILL");
    }
    this.processes.clear();
  }

  public dispose(): void {
    this.cancelAll();
  }

  private configuration(): {
    binaryPath: string;
    modelPath: string;
    language: string;
  } {
    const configuration = vscode.workspace.getConfiguration("vibePrompt");
    return {
      binaryPath: configuration.get<string>("whisperBinaryPath", "whisper-cli"),
      modelPath: configuration.get<string>("modelPath", ""),
      language: configuration.get<string>("language", "en"),
    };
  }

  private run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const binaryDirectory = command.includes(path.sep) ? path.dirname(command) : undefined;
      const child = spawn(command, args, {
        windowsHide: true,
        cwd: binaryDirectory,
        env: binaryDirectory && process.platform === "linux"
          ? { ...process.env, LD_LIBRARY_PATH: [binaryDirectory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
          : process.env,
      });
      this.processes.add(child);
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => {
        this.processes.delete(child);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        this.processes.delete(child);
        if (signal === "SIGKILL") {
          reject(new Error("Transcription cancelled."));
        } else if (code !== 0) {
          reject(new Error(stderr.trim() || `Whisper exited with code ${code}.`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}
