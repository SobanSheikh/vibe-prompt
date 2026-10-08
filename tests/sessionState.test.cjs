const assert = require("node:assert/strict");
const test = require("node:test");
const { SessionState } = require("../out/sessionState");

test("supports the complete recording lifecycle", () => {
  const session = new SessionState();
  for (const phase of ["ready", "starting", "recording", "stopping", "transcribing", "ready"]) {
    session.transition(phase);
  }

  assert.equal(session.phase, "ready");
  assert.equal(session.isBusy, false);
  assert.equal(session.canStart, true);
});

test("supports cancellation from every active phase", () => {
  for (const activePhase of ["starting", "recording", "stopping", "transcribing"]) {
    const session = new SessionState();
    session.transition("ready");
    session.transition("starting");
    if (activePhase !== "starting") session.transition("recording");
    if (["stopping", "transcribing"].includes(activePhase)) session.transition("stopping");
    if (activePhase === "transcribing") session.transition("transcribing");

    assert.equal(session.canCancel, true);
    session.transition("cancelling");
    session.transition("ready");
    assert.equal(session.phase, "ready");
  }
});

test("rejects invalid transitions", () => {
  const session = new SessionState();
  assert.throws(
    () => session.transition("recording"),
    /Invalid Codex Voice transition: setup -> recording/,
  );
});
