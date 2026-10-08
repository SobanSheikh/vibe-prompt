const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateFfmpeg } = require("../out/ffmpegManager");

test("accepts Linux FFmpeg with a PulseAudio input device", () => {
  const status = evaluateFfmpeg(
    "linux",
    { code: 0, output: "ffmpeg version 7.1 Copyright" },
    { code: 0, output: " D  pulse           Pulse audio input" },
  );
  assert.deepEqual(status, { ready: true, message: "FFmpeg 7.1", version: "7.1" });
});

test("accepts Windows FFmpeg with a DirectShow input device", () => {
  const status = evaluateFfmpeg(
    "win32",
    { code: 0, output: "ffmpeg version 7.1 Copyright" },
    { code: 0, output: " D  dshow           DirectShow capture" },
  );
  assert.equal(status.ready, true);
});

test("accepts macOS FFmpeg with an AVFoundation input device", () => {
  const status = evaluateFfmpeg(
    "darwin",
    { code: 0, output: "ffmpeg version 7.1 Copyright" },
    { code: 0, output: " D  avfoundation    AVFoundation input" },
  );
  assert.equal(status.ready, true);
});

test("reports missing capture backend", () => {
  const status = evaluateFfmpeg(
    "linux",
    { code: 0, output: "ffmpeg version 7.1 Copyright" },
    { code: 0, output: " D  lavfi           virtual input" },
  );
  assert.equal(status.ready, false);
  assert.match(status.message, /does not include the 'pulse'/);
});

test("rejects failed FFmpeg and unsupported operating systems", () => {
  assert.equal(evaluateFfmpeg("linux", { code: 1, output: "" }, { code: 0, output: "" }).ready, false);
  assert.match(
    evaluateFfmpeg("freebsd", { code: 0, output: "ffmpeg version 7.1" }, { code: 0, output: "" }).message,
    /not supported/,
  );
});
