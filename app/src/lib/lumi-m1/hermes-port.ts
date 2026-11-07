/**
 * Hermes boundary adapters.
 *
 * !!! `SimulatedHermes` IS A FAKE. It does not talk to Hermes or Telegram. It exists so the app, the worker and the UI can be
 * exercised end to end before the integration spike (TDD 16 U1–U4, U16) is possible. Anything it produces is labelled
 * "[MÔ PHỎNG]" and must never be presented as integration evidence. A real adapter replaces it only after the spike.
 */
import type { HermesPort } from "./core";

export interface SimulatedBehaviour {
  /** What dispatch() reports. Default "accepted". */
  dispatch?: "accepted" | "transient_error" | "permanent_error" | "uncertain" | "throw";
  /** Profile tools the simulated profile exposes. Default: the minimal M1 set. */
  tools?: string[] | null;
}

export const M1_MINIMAL_TOOLS = ["tasks.intake", "outputs.submit", "knowledge.context"];

export class SimulatedHermes implements HermesPort {
  readonly simulated = true as const;
  calls: { runId: string; dispatchKey: string }[] = [];
  constructor(public behaviour: SimulatedBehaviour = {}) {}

  async readProfileTools(_profile: string): Promise<string[] | null> {
    return this.behaviour.tools === undefined ? [...M1_MINIMAL_TOOLS] : this.behaviour.tools;
  }
  async dispatch(run: { runId: string; dispatchKey: string; taskCode: string; instruction: Record<string, unknown> }) {
    this.calls.push({ runId: run.runId, dispatchKey: run.dispatchKey });
    switch (this.behaviour.dispatch ?? "accepted") {
      case "transient_error": return { kind: "rejected" as const, transient: true, message: "[MÔ PHỎNG] lỗi mạng tạm thời" };
      case "permanent_error": return { kind: "rejected" as const, transient: false, message: "[MÔ PHỎNG] từ chối vĩnh viễn" };
      case "uncertain": return { kind: "uncertain" as const, message: "[MÔ PHỎNG] timeout, không biết Hermes đã nhận chưa" };
      case "throw": throw new Error("[MÔ PHỎNG] mất kết nối giữa chừng");
      default: return { kind: "accepted" as const, sessionRef: `sim-${run.runId.slice(0, 8)}` };
    }
  }
}

/** Always-visible label for the UI so nobody mistakes the simulation for the real thing. */
export function hermesModeLabel(h: HermesPort): string {
  return (h as { simulated?: boolean }).simulated ? "ADAPTER GIẢ (mô phỏng) — chưa nối Hermes/Telegram thật" : "Hermes thật";
}
