const assert = require("node:assert/strict");
const test = require("node:test");
const { runtimeArchiveDownloadName, runtimeInstallMethod } = require("../out/runtimeManager");

test("uses source builds for both macOS architectures", () => {
  assert.equal(runtimeInstallMethod("darwin", "arm64"), "source");
  assert.equal(runtimeInstallMethod("darwin", "x64"), "source");
});

test("keeps verified archives for supported Linux and Windows targets", () => {
  assert.equal(runtimeInstallMethod("linux", "x64"), "archive");
  assert.equal(runtimeInstallMethod("linux", "arm64"), "archive");
  assert.equal(runtimeInstallMethod("win32", "x64"), "archive");
  assert.equal(runtimeInstallMethod("win32", "arm64"), "archive");
  assert.equal(runtimeInstallMethod("freebsd", "x64"), "unsupported");
});

test("keeps the archive extension on partial runtime downloads", () => {
  assert.equal(
    runtimeArchiveDownloadName({ archiveName: "whisper-bin-x64.zip", archiveType: "zip" }),
    "whisper-bin-x64.zip.download.zip",
  );
  assert.equal(
    runtimeArchiveDownloadName({ archiveName: "whisper-bin-ubuntu-x64.tar.gz", archiveType: "tar.gz" }),
    "whisper-bin-ubuntu-x64.tar.gz.download.tar.gz",
  );
});
