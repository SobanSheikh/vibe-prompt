import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { ClientRequest } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import type * as vscode from "vscode";

export interface WhisperModel {
  id: string;
  name: string;
  description: string;
  sizeLabel: string;
  bytes: number;
  sha256: string;
  recommended?: boolean;
}

export interface WhisperModelState extends WhisperModel {
  installed: boolean;
  active: boolean;
}

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const WHISPER_MODELS: readonly WhisperModel[] = [
  {
    id: "tiny.en",
    name: "Tiny English",
    description: "Fastest, with lower accuracy",
    sizeLabel: "74 MB",
    bytes: 77_704_715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  },
  {
    id: "base.en",
    name: "Base English",
    description: "Balanced speed and accuracy",
    sizeLabel: "141 MB",
    bytes: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    recommended: true,
  },
  {
    id: "small.en",
    name: "Small English",
    description: "More accurate, but slower",
    sizeLabel: "465 MB",
    bytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  },
];

export class ModelManager implements vscode.Disposable {
  private request: ClientRequest | undefined;
  private cancelled = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  public async download(
    modelId: string,
    onProgress: (downloaded: number, total: number) => void,
  ): Promise<string> {
    const model = WHISPER_MODELS.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error("Unknown Whisper model.");
    }

    this.cancelled = false;
    await mkdir(this.storageUri.fsPath, { recursive: true });
    const destination = path.join(this.storageUri.fsPath, `ggml-${model.id}.bin`);
    const partial = `${destination}.download`;

    if (await this.isValid(destination, model)) {
      return destination;
    }

    await rm(partial, { force: true });
    try {
      await this.downloadToFile(
        `${MODEL_BASE_URL}/ggml-${model.id}.bin`,
        partial,
        model,
        onProgress,
      );
      await rename(partial, destination);
      return destination;
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  public async list(activePath: string): Promise<WhisperModelState[]> {
    return Promise.all(WHISPER_MODELS.map(async (model) => {
      const modelPath = this.modelPath(model);
      let installed = false;
      try {
        installed = (await stat(modelPath)).size === model.bytes;
      } catch {
        installed = false;
      }
      return {
        ...model,
        installed,
        active: installed && path.resolve(activePath) === path.resolve(modelPath),
      };
    }));
  }

  public async select(modelId: string): Promise<string> {
    const model = WHISPER_MODELS.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("Unknown Whisper model.");
    const modelPath = this.modelPath(model);
    if ((await stat(modelPath)).size !== model.bytes) {
      throw new Error(`${model.name} is not completely installed.`);
    }
    return modelPath;
  }

  public async remove(modelId: string): Promise<void> {
    const model = WHISPER_MODELS.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("Unknown Whisper model.");
    await rm(this.modelPath(model), { force: true });
  }

  public cancel(): void {
    this.cancelled = true;
    this.request?.destroy(new Error("Model download cancelled."));
    this.request = undefined;
  }

  public dispose(): void {
    this.cancel();
  }

  private modelPath(model: WhisperModel): string {
    return path.join(this.storageUri.fsPath, `ggml-${model.id}.bin`);
  }

  private async isValid(filePath: string, model: WhisperModel): Promise<boolean> {
    try {
      const details = await stat(filePath);
      if (details.size !== model.bytes) return false;
      return (await hashFile(filePath)) === model.sha256;
    } catch {
      return false;
    }
  }

  private downloadToFile(
    url: string,
    destination: string,
    model: WhisperModel,
    onProgress: (downloaded: number, total: number) => void,
    redirects = 0,
  ): Promise<void> {
    if (redirects > 5) {
      return Promise.reject(new Error("Too many redirects while downloading the model."));
    }

    return new Promise((resolve, reject) => {
      if (!url.startsWith("https:")) {
        reject(new Error("Refusing a non-HTTPS model download."));
        return;
      }
      const request = httpsGet(url, { headers: { "User-Agent": "Codex-Voice-VSCode" } }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const redirectUrl = new URL(response.headers.location, url).toString();
          void this.downloadToFile(redirectUrl, destination, model, onProgress, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Model download failed with HTTP ${response.statusCode ?? "unknown"}.`));
          return;
        }

        const output = createWriteStream(destination, { flags: "wx" });
        const hash = createHash("sha256");
        let downloaded = 0;
        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          hash.update(chunk);
          onProgress(downloaded, model.bytes);
        });
        response.pipe(output);
        response.once("error", (error) => {
          output.destroy();
          reject(error);
        });
        output.once("error", reject);
        output.once("close", () => {
          if (this.cancelled) {
            reject(new Error("Model download cancelled."));
          } else if (downloaded !== model.bytes) {
            reject(new Error(`Model download was incomplete (${downloaded} of ${model.bytes} bytes).`));
          } else if (hash.digest("hex") !== model.sha256) {
            reject(new Error("Model verification failed. The downloaded file was discarded."));
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

async function hashFile(filePath: string): Promise<string> {
  await access(filePath);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolve(hash.digest("hex")));
  });
}
