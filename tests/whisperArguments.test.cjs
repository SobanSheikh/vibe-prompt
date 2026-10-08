const assert = require("node:assert/strict");
const test = require("node:test");
const { buildWhisperArguments } = require("../out/whisperArguments");

test("builds deterministic whisper.cpp arguments", () => {
  assert.deepEqual(buildWhisperArguments("model.bin", "speech.wav", "en"), [
    "-m", "model.bin",
    "-f", "speech.wav",
    "-l", "en",
    "--no-timestamps",
    "-np",
  ]);
});
