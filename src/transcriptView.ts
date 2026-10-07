import * as vscode from "vscode";
import { WhisperModelState } from "./modelManager";

export type VoiceStatus = "ready" | "recording" | "transcribing" | "error";

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
}

export class TranscriptViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codexVoice.transcript";

  private view: vscode.WebviewView | undefined;
  private state: TranscriptState = {
    status: "ready",
    transcript: "",
    elapsedMs: 0,
    level: 0,
    setupRequired: true,
    modelRequired: true,
    runtimeRequired: true,
    runtimeInstallSupported: false,
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
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-panel-background); font-family: var(--vscode-font-family); }
    .toolbar { min-height: 34px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .status { display: flex; align-items: center; gap: 8px; min-width: 150px; margin-right: auto; color: var(--vscode-descriptionForeground); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .recording .dot { background: var(--vscode-testing-iconFailed); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconFailed) 20%, transparent); }
    .meter { width: 52px; height: 4px; overflow: hidden; background: var(--vscode-progressBar-background); opacity: .35; }
    .meter > span { display: block; height: 100%; width: 0; background: var(--vscode-progressBar-background); transition: width 80ms linear; }
    button { height: 30px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 0 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .transcript { width: 100%; min-height: 110px; max-height: 34vh; margin-top: 10px; padding: 10px 12px; resize: vertical; overflow: auto; line-height: 1.55; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
    .transcript:focus { border-color: var(--vscode-focusBorder); }
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
    .setup-header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .setup-header h2 { margin: 0; }
    .setup-header button { margin-left: auto; }
    .model-picker { height: 30px; max-width: 170px; border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); padding: 0 7px; }
  </style>
</head>
<body>
  <section id="setup" class="setup">
    <div class="setup-header"><h2 id="setupTitle">Set up local transcription</h2><button id="closeModelManager">Done</button></div>
    <p id="setupCopy" class="setup-copy">Install the local runtime and choose a Whisper model. Downloads are verified before use.</p>
    <div id="runtimeSetup" class="model">
      <div class="model-head"><span>Whisper runtime</span><span>10 MB</span></div>
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
  <div class="toolbar">
    <div class="status" id="status"><span class="dot"></span><span id="statusText">Ready</span><span id="time"></span><span class="meter"><span id="level"></span></span></div>
    <select id="modelPicker" class="model-picker" title="Active transcription model"></select>
    <button id="openModelManager" title="Download or remove models">Models</button>
    <button id="start" class="primary" title="Start recording"><svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>Start</button>
    <button id="stop" title="Stop and transcribe"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>Stop</button>
    <button id="cancel" title="Cancel recording"><svg viewBox="0 0 24 24"><path d="m18 6-12 12M6 6l12 12"/></svg>Cancel</button>
    <button id="copy" title="Copy transcript"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button>
    <button id="clear" title="Clear transcript"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>Clear</button>
  </div>
  <textarea id="transcript" class="transcript" placeholder="Transcript appears here." spellcheck="true"></textarea>
  <div id="error" class="error" hidden></div>
  <button id="settings" class="settings" hidden>Open settings</button>
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
    document.getElementById('closeModelManager').addEventListener('click', () => send('closeModelManager'));
    document.getElementById('modelPicker').addEventListener('change', event => {
      vscode.postMessage({ action: 'switchModel', modelId: event.target.value });
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
      const busy = recording || state.status === 'transcribing';
      const setup = document.getElementById('setup');
      const setupVisible = state.setupRequired || state.manageModels;
      setup.classList.toggle('visible', setupVisible);
      document.getElementById('workspace').hidden = setupVisible;
      document.getElementById('modelSetup').hidden = !(state.modelRequired || state.manageModels);
      document.getElementById('runtimeSetup').hidden = !state.runtimeRequired;
      document.getElementById('closeModelManager').hidden = state.setupRequired || !state.manageModels;
      document.getElementById('setupTitle').textContent = state.manageModels && !state.setupRequired ? 'Manage models' : 'Set up local transcription';
      document.getElementById('setupCopy').textContent = state.manageModels && !state.setupRequired ? 'Download, activate, or remove local transcription models.' : 'Install the local runtime and choose a Whisper model. Downloads are verified before use.';
      const installRuntime = document.getElementById('installRuntime');
      installRuntime.disabled = state.installingRuntime || Boolean(state.downloadingModelId);
      installRuntime.textContent = state.installingRuntime ? 'Installing...' : state.runtimeInstallSupported ? 'Install runtime' : 'Use advanced settings';
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
      const modelPicker = document.getElementById('modelPicker');
      const modelOptions = installedModels.map(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        option.selected = model.active;
        return option;
      });
      if (!state.modelRequired && !installedModels.some(model => model.active)) {
        const custom = document.createElement('option');
        custom.value = '';
        custom.textContent = 'Custom model';
        custom.selected = true;
        custom.disabled = true;
        modelOptions.unshift(custom);
      }
      modelPicker.replaceChildren(...modelOptions);
      modelPicker.disabled = busy || installedModels.length < 2;
      const download = document.getElementById('download');
      download.classList.toggle('visible', Boolean(state.downloadingModelId));
      const percent = Math.round((state.downloadProgress || 0) * 100);
      document.getElementById('progress').value = percent;
      document.getElementById('progressText').textContent = percent + '%';
      const setupError = document.getElementById('setupError');
      setupError.textContent = state.setupError || '';
      setupError.hidden = !state.setupError;
      const labels = { ready: 'Ready', recording: 'Recording', transcribing: 'Transcribing', error: 'Needs attention' };
      document.getElementById('status').className = 'status ' + state.status;
      document.getElementById('statusText').textContent = labels[state.status];
      document.getElementById('time').textContent = recording ? formatTime(state.elapsedMs) : '';
      document.getElementById('level').style.width = Math.round((state.level || 0) * 100) + '%';
      document.getElementById('start').disabled = busy;
      document.getElementById('stop').disabled = !recording;
      document.getElementById('cancel').disabled = !busy;
      document.getElementById('copy').disabled = !state.transcript;
      document.getElementById('clear').disabled = busy || !state.transcript;
      const transcript = document.getElementById('transcript');
      transcript.readOnly = busy;
      if (transcript.value !== state.transcript) transcript.value = state.transcript;
      const error = document.getElementById('error');
      error.textContent = state.error || '';
      error.hidden = !state.error;
      document.getElementById('settings').hidden = !state.error;
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
