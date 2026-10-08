export type SessionPhase =
  | "setup"
  | "ready"
  | "starting"
  | "recording"
  | "stopping"
  | "transcribing"
  | "cancelling"
  | "error";

const TRANSITIONS: Record<SessionPhase, readonly SessionPhase[]> = {
  setup: ["ready", "error"],
  ready: ["setup", "starting", "error"],
  starting: ["recording", "cancelling", "error"],
  recording: ["stopping", "cancelling", "error"],
  stopping: ["transcribing", "cancelling", "error"],
  transcribing: ["ready", "cancelling", "error"],
  cancelling: ["ready", "setup", "error"],
  error: ["setup", "ready", "starting", "cancelling"],
};

const BUSY_PHASES = new Set<SessionPhase>([
  "starting",
  "recording",
  "stopping",
  "transcribing",
  "cancelling",
]);

export class SessionState {
  private currentPhase: SessionPhase = "setup";

  public get phase(): SessionPhase {
    return this.currentPhase;
  }

  public get isBusy(): boolean {
    return BUSY_PHASES.has(this.currentPhase);
  }

  public get canStart(): boolean {
    return this.currentPhase === "ready" || this.currentPhase === "error";
  }

  public get canStop(): boolean {
    return this.currentPhase === "recording";
  }

  public get canCancel(): boolean {
    return this.isBusy && this.currentPhase !== "cancelling";
  }

  public is(phase: SessionPhase): boolean {
    return this.currentPhase === phase;
  }

  public transition(next: SessionPhase): void {
    if (next === this.currentPhase) return;
    if (!TRANSITIONS[this.currentPhase].includes(next)) {
      throw new Error(`Invalid Codex Voice transition: ${this.currentPhase} -> ${next}`);
    }
    this.currentPhase = next;
  }
}
