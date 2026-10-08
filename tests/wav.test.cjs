const assert = require("node:assert/strict");
const test = require("node:test");
const { encodePcm16Wav } = require("../out/wav");

test("encodes mono PCM16 with a valid WAV header", () => {
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const wav = encodePcm16Wav(pcm, 16_000);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});
