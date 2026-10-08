const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAudioArguments, parseWindowsAudioInputs } = require("../out/audioRecorder");

test("builds Linux PulseAudio capture arguments", () => {
  const args = buildAudioArguments("linux", "default");
  assert.deepEqual(args.slice(0, 4), ["-f", "pulse", "-i", "default"]);
  assert.deepEqual(args.slice(-3), ["-f", "s16le", "pipe:1"]);
  assert.ok(args.includes("16000"));
});

test("builds Windows DirectShow capture arguments", () => {
  const args = buildAudioArguments("win32", "USB Microphone");
  assert.deepEqual(args.slice(0, 4), ["-f", "dshow", "-i", "audio=USB Microphone"]);
});

test("parses and deduplicates Windows audio devices", () => {
  const output = [
    '[dshow] "USB Microphone" (audio)',
    '[dshow] "Webcam Microphone" (audio)',
    '[dshow] "USB Microphone" (audio)',
    '[dshow] "Integrated Camera" (video)',
  ].join("\n");
  assert.deepEqual(parseWindowsAudioInputs(output), ["USB Microphone", "Webcam Microphone"]);
});
