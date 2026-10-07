# Codex Voice

Local speech-to-text for Codex in VS Code. Codex Voice records from the local microphone, shows rolling transcript previews in a bottom panel, and copies the final transcript to the clipboard when recording stops.

## Requirements

- VS Code 1.90 or newer
- FFmpeg available on `PATH`
- Linux x64 or ARM64 for automatic runtime installation, or an existing [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli` executable

Audio and transcription stay on the local machine. The extension does not read workspace files or send audio to an external service.

## Setup

1. Install FFmpeg.
2. Open the **Codex Voice** panel and install the local whisper.cpp runtime. Automatic runtime installation currently supports Linux x64 and ARM64.
3. Choose Tiny English, Base English, or Small English. The extension downloads the model to its private storage, verifies its size and SHA-256, and configures it automatically.
4. On unsupported platforms, install whisper.cpp separately and set `Codex Voice: Whisper Binary Path` to its absolute path.

Base English is the recommended default. Model Path remains available in advanced settings for an existing or custom whisper.cpp model.

On Ubuntu, the default audio input uses PulseAudio/PipeWire through FFmpeg's `default` input. Change `Codex Voice: Audio Input` if the microphone has a different source name.

## Use

Open the **Codex Voice** panel from the bottom panel area and select **Start**. Partial transcript text appears while recording. Select **Stop** to run a final transcription and copy it to the clipboard, then paste it into the Codex composer.

The completed transcript remains editable in the panel. **Copy** always uses the latest edited text.

Use the model selector in the transcript toolbar to switch between installed models. Open **Models** to download another model or remove an installed model that is not currently active.

If an active model is removed outside VS Code, the panel detects it, reports the missing file, and returns to model setup without starting a recording.

The default start/stop shortcut is `Ctrl+Alt+Space` (`Cmd+Alt+Space` on macOS). Press `Escape` while recording to cancel.

Direct insertion into the Codex composer is not used because the current Codex VS Code extension does not expose a supported composer insertion API.

## Development

```bash
npm install
npm run check
npm run compile
npm run package
```
