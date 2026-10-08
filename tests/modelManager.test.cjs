const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, rm, truncate, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ModelManager, WHISPER_MODELS } = require("../out/modelManager");

async function withManager(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-voice-model-test-"));
  const manager = new ModelManager({ fsPath: root });
  try {
    await run(manager, root);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("lists complete models and marks the active model", async () => {
  await withManager(async (manager, root) => {
    const model = WHISPER_MODELS[0];
    const modelPath = path.join(root, `ggml-${model.id}.bin`);
    await writeFile(modelPath, "");
    await truncate(modelPath, model.bytes);
    const models = await manager.list(modelPath);
    assert.equal(models[0].installed, true);
    assert.equal(models[0].active, true);
    assert.equal(models[1].installed, false);
  });
});

test("rejects incomplete and unknown model selections", async () => {
  await withManager(async (manager, root) => {
    const model = WHISPER_MODELS[0];
    const modelPath = path.join(root, `ggml-${model.id}.bin`);
    await writeFile(modelPath, "");
    await truncate(modelPath, 1);
    await assert.rejects(manager.select(model.id), /not completely installed/);
    await assert.rejects(manager.select("missing"), /Unknown Whisper model/);
  });
});

test("selects and removes a complete model", async () => {
  await withManager(async (manager, root) => {
    const model = WHISPER_MODELS[0];
    const modelPath = path.join(root, `ggml-${model.id}.bin`);
    await writeFile(modelPath, "");
    await truncate(modelPath, model.bytes);
    assert.equal(await manager.select(model.id), modelPath);
    await manager.remove(model.id);
    assert.equal((await manager.list(modelPath))[0].installed, false);
  });
});
