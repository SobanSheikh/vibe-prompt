# Codex Voice

Local speech-to-text for Codex in VS Code. Codex Voice records from the local microphone, shows rolling transcript previews in a bottom panel, and copies the final transcript to the clipboard when recording stops.

## Supported Platforms

The production target is **VS Code Desktop on Windows and Linux**:

| Local VS Code host | Support |
| --- | --- |
| Linux x64 | Supported |
| Linux ARM64 | Supported |
| Windows x64 | Supported |
| Windows ARM64 | Supported |
| macOS | Not yet supported |
| VS Code Web (`vscode.dev`, `github.dev`) | Not supported |

Codex Voice is a local UI extension. Microphone capture and transcription run on the machine hosting the VS Code interface, including when the workspace is opened through WSL, Remote SSH, or a Dev Container. The local VS Code host, not the remote workspace, determines which runtime package and audio capture implementation are used.

## Requirements

- VS Code 1.90 or newer
- FFmpeg available on `PATH`
- Linux or Windows on x64 or ARM64

Audio and transcription stay on the local machine. The extension does not read workspace files or send audio to an external service.

## Setup

1. Install FFmpeg. Codex Voice verifies the executable and required audio backend during setup. If FFmpeg is not on `PATH`, configure `Codex Voice: FFmpeg Path`.
2. Open the **Codex Voice** panel and install the local whisper.cpp runtime.
3. Choose Tiny English, Base English, or Small English. The extension downloads the model to its private storage, verifies its size and SHA-256, and configures it automatically.

Base English is the recommended default. Model Path remains available in advanced settings for an existing or custom whisper.cpp model.

On Ubuntu, the default audio input uses PulseAudio/PipeWire through FFmpeg's `default` input. Change `Codex Voice: Audio Input` if the microphone has a different source name.

On Windows, `default` discovers DirectShow microphones and initially uses the first available input. Use the microphone button in the transcript toolbar or run **Codex Voice: Select Microphone** to choose a different device.

## Use

Open the **Codex Voice** panel from the bottom panel area and select **Start**. Partial transcript text appears while recording. Select **Stop** to run a final transcription and copy it to the clipboard, then paste it into the Codex composer.

The panel reports each session phase explicitly (starting, recording, stopping, transcribing, or cancelling) and ignores conflicting actions while a transition is in progress. Live text is provisional and may revise itself as more speech provides context. To keep local CPU use bounded, live preview pauses after one minute; stopping always transcribes the complete recording.

The completed transcript remains editable in the panel. **Copy** always uses the latest edited text.

Use the model selector in the transcript toolbar to switch between installed models. Open **Models** to download another model or remove an installed model that is not currently active.

If an active model is removed outside VS Code, the panel detects it, reports the missing file, and returns to model setup without starting a recording.

The default start/stop shortcut is `Ctrl+Alt+Space`. Press `Escape` while recording to cancel.

Direct insertion into the Codex composer is not used because the current Codex VS Code extension does not expose a supported composer insertion API.

## Development

```bash
npm install
npm run check
npm run compile
npm test
npm run package
npm run package:linux-x64
npm run package:linux-arm64
npm run package:win32-x64
npm run package:win32-arm64
```

The platform-targeted commands produce Marketplace-compatible VSIX packages for the supported desktop architectures.
