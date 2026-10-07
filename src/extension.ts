import { access, watch, FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { AudioRecorder } from "./audioRecorder";
import { ModelManager, WHISPER_MODELS } from "./modelManager";
import { RuntimeManager } from "./runtimeManager";
import { TranscriptViewProvider } from "./transcriptView";
import { WhisperTranscriber } from "./whisperTranscriber";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const MAX_RECORDING_MS = 10 * 60 * 1_000;
const MIN_PREVIEW_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE;

class VoiceController implements vscode.Disposable {
  private readonly view: TranscriptViewProvider;
  private readonly transcriber: WhisperTranscriber;
  private readonly modelManager: ModelManager;
  private readonly runtimeManager: RuntimeManager;
  private readonly recorder: AudioRecorder;
  private chunks: Buffer[] = [];
  private previewOffset = 0;
  private previewText = "";
  private startedAt = 0;
  private generation = 0;
  private transcribing = false;
  private modelDownloadGeneration = 0;
  private modelDownloadRunning = false;
  private previewRunning = false;
  private previewTimer: NodeJS.Timeout | undefined;
  private clockTimer: NodeJS.Timeout | undefined;
  private modelWatcher: FSWatcher | undefined;
  private watchedModelPath = "";

  constructor(private readonly context: vscode.ExtensionContext) {
    this.transcriber = new WhisperTranscriber(vscode.Uri.joinPath(context.globalStorageUri, "audio"));
    this.modelManager = new ModelManager(vscode.Uri.joinPath(context.globalStorageUri, "models"));
    this.runtimeManager = new RuntimeManager(vscode.Uri.joinPath(context.globalStorageUri, "runtime"));
    this.recorder = new AudioRecorder(
      (chunk) => this.onAudio(chunk),
      (error) => void this.fail(error),
    );
    this.view = new TranscriptViewProvider({
      start: () => this.start(),
      stop: () => this.stop(),
      cancel: () => this.cancel(),
      copy: () => this.copy(),
      clear: () => this.clear(),
      openSettings: async () => {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:sobansheikh.codex-voice");
      },
      downloadModel: (modelId) => this.downloadModel(modelId),
      cancelDownload: () => this.cancelModelDownload(),
      installRuntime: () => this.installRuntime(),
      updateTranscript: (text) => this.updateTranscript(text),
      openModelManager: () => this.openModelManager(),
      closeModelManager: () => this.view.update({ manageModels: false }),
      switchModel: (modelId) => this.switchModel(modelId),
      removeModel: (modelId) => this.removeModel(modelId),
    });
    void this.refreshSetupState();
  }

  public register(): vscode.Disposable[] {
    return [
      vscode.window.registerWebviewViewProvider(TranscriptViewProvider.viewType, this.view),
      vscode.commands.registerCommand("codexVoice.toggleRecording", () =>
        this.recorder.isRecording ? this.stop() : this.start(),
      ),
      vscode.commands.registerCommand("codexVoice.startRecording", () => this.start()),
      vscode.commands.registerCommand("codexVoice.stopRecording", () => this.stop()),
      vscode.commands.registerCommand("codexVoice.cancelRecording", () => this.cancel()),
      vscode.commands.registerCommand("codexVoice.copyTranscript", () => this.copy()),
      vscode.commands.registerCommand("codexVoice.clearTranscript", () => this.clear()),
      vscode.commands.registerCommand("codexVoice.openTranscript", () => this.reveal()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codexVoice.modelPath") || event.affectsConfiguration("codexVoice.whisperBinaryPath")) {
          void this.refreshSetupState(true);
        }
      }),
    ];
  }

  public async start(): Promise<void> {
    if (this.recorder.isRecording || this.transcribing) {
      return;
    }

    try {
      await this.transcriber.validate();
    } catch (error) {
      const message = messageFrom(error);
      await this.refreshSetupState(true);
      this.view.update({ status: "error", error: message });
      await this.reveal();
      return;
    }

    this.generation += 1;
    this.chunks = [];
    this.previewOffset = 0;
    this.previewText = "";
    this.startedAt = Date.now();
    this.view.update({ status: "recording", transcript: "", elapsedMs: 0, level: 0, error: undefined });

    try {
      const device = vscode.workspace.getConfiguration("codexVoice").get<string>("audioInput", "default");
      this.recorder.start(device);
      await vscode.commands.executeCommand("setContext", "codexVoice.recording", true);
      await this.reveal();
      this.startTimers();
    } catch (error) {
      await this.fail(error);
    }
  }

  public async stop(): Promise<void> {
    if (!this.recorder.isRecording) {
      return;
    }

    const generation = ++this.generation;
    this.transcribing = true;
    this.stopTimers();
    this.transcriber.cancelAll();
    this.view.update({ status: "transcribing", level: 0, error: undefined });

    try {
      await this.recorder.stop();
      await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
      const audio = Buffer.concat(this.chunks);
      const transcript = await this.transcriber.transcribe(audio);
      if (generation !== this.generation) {
        return;
      }
      this.previewText = transcript;
      this.view.update({ status: "ready", transcript, elapsedMs: 0, error: undefined });
      if (transcript) {
        await vscode.env.clipboard.writeText(transcript);
        void vscode.window.setStatusBarMessage("Codex Voice: transcript copied", 3_000);
      }
    } catch (error) {
      if (generation === this.generation) {
        await this.fail(error);
      }
    } finally {
      this.transcribing = false;
    }
  }

  public async cancel(): Promise<void> {
    this.generation += 1;
    this.transcribing = false;
    this.stopTimers();
    this.transcriber.cancelAll();
    await this.recorder.cancel();
    this.chunks = [];
    this.previewOffset = 0;
    this.previewText = "";
    await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
    this.view.update({ status: "ready", transcript: "", elapsedMs: 0, level: 0, error: undefined });
  }

  public async copy(): Promise<void> {
    if (!this.view.transcript) {
      return;
    }
    await vscode.env.clipboard.writeText(this.view.transcript);
    void vscode.window.setStatusBarMessage("Codex Voice: transcript copied", 2_000);
  }

  public clear(): void {
    if (!this.recorder.isRecording) {
      this.previewText = "";
      this.view.update({ transcript: "", error: undefined, status: "ready" });
    }
  }

  public updateTranscript(text: string): void {
    if (this.recorder.isRecording || this.transcribing) return;
    this.previewText = text;
    this.view.update({ transcript: text });
  }

  private async openModelManager(): Promise<void> {
    await this.refreshSetupState(true);
    this.view.update({ manageModels: true, setupError: undefined });
  }

  private async switchModel(modelId: string): Promise<void> {
    if (this.recorder.isRecording || this.transcribing || this.modelDownloadRunning) return;
    try {
      const modelPath = await this.modelManager.select(modelId);
      await vscode.workspace
        .getConfiguration("codexVoice")
        .update("modelPath", modelPath, vscode.ConfigurationTarget.Global);
      await this.refreshSetupState();
    } catch (error) {
      this.view.update({ setupError: messageFrom(error) });
    }
  }

  private async removeModel(modelId: string): Promise<void> {
    if (this.modelDownloadRunning) return;
    const model = WHISPER_MODELS.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const activePath = vscode.workspace.getConfiguration("codexVoice").get<string>("modelPath", "");
    const installedModels = await this.modelManager.list(activePath);
    if (installedModels.find((candidate) => candidate.id === modelId)?.active) {
      this.view.update({ setupError: "Switch to another model before removing the active model." });
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Remove ${model.name} from this machine?`,
      { modal: true },
      "Remove",
    );
    if (answer !== "Remove") return;
    try {
      await this.modelManager.remove(modelId);
      await this.refreshSetupState();
    } catch (error) {
      this.view.update({ setupError: messageFrom(error) });
    }
  }

  public dispose(): void {
    this.generation += 1;
    this.transcribing = false;
    this.stopTimers();
    this.recorder.dispose();
    this.transcriber.dispose();
    this.modelManager.dispose();
    this.runtimeManager.dispose();
    this.modelWatcher?.close();
  }

  private async downloadModel(modelId: string): Promise<void> {
    if (this.modelDownloadRunning) return;
    this.modelDownloadRunning = true;
    const generation = ++this.modelDownloadGeneration;
    let lastProgressUpdate = 0;
    this.view.update({
      setupRequired: true,
      downloadingModelId: modelId,
      downloadProgress: 0,
      setupError: undefined,
    });

    try {
      const modelPath = await this.modelManager.download(modelId, (downloaded, total) => {
        const now = Date.now();
        if (now - lastProgressUpdate >= 100 || downloaded === total) {
          lastProgressUpdate = now;
          this.view.update({ downloadProgress: downloaded / total });
        }
      });
      if (generation !== this.modelDownloadGeneration) return;
      await vscode.workspace
        .getConfiguration("codexVoice")
        .update("modelPath", modelPath, vscode.ConfigurationTarget.Global);
      this.view.update({
        downloadingModelId: undefined,
        downloadProgress: undefined,
        setupError: undefined,
        status: "ready",
      });
      await this.refreshSetupState();
      void vscode.window.showInformationMessage("Codex Voice model is ready.");
    } catch (error) {
      if (generation === this.modelDownloadGeneration) {
        this.view.update({
          downloadingModelId: undefined,
          downloadProgress: undefined,
          setupError: messageFrom(error),
        });
      }
    } finally {
      if (generation === this.modelDownloadGeneration) this.modelDownloadRunning = false;
    }
  }

  private cancelModelDownload(): void {
    this.modelDownloadGeneration += 1;
    this.modelDownloadRunning = false;
    this.modelManager.cancel();
    this.runtimeManager.cancel();
    this.view.update({
      downloadingModelId: undefined,
      downloadProgress: undefined,
      setupError: undefined,
      installingRuntime: false,
      runtimeProgress: undefined,
    });
  }

  private async installRuntime(): Promise<void> {
    if (this.modelDownloadRunning || !this.runtimeManager.supportsAutomaticInstall) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:sobansheikh.codex-voice");
      return;
    }
    this.modelDownloadRunning = true;
    const generation = ++this.modelDownloadGeneration;
    let lastProgressUpdate = 0;
    this.view.update({ installingRuntime: true, runtimeProgress: 0, setupError: undefined });
    try {
      const binaryPath = await this.runtimeManager.install((downloaded, total) => {
        const now = Date.now();
        if (now - lastProgressUpdate >= 100 || downloaded === total) {
          lastProgressUpdate = now;
          this.view.update({ runtimeProgress: downloaded / total });
        }
      });
      if (generation !== this.modelDownloadGeneration) return;
      await vscode.workspace
        .getConfiguration("codexVoice")
        .update("whisperBinaryPath", binaryPath, vscode.ConfigurationTarget.Global);
      this.view.update({ installingRuntime: false, runtimeProgress: undefined, setupError: undefined });
      await this.refreshSetupState();
      void vscode.window.showInformationMessage("Codex Voice runtime is ready.");
    } catch (error) {
      if (generation === this.modelDownloadGeneration) {
        this.view.update({ installingRuntime: false, runtimeProgress: undefined, setupError: messageFrom(error) });
      }
    } finally {
      if (generation === this.modelDownloadGeneration) this.modelDownloadRunning = false;
    }
  }

  private async refreshSetupState(reportMissing = false): Promise<void> {
    const modelPath = vscode.workspace.getConfiguration("codexVoice").get<string>("modelPath", "").trim();
    const modelAvailable = modelPath ? await fileExists(modelPath) : false;
    const runtimeRequired = !(await this.transcriber.isBinaryAvailable());
    const models = await this.modelManager.list(modelPath);
    this.watchModel(modelPath);
    this.view.update({
      setupRequired: !modelAvailable || runtimeRequired,
      modelRequired: !modelAvailable,
      runtimeRequired,
      runtimeInstallSupported: this.runtimeManager.supportsAutomaticInstall,
      models,
      ...(reportMissing && modelPath && !modelAvailable
        ? { setupError: "The active model file is missing. Download it again or select another installed model." }
        : {}),
    });
  }

  private watchModel(modelPath: string): void {
    if (modelPath === this.watchedModelPath) return;
    this.modelWatcher?.close();
    this.modelWatcher = undefined;
    this.watchedModelPath = modelPath;
    if (!modelPath) return;

    try {
      const expectedName = path.basename(modelPath);
      this.modelWatcher = watch(path.dirname(modelPath), { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === expectedName) {
          void this.refreshSetupState(true);
        }
      });
      this.modelWatcher.on("error", () => {
        this.modelWatcher?.close();
        this.modelWatcher = undefined;
      });
    } catch {
      // Pre-recording validation remains the fallback if the directory cannot be watched.
    }
  }

  private onAudio(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.view.update({ level: audioLevel(chunk) });

    if (Date.now() - this.startedAt >= MAX_RECORDING_MS) {
      void this.stop();
    }
  }

  private startTimers(): void {
    const interval = vscode.workspace.getConfiguration("codexVoice").get<number>("previewIntervalMs", 3_500);
    this.previewTimer = setInterval(() => void this.updatePreview(), interval);
    this.clockTimer = setInterval(() => {
      this.view.update({ elapsedMs: Date.now() - this.startedAt });
    }, 250);
  }

  private stopTimers(): void {
    if (this.previewTimer) clearInterval(this.previewTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.previewTimer = undefined;
    this.clockTimer = undefined;
  }

  private async updatePreview(): Promise<void> {
    if (this.previewRunning || !this.recorder.isRecording) {
      return;
    }

    const audio = Buffer.concat(this.chunks);
    if (audio.length - this.previewOffset < MIN_PREVIEW_BYTES) {
      return;
    }

    const generation = this.generation;
    const end = audio.length;
    const segment = audio.subarray(this.previewOffset, end);
    this.previewRunning = true;
    try {
      const text = await this.transcriber.transcribe(segment);
      if (generation !== this.generation || !this.recorder.isRecording) {
        return;
      }
      this.previewOffset = end;
      if (text) {
        this.previewText = [this.previewText, text].filter(Boolean).join(" ");
        this.view.update({ transcript: this.previewText });
      }
    } catch (error) {
      if (generation === this.generation && this.recorder.isRecording) {
        this.view.update({ error: `Live preview paused: ${messageFrom(error)}` });
      }
    } finally {
      this.previewRunning = false;
    }
  }

  private async fail(error: unknown): Promise<void> {
    this.generation += 1;
    this.stopTimers();
    this.transcriber.cancelAll();
    await this.recorder.cancel();
    await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
    this.view.update({ status: "error", level: 0, error: messageFrom(error) });
    await this.reveal();
  }

  private async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.codexVoicePanel");
    await vscode.commands.executeCommand(`${TranscriptViewProvider.viewType}.focus`);
  }
}

function audioLevel(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += BYTES_PER_SAMPLE) {
    const sample = chunk.readInt16LE(offset) / 32_768;
    sumSquares += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSquares / samples) * 4);
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileExists(filePath: string): Promise<boolean> {
  return new Promise((resolve) => access(filePath, (error) => resolve(!error)));
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new VoiceController(context);
  context.subscriptions.push(controller, ...controller.register());
}

export function deactivate(): void {}
