import * as vscode from "vscode";
import { WhisperModelState } from "./modelManager";
import type { SessionPhase } from "./sessionState";

export type VoiceStatus = SessionPhase;

export interface TranscriptState {
  status: VoiceStatus;
  transcript: string;
  elapsedMs: number;
  level: number;
  error?: string;
  setupRequired: boolean;
  modelRequired: boolean;
  runtimeRequired: boolean;
  runtimeInstallSupported: boolean;
  ffmpegRequired: boolean;
  ffmpegMessage: string;
  models: readonly WhisperModelState[];
  manageModels: boolean;
  downloadingModelId?: string;
  downloadProgress?: number;
  setupError?: string;
  installingRuntime?: boolean;
  runtimeProgress?: number;
}

export interface TranscriptActions {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  cancel(): void | Promise<void>;
  copy(): void | Promise<void>;
  clear(): void | Promise<void>;
  openSettings(): void | Promise<void>;
  downloadModel(modelId: string): void | Promise<void>;
  cancelDownload(): void | Promise<void>;
  installRuntime(): void | Promise<void>;
  updateTranscript(text: string): void | Promise<void>;
  openModelManager(): void | Promise<void>;
  closeModelManager(): void | Promise<void>;
  switchModel(modelId: string): void | Promise<void>;
  removeModel(modelId: string): void | Promise<void>;
  selectAudioInput(): void | Promise<void>;
  checkFfmpeg(): void | Promise<void>;
  openFfmpegHelp(): void | Promise<void>;
}

export class TranscriptViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vibePrompt.transcript";

  private view: vscode.WebviewView | undefined;
  private state: TranscriptState = {
    status: "setup",
    transcript: "",
    elapsedMs: 0,
    level: 0,
    setupRequired: true,
    modelRequired: true,
    runtimeRequired: true,
    runtimeInstallSupported: false,
    ffmpegRequired: true,
    ffmpegMessage: "Checking FFmpeg...",
    models: [],
    manageModels: false,
  };

  constructor(private readonly actions: TranscriptActions) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: { action?: string; modelId?: string; text?: string }) => {
      switch (message.action) {
        case "start": void this.actions.start(); break;
        case "stop": void this.actions.stop(); break;
        case "cancel": void this.actions.cancel(); break;
        case "copy": void this.actions.copy(); break;
        case "clear": void this.actions.clear(); break;
        case "settings": void this.actions.openSettings(); break;
        case "downloadModel": if (message.modelId) void this.actions.downloadModel(message.modelId); break;
        case "cancelDownload": void this.actions.cancelDownload(); break;
        case "installRuntime": void this.actions.installRuntime(); break;
        case "updateTranscript": if (typeof message.text === "string") void this.actions.updateTranscript(message.text); break;
        case "openModelManager": void this.actions.openModelManager(); break;
        case "closeModelManager": void this.actions.closeModelManager(); break;
        case "switchModel": if (message.modelId) void this.actions.switchModel(message.modelId); break;
        case "removeModel": if (message.modelId) void this.actions.removeModel(message.modelId); break;
        case "selectAudioInput": void this.actions.selectAudioInput(); break;
        case "checkFfmpeg": void this.actions.checkFfmpeg(); break;
        case "openFfmpegHelp": void this.actions.openFfmpegHelp(); break;
      }
    });
    this.publish();
  }

  public update(update: Partial<TranscriptState>): void {
    this.state = { ...this.state, ...update };
    this.publish();
  }

  public get transcript(): string {
    return this.state.transcript;
  }

  private publish(): void {
    void this.view?.webview.postMessage({ type: "state", state: this.state });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const platformSetupCopy = process.platform === "darwin"
      ? "Before runtime setup on macOS, run: brew install cmake ffmpeg; xcode-select --install."
      : process.platform === "win32"
        ? "Windows requires an FFmpeg build with DirectShow support. The Whisper runtime and model can be installed below."
        : "Linux requires FFmpeg with PulseAudio support. The Whisper runtime and model can be installed below.";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 8px 12px 10px; color: var(--vscode-foreground); background: var(--vscode-panel-background); font-family: var(--vscode-font-family); }
    #workspace { display: flex; min-height: 188px; flex-direction: column; }
    .draft-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; margin-bottom: 6px; }
    .draft-heading, .draft-actions { display: flex; align-items: center; gap: 8px; }
    .header-status { min-width: auto; padding: 3px 8px; text-transform: uppercase; font-size: 11px; font-weight: 700; }
    .toolbar { display: flex; align-items: center; gap: 6px; min-height: 46px; padding: 7px 8px; flex-wrap: nowrap; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-sideBar-background); }
    .toolbar-group { display: flex; align-items: center; gap: 6px; }
    .toolbar-main { min-width: 0; }
    .toolbar-actions { margin-left: auto; flex: 0 0 auto; }
    .toolbar-divider { width: 1px; height: 22px; flex: 0 0 auto; background: var(--vscode-panel-border); }
    .status { display: flex; align-items: center; gap: 7px; min-width: 118px; padding: 4px 8px; border-radius: 4px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, #f54287 8%, var(--vscode-editor-background)); }
    .dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #f54287; }
    .recording .dot { box-shadow: 0 0 0 3px color-mix(in srgb, #f54287 22%, transparent); }
    .starting .dot, .stopping .dot, .transcribing .dot, .cancelling .dot { animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .meter { width: 48px; height: 3px; overflow: hidden; border-radius: 2px; background: color-mix(in srgb, #f54287 18%, transparent); }
    .meter > span { display: block; height: 100%; width: 0; border-radius: inherit; background: #f54287; transition: width 80ms linear; }
    button { height: 30px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 0 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: #241019; background: #f54287; border-color: #f54287; font-weight: 600; }
    button.primary:hover { background: #ff639d; border-color: #ff639d; }
    button:disabled { opacity: .45; cursor: default; }
    button.icon-button { width: 30px; justify-content: center; padding: 0; }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .transcript { width: 100%; min-height: 118px; max-height: 34vh; margin: 0 0 10px; padding: 11px 13px; resize: vertical; overflow: auto; line-height: 1.55; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
    .transcript:focus { border-color: #f54287; }
    .transcript::placeholder { color: var(--vscode-input-placeholderForeground); }
    .transcript:read-only { cursor: default; }
    .error { margin-top: 8px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .settings { padding: 0; height: auto; border: 0; background: transparent; color: var(--vscode-textLink-foreground); }
    .setup { display: none; }
    .setup.visible { display: block; }
    .setup h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    .setup-copy { margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
    .models { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
    .model { min-height: 92px; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    .model-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-weight: 600; }
    .model p { min-height: 32px; margin: 6px 0 9px; color: var(--vscode-descriptionForeground); }
    .badge { margin-left: 6px; color: var(--vscode-charts-green); font-size: 11px; font-weight: 400; }
    .model button { width: 100%; justify-content: center; }
    .model-actions { display: flex; gap: 6px; }
    .model-actions button { flex: 1; }
    .model-actions .remove { flex: 0 0 auto; width: auto; }
    .download { display: none; margin-top: 12px; }
    .download.visible { display: flex; align-items: center; gap: 10px; }
    progress { width: min(420px, 70%); height: 5px; accent-color: var(--vscode-progressBar-background); }
    .setup-footer { margin-top: 10px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .setup-error { margin-top: 10px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .setup-dependency + .setup-dependency { margin-top: 8px; }
    .dependency-actions { display: flex; gap: 6px; }
    .setup-header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .setup-header h2 { margin: 0; }
    .setup-header button { margin-left: auto; }
    .model-picker { position: relative; flex: 0 0 172px; }
    .model-picker-trigger { width: 100%; justify-content: flex-start; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border); }
    .model-picker-trigger:hover { background: var(--vscode-list-hoverBackground); }
    .model-picker-trigger[aria-expanded="true"] { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .model-picker-trigger .model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-picker-trigger .chevron { margin-left: auto; transition: transform 120ms ease; }
    .model-picker-trigger[aria-expanded="true"] .chevron { transform: rotate(180deg); }
    .model-menu { position: absolute; z-index: 20; top: calc(100% + 4px); right: 0; width: max(240px, 100%); max-width: min(320px, calc(100vw - 24px)); padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); border-radius: 4px; background: var(--vscode-menu-background, var(--vscode-dropdown-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
    .model-menu[hidden] { display: none; }
    .model-option { width: 100%; height: auto; min-height: 42px; display: grid; grid-template-columns: 18px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 8px; padding: 6px 8px; border: 0; text-align: left; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; }
    .model-option:hover, .model-option:focus-visible { outline: none; color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
    .model-option.active { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .model-option .check { grid-row: 1 / 3; align-self: center; visibility: hidden; }
    .model-option.active .check { visibility: visible; }
    .model-option-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .model-option-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .model-option.active .model-option-meta { color: inherit; opacity: .8; }
    @media (max-width: 760px) {
      .toolbar { flex-wrap: wrap; }
      .status { min-width: 0; }
      .toolbar-actions { width: 100%; margin-left: 0; justify-content: flex-end; }
      .model-picker { flex: 1 1 150px; }
    }
    @media (max-width: 480px) {
      body { padding-inline: 8px; }
      .toolbar-group { flex-wrap: wrap; }
      .toolbar-actions { justify-content: flex-end; }
      .button-label.optional { display: none; }
    }
  </style>
</head>
<body>
  <section id="setup" class="setup">
    <div class="setup-header"><h2 id="setupTitle">Set up local transcription</h2><button id="closeModelManager">Done</button></div>
    <p id="setupCopy" class="setup-copy">Complete the local dependencies and choose a Whisper model. Downloads are verified before use.</p>
    <p id="platformSetupCopy" class="setup-copy">${platformSetupCopy}</p>
    <div id="ffmpegSetup" class="model setup-dependency">
      <div class="model-head"><span>FFmpeg</span><span>System dependency</span></div>
      <p id="ffmpegDescription">Checking FFmpeg...</p>
      <div class="dependency-actions"><button id="checkFfmpeg" class="primary">Check again</button><button id="openFfmpegHelp">Installation guide</button></div>
    </div>
    <div id="runtimeSetup" class="model setup-dependency">
      <div class="model-head"><span>Whisper runtime</span><span>Local</span></div>
      <p id="runtimeDescription">Runs speech recognition locally</p>
      <button id="installRuntime" class="primary">Install runtime</button>
      <div id="runtimeDownload" class="download"><progress id="runtimeProgress" max="100" value="0"></progress><span id="runtimeProgressText"></span><button id="cancelRuntimeDownload">Cancel</button></div>
    </div>
    <div id="modelSetup">
      <p class="setup-copy">Choose a transcription model:</p>
      <div id="models" class="models"></div>
    </div>
    <div id="download" class="download"><progress id="progress" max="100" value="0"></progress><span id="progressText"></span><button id="cancelDownload">Cancel</button></div>
    <div id="setupError" class="setup-error" hidden></div>
    <div class="setup-footer">English-only models provide the best size and speed for English dictation. <button id="advancedSettings" class="settings">Advanced settings</button></div>
  </section>
  <div id="workspace">
  <div class="draft-header">
    <div class="draft-heading"><div id="headerStatus" class="status header-status ready"><span class="dot"></span><span id="headerStatusText">Ready</span></div></div>
    <div class="draft-actions">
      <button id="copy" title="Copy transcript"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button>
      <button id="clear" class="icon-button" title="Clear transcript" aria-label="Clear transcript"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg></button>
    </div>
  </div>
  <textarea id="transcript" class="transcript" placeholder="Transcript appears here." spellcheck="true"></textarea>
  <div id="error" class="error" hidden></div>
  <div class="toolbar">
    <div class="toolbar-group toolbar-main">
    <div id="modelPicker" class="model-picker">
      <button id="modelPickerButton" class="model-picker-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" title="Active transcription model">
        <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>
        <span id="modelPickerLabel" class="model-label">Model</span>
        <svg class="chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div id="modelPickerMenu" class="model-menu" role="listbox" aria-label="Transcription model" hidden></div>
    </div>
    <button id="openModelManager" title="Download or remove models">Models</button>
    <button id="selectAudioInput" class="icon-button" title="Select microphone" aria-label="Select microphone"><svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg></button>
    <button id="settings" class="icon-button" title="Open Vibe Prompt settings" aria-label="Open Vibe Prompt settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></svg></button>
    <span class="toolbar-divider"></span>
    <div class="status" id="status"><span class="dot"></span><span id="statusText">Ready</span><span id="time"></span><span class="meter"><span id="level"></span></span></div>
    </div>
    <div class="toolbar-group toolbar-actions">
    <button id="cancel" title="Cancel recording"><svg viewBox="0 0 24 24"><path d="m18 6-12 12M6 6l12 12"/></svg><span class="button-label optional">Cancel</span></button>
    <button id="stop" title="Stop and transcribe"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg><span class="button-label optional">Stop</span></button>
    <button id="start" class="primary" title="Start recording"><svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>Start</button>
    </div>
  </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const send = action => vscode.postMessage({ action });
    for (const action of ['start', 'stop', 'cancel', 'copy', 'clear', 'settings']) {
      document.getElementById(action).addEventListener('click', () => send(action));
    }
    document.getElementById('advancedSettings').addEventListener('click', () => send('settings'));
    document.getElementById('cancelDownload').addEventListener('click', () => send('cancelDownload'));
    document.getElementById('cancelRuntimeDownload').addEventListener('click', () => send('cancelDownload'));
    document.getElementById('installRuntime').addEventListener('click', () => send('installRuntime'));
    document.getElementById('openModelManager').addEventListener('click', () => send('openModelManager'));
    document.getElementById('selectAudioInput').addEventListener('click', () => send('selectAudioInput'));
    document.getElementById('checkFfmpeg').addEventListener('click', () => send('checkFfmpeg'));
    document.getElementById('openFfmpegHelp').addEventListener('click', () => send('openFfmpegHelp'));
    document.getElementById('closeModelManager').addEventListener('click', () => send('closeModelManager'));
    const modelPicker = document.getElementById('modelPicker');
    const modelPickerButton = document.getElementById('modelPickerButton');
    const modelPickerMenu = document.getElementById('modelPickerMenu');
    const closeModelPicker = () => {
      modelPickerMenu.hidden = true;
      modelPickerButton.setAttribute('aria-expanded', 'false');
    };
    const openModelPicker = () => {
      if (modelPickerButton.disabled) return;
      modelPickerMenu.hidden = false;
      modelPickerButton.setAttribute('aria-expanded', 'true');
      (modelPickerMenu.querySelector('.active') || modelPickerMenu.querySelector('.model-option'))?.focus();
    };
    modelPickerButton.addEventListener('click', () => {
      if (modelPickerMenu.hidden) openModelPicker(); else closeModelPicker();
    });
    modelPickerMenu.addEventListener('keydown', event => {
      const options = [...modelPickerMenu.querySelectorAll('.model-option')];
      const current = options.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        options[(current + direction + options.length) % options.length]?.focus();
      } else if (event.key === 'Escape') {
        closeModelPicker();
        modelPickerButton.focus();
      }
    });
    document.addEventListener('click', event => {
      if (!modelPicker.contains(event.target)) closeModelPicker();
    });
    document.getElementById('transcript').addEventListener('input', event => {
      vscode.postMessage({ action: 'updateTranscript', text: event.target.value });
    });
    const formatTime = ms => {
      const seconds = Math.floor(ms / 1000);
      return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    };
    window.addEventListener('message', event => {
      if (event.data.type !== 'state') return;
      const state = event.data.state;
      const recording = state.status === 'recording';
      const busyPhases = ['starting', 'recording', 'stopping', 'transcribing', 'cancelling'];
      const busy = busyPhases.includes(state.status);
      const setup = document.getElementById('setup');
      const setupVisible = state.setupRequired || state.manageModels;
      setup.classList.toggle('visible', setupVisible);
      document.getElementById('workspace').hidden = setupVisible;
      document.getElementById('modelSetup').hidden = !(state.modelRequired || state.manageModels);
      document.getElementById('runtimeSetup').hidden = !state.runtimeRequired;
      document.getElementById('ffmpegSetup').hidden = !state.ffmpegRequired;
      document.getElementById('ffmpegDescription').textContent = state.ffmpegMessage;
      document.getElementById('closeModelManager').hidden = state.setupRequired || !state.manageModels;
      document.getElementById('setupTitle').textContent = state.manageModels && !state.setupRequired ? 'Manage models' : 'Set up local transcription';
      document.getElementById('setupCopy').textContent = state.manageModels && !state.setupRequired ? 'Download, activate, or remove local transcription models.' : 'Complete the local dependencies and choose a Whisper model. Downloads are verified before use.';
      document.getElementById('platformSetupCopy').hidden = state.manageModels && !state.setupRequired;
      const installRuntime = document.getElementById('installRuntime');
      installRuntime.disabled = state.installingRuntime || Boolean(state.downloadingModelId);
      installRuntime.textContent = state.installingRuntime ? 'Installing...' : state.runtimeInstallSupported ? 'Install runtime' : 'Unsupported platform';
      document.getElementById('runtimeDescription').textContent = state.runtimeInstallSupported
        ? 'Runs speech recognition locally; macOS builds current upstream source on this machine'
        : 'Automatic setup is not available for this platform yet';
      const runtimeDownload = document.getElementById('runtimeDownload');
      runtimeDownload.classList.toggle('visible', Boolean(state.installingRuntime));
      const runtimePercent = Math.round((state.runtimeProgress || 0) * 100);
      document.getElementById('runtimeProgress').value = runtimePercent;
      document.getElementById('runtimeProgressText').textContent = runtimePercent + '%';
      const models = document.getElementById('models');
      models.replaceChildren(...state.models.map(model => {
        const item = document.createElement('div');
        item.className = 'model';
        const head = document.createElement('div');
        head.className = 'model-head';
        const title = document.createElement('span');
        title.textContent = model.name;
        if (model.recommended) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'Recommended';
          title.appendChild(badge);
        }
        const size = document.createElement('span');
        size.textContent = model.sizeLabel;
        head.append(title, size);
        const description = document.createElement('p');
        description.textContent = model.description;
        const actions = document.createElement('div');
        actions.className = 'model-actions';
        const button = document.createElement('button');
        button.className = model.recommended && !model.installed ? 'primary' : '';
        button.textContent = state.downloadingModelId === model.id ? 'Downloading...' : model.active ? 'Active' : model.installed ? 'Use model' : 'Download & use';
        button.disabled = model.active || Boolean(state.downloadingModelId) || Boolean(state.installingRuntime);
        button.addEventListener('click', () => vscode.postMessage({ action: model.installed ? 'switchModel' : 'downloadModel', modelId: model.id }));
        actions.appendChild(button);
        if (model.installed && !model.active) {
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.textContent = 'Remove';
          remove.disabled = Boolean(state.downloadingModelId) || Boolean(state.installingRuntime);
          remove.addEventListener('click', () => vscode.postMessage({ action: 'removeModel', modelId: model.id }));
          actions.appendChild(remove);
        }
        item.append(head, description, actions);
        return item;
      }));
      const installedModels = state.models.filter(model => model.installed);
      const activeModel = installedModels.find(model => model.active);
      document.getElementById('modelPickerLabel').textContent = activeModel?.name || (!state.modelRequired ? 'Custom model' : 'No model');
      modelPickerMenu.replaceChildren(...installedModels.map(model => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'model-option' + (model.active ? ' active' : '');
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(model.active));
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('class', 'check');
        check.setAttribute('viewBox', '0 0 24 24');
        const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        checkPath.setAttribute('d', 'm5 12 4 4L19 6');
        check.appendChild(checkPath);
        const name = document.createElement('span');
        name.className = 'model-option-name';
        name.textContent = model.name;
        const meta = document.createElement('span');
        meta.className = 'model-option-meta';
        meta.textContent = model.description + ' · ' + model.sizeLabel;
        option.append(check, name, meta);
        option.addEventListener('click', () => {
          closeModelPicker();
          if (!model.active) vscode.postMessage({ action: 'switchModel', modelId: model.id });
        });
        return option;
      }));
      modelPickerButton.disabled = busy || installedModels.length < 2;
      document.getElementById('openModelManager').disabled = busy;
      document.getElementById('selectAudioInput').disabled = busy;
      if (modelPickerButton.disabled) closeModelPicker();
      const download = document.getElementById('download');
      download.classList.toggle('visible', Boolean(state.downloadingModelId));
      const percent = Math.round((state.downloadProgress || 0) * 100);
      document.getElementById('progress').value = percent;
      document.getElementById('progressText').textContent = percent + '%';
      const setupError = document.getElementById('setupError');
      setupError.textContent = state.setupError || '';
      setupError.hidden = !state.setupError;
      const labels = {
        setup: 'Setup required',
        ready: 'Ready',
        starting: 'Starting',
        recording: 'Recording',
        stopping: 'Stopping',
        transcribing: 'Transcribing',
        cancelling: 'Cancelling',
        error: 'Needs attention'
      };
      document.getElementById('status').className = 'status ' + state.status;
      document.getElementById('statusText').textContent = labels[state.status];
      document.getElementById('headerStatus').className = 'status header-status ' + state.status;
      document.getElementById('headerStatusText').textContent = labels[state.status];
      document.getElementById('time').textContent = recording ? formatTime(state.elapsedMs) : '';
      document.getElementById('level').style.width = Math.round((state.level || 0) * 100) + '%';
      document.getElementById('start').disabled = busy || state.status === 'setup';
      document.getElementById('stop').disabled = !recording;
      document.getElementById('cancel').disabled = !busy || state.status === 'cancelling';
      document.getElementById('copy').disabled = !state.transcript;
      document.getElementById('clear').disabled = busy || !state.transcript;
      const transcript = document.getElementById('transcript');
      transcript.readOnly = busy;
      if (transcript.value !== state.transcript) transcript.value = state.transcript;
      const error = document.getElementById('error');
      error.textContent = state.error || '';
      error.hidden = !state.error;
      if (busy) transcript.scrollTop = transcript.scrollHeight;
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => characters[Math.floor(Math.random() * characters.length)]).join("");
}
