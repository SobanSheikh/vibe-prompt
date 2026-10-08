const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAudioArguments, parseMacAudioInputs, parseWindowsAudioInputs } = require("../out/audioRecorder");

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

test("builds macOS AVFoundation capture arguments", () => {
  const args = buildAudioArguments("darwin", ":2");
  assert.deepEqual(args.slice(0, 4), ["-f", "avfoundation", "-i", ":2"]);
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

test("parses only macOS AVFoundation audio devices", () => {
  const output = [
    "AVFoundation video devices:",
    "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera",
    "AVFoundation audio devices:",
    "[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone",
    "[AVFoundation indev @ 0x1] [2] USB Audio Device",
  ].join("\n");
  assert.deepEqual(parseMacAudioInputs(output), [
    { label: "MacBook Pro Microphone", value: ":0" },
    { label: "USB Audio Device", value: ":2" },
  ]);
});
