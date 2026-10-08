import { access, watch, FSWatcher } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { AudioRecorder } from "./audioRecorder";
import { FfmpegManager } from "./ffmpegManager";
import { ModelManager, WHISPER_MODELS } from "./modelManager";
import { previewAudio, shouldApplyPreview } from "./previewPolicy";
import { RuntimeManager } from "./runtimeManager";
import { SessionState } from "./sessionState";
import type { SessionPhase } from "./sessionState";
import { TranscriptViewProvider } from "./transcriptView";
import type { TranscriptState } from "./transcriptView";
import { WhisperTranscriber } from "./whisperTranscriber";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const MAX_RECORDING_MS = 10 * 60 * 1_000;

class VoiceController implements vscode.Disposable {
  private readonly view: TranscriptViewProvider;
  private readonly transcriber: WhisperTranscriber;
  private readonly modelManager: ModelManager;
  private readonly runtimeManager: RuntimeManager;
  private readonly recorder: AudioRecorder;
  private readonly ffmpegManager = new FfmpegManager();
  private readonly session = new SessionState();
  private chunks: Buffer[] = [];
  private previewText = "";
  private startedAt = 0;
  private generation = 0;
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
      selectAudioInput: () => this.selectAudioInput(),
      checkFfmpeg: () => this.refreshSetupState(false, true),
      openFfmpegHelp: async () => {
        await vscode.env.openExternal(vscode.Uri.parse("https://ffmpeg.org/download.html"));
      },
    });
    void this.refreshSetupState();
  }

  public register(): vscode.Disposable[] {
    return [
      vscode.window.registerWebviewViewProvider(TranscriptViewProvider.viewType, this.view),
      vscode.commands.registerCommand("codexVoice.toggleRecording", () =>
        this.session.phase === "recording" ? this.stop() : this.session.isBusy ? this.cancel() : this.start(),
      ),
      vscode.commands.registerCommand("codexVoice.startRecording", () => this.start()),
      vscode.commands.registerCommand("codexVoice.stopRecording", () => this.stop()),
      vscode.commands.registerCommand("codexVoice.cancelRecording", () => this.cancel()),
      vscode.commands.registerCommand("codexVoice.copyTranscript", () => this.copy()),
      vscode.commands.registerCommand("codexVoice.clearTranscript", () => this.clear()),
      vscode.commands.registerCommand("codexVoice.openTranscript", () => this.reveal()),
      vscode.commands.registerCommand("codexVoice.selectAudioInput", () => this.selectAudioInput()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("codexVoice.modelPath")
          || event.affectsConfiguration("codexVoice.whisperBinaryPath")
          || event.affectsConfiguration("codexVoice.ffmpegPath")
        ) {
          void this.refreshSetupState(true);
        }
      }),
    ];
  }

  public async start(): Promise<void> {
    if (!this.session.canStart) return;
    const generation = ++this.generation;
    this.setPhase("starting");
    await vscode.commands.executeCommand("setContext", "codexVoice.recording", true);
    if (generation !== this.generation || this.session.phase !== "starting") return;

    const configuration = vscode.workspace.getConfiguration("codexVoice");
    const ffmpegPath = configuration.get<string>("ffmpegPath", "ffmpeg");
    const ffmpegStatus = await this.ffmpegManager.check(ffmpegPath, true);
    if (generation !== this.generation || this.session.phase !== "starting") return;
    if (!ffmpegStatus.ready) {
      await this.refreshSetupState(false, true);
      if (generation !== this.generation || this.session.phase !== "starting") return;
      this.setPhase("error");
      this.view.update({ setupError: ffmpegStatus.message });
      await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
      await this.reveal();
      return;
    }

    try {
      await this.transcriber.validate();
      if (generation !== this.generation || this.session.phase !== "starting") return;
    } catch (error) {
      if (generation !== this.generation || this.session.phase !== "starting") return;
      const message = messageFrom(error);
      await this.refreshSetupState(true);
      if (generation !== this.generation || this.session.phase !== "starting") return;
      this.setPhase("error", { error: message });
      await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
      await this.reveal();
      return;
    }

    this.chunks = [];
    this.previewText = "";
    this.startedAt = Date.now();
    this.view.update({ transcript: "", elapsedMs: 0, level: 0, error: undefined });

    try {
      const device = configuration.get<string>("audioInput", "default");
      await this.recorder.start(device, ffmpegPath);
      if (generation !== this.generation || this.session.phase !== "starting" || !this.recorder.isRecording) return;
      this.setPhase("recording");
      await this.reveal();
      this.startTimers();
    } catch (error) {
      if (generation === this.generation && this.session.phase === "starting") {
        await this.fail(error);
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.session.phase === "starting") {
      await this.cancel();
      return;
    }
    if (!this.session.canStop) return;

    const generation = ++this.generation;
    this.setPhase("stopping");
    this.stopTimers();
    this.transcriber.cancelAll();
    this.view.update({ level: 0, error: undefined });

    try {
      await this.recorder.stop();
      await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
      if (generation !== this.generation || this.session.phase !== "stopping") return;
      this.setPhase("transcribing");
      const audio = Buffer.concat(this.chunks);
      const transcript = await this.transcriber.transcribe(audio);
      if (generation !== this.generation || !this.session.is("transcribing")) return;
      this.previewText = transcript;
      this.setPhase("ready", { transcript, elapsedMs: 0, error: undefined });
      if (transcript) {
        await vscode.env.clipboard.writeText(transcript);
        void vscode.window.setStatusBarMessage("Codex Voice: transcript copied", 3_000);
      }
    } catch (error) {
      if (generation === this.generation && this.session.phase !== "cancelling") {
        await this.fail(error);
      }
    }
  }

  public async cancel(): Promise<void> {
    if (!this.session.canCancel) return;
    this.setPhase("cancelling");
    this.generation += 1;
    this.stopTimers();
    this.transcriber.cancelAll();
    await this.recorder.cancel();
    this.chunks = [];
    this.previewText = "";
    await vscode.commands.executeCommand("setContext", "codexVoice.recording", false);
    this.setPhase("ready", { transcript: "", elapsedMs: 0, level: 0, error: undefined });
  }

  public async copy(): Promise<void> {
    if (!this.view.transcript) {
      return;
    }
    await vscode.env.clipboard.writeText(this.view.transcript);
    void vscode.window.setStatusBarMessage("Codex Voice: transcript copied", 2_000);
  }

  public clear(): void {
    if (!this.session.isBusy) {
      this.previewText = "";
      this.view.update({ transcript: "", error: undefined });
    }
  }

  public updateTranscript(text: string): void {
    if (this.session.isBusy) return;
    this.previewText = text;
    this.view.update({ transcript: text });
  }

  private async selectAudioInput(): Promise<void> {
    if (this.session.isBusy) return;
    try {
      const configuration = vscode.workspace.getConfiguration("codexVoice");
      const ffmpegPath = configuration.get<string>("ffmpegPath", "ffmpeg");
      const ffmpegStatus = await this.ffmpegManager.check(ffmpegPath, true);
      if (!ffmpegStatus.ready) throw new Error(ffmpegStatus.message);
      const devices = await this.recorder.listAudioInputs(ffmpegPath);
      if (devices.length === 0) {
        throw new Error("No microphone was found. Check operating-system microphone permissions and FFmpeg installation.");
      }
      if (process.platform === "linux") {
        void vscode.window.showInformationMessage("Codex Voice uses the system default Linux audio input.");
        return;
      }
      const current = configuration.get<string>("audioInput", "default");
      const ordered = [...devices].sort((left, right) => Number(right.value === current) - Number(left.value === current));
      const selected = await vscode.window.showQuickPick(
        ordered.map((device) => ({ label: device.label, description: device.value, value: device.value })),
        {
        placeHolder: "Select the microphone used by Codex Voice",
        title: "Codex Voice: Audio Input",
        },
      );
      if (!selected) return;
      await vscode.workspace
        .getConfiguration("codexVoice")
        .update("audioInput", selected.value, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Codex Voice will use: ${selected.label}`);
    } catch (error) {
      void vscode.window.showErrorMessage(messageFrom(error));
    }
  }

  private async openModelManager(): Promise<void> {
    await this.refreshSetupState(true);
    this.view.update({ manageModels: true, setupError: undefined });
  }

  private async switchModel(modelId: string): Promise<void> {
    if (this.session.isBusy || this.modelDownloadRunning) return;
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

  private async refreshSetupState(reportMissing = false, forceFfmpeg = false): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("codexVoice");
    const modelPath = configuration.get<string>("modelPath", "").trim();
    const ffmpegPath = configuration.get<string>("ffmpegPath", "ffmpeg");
    const modelAvailable = modelPath ? await fileExists(modelPath) : false;
    const ffmpegStatus = await this.ffmpegManager.check(ffmpegPath, forceFfmpeg);
    const runtimeRequired = !(await this.transcriber.isBinaryAvailable());
    const models = await this.modelManager.list(modelPath);
    this.watchModel(modelPath);
    const setupRequired = !modelAvailable || runtimeRequired || !ffmpegStatus.ready;
    if (!this.session.isBusy) {
      const nextPhase: SessionPhase = setupRequired ? "setup" : "ready";
      if (this.session.phase !== nextPhase) this.session.transition(nextPhase);
    }
    this.view.update({
      status: this.session.phase,
      setupRequired,
      modelRequired: !modelAvailable,
      ffmpegRequired: !ffmpegStatus.ready,
      ffmpegMessage: ffmpegStatus.message,
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
    if (!["starting", "recording", "stopping"].includes(this.session.phase)) return;
    this.chunks.push(chunk);
    if (this.session.phase !== "recording") return;
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
    if (this.previewRunning || this.session.phase !== "recording") {
      return;
    }

    const audio = previewAudio(Buffer.concat(this.chunks));
    if (!audio) return;

    const generation = this.generation;
    this.previewRunning = true;
    try {
      const text = await this.transcriber.transcribe(audio);
      if (!shouldApplyPreview(generation, this.generation, this.session.phase)) {
        return;
      }
      this.previewText = text;
      this.view.update({ transcript: text });
    } catch (error) {
      if (shouldApplyPreview(generation, this.generation, this.session.phase)) {
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
    this.setPhase("error", { level: 0, error: messageFrom(error) });
    await this.reveal();
  }

  private setPhase(
    phase: SessionPhase,
    update: Partial<Omit<TranscriptState, "status">> = {},
  ): void {
    this.session.transition(phase);
    this.view.update({ ...update, status: phase });
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
