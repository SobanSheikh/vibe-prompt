const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_PREVIEW_BYTES,
  MIN_PREVIEW_BYTES,
  previewAudio,
  shouldApplyPreview,
} = require("../out/previewPolicy");

test("previews the complete accumulated recording", () => {
  const audio = Buffer.alloc(MIN_PREVIEW_BYTES);
  assert.equal(previewAudio(audio), audio);
});

test("requires context and bounds live preview work", () => {
  assert.equal(previewAudio(Buffer.alloc(MIN_PREVIEW_BYTES - 1)), undefined);
  assert.equal(previewAudio(Buffer.alloc(MAX_PREVIEW_BYTES + 1)), undefined);
});

test("rejects stale or cancelled preview results", () => {
  assert.equal(shouldApplyPreview(4, 4, "recording"), true);
  assert.equal(shouldApplyPreview(3, 4, "recording"), false);
  assert.equal(shouldApplyPreview(4, 4, "cancelling"), false);
  assert.equal(shouldApplyPreview(4, 4, "transcribing"), false);
});
