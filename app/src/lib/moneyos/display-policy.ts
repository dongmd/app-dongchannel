/**
 * P4-R11 — what the AI Money OS surfaces are allowed to say.
 *
 * `P2` shipped eleven live tables with no interface at all. This requirement
 * gives them one. The danger in doing that is not that the pages are hard to
 * build — it is that a presentation layer is the easiest place in a system to
 * invent a fact:
 *
 *   - a missing score rendered as `0` becomes a *low* score;
 *   - a list re-sorted "helpfully" becomes a *ranking the UI invented*;
 *   - an empty table with a placeholder row becomes *data that does not exist*.
 *
 * Each of those is a lie the database never told. So the decisions live here, in
 * a module that imports nothing and can be tested by feeding it values.
 *
 * ## The boundary, in one sentence
 *
 * **This layer reads and renders; it never computes a score, a ranking or an
 * evidence level.** `P2-R03` owns scoring, `P2` owns the models, and `P4-R01`
 * owns agent runs. The same boundary `P3-R02 AC-03` holds for `/contentplan`.
 */

// ─── AC-04: UNKNOWN is not zero, and not a dash ────────────────────
//
// The P2 invariant reaching the presentation layer. A value the system does not
// have must be shown as not had -- never as 0, never as an empty cell that
// reads like a small number, never as a plausible guess.

/** What every surface prints when it has no value. One string, one meaning. */
export const UNKNOWN = "UNKNOWN";

/**
 * Render a value that may be absent.
 *
 * `0` is passed through, because zero is a real answer and this function must
 * not turn a genuine zero into UNKNOWN either. The two directions of that
 * mistake are equally wrong and this is the only place the distinction is made.
 */
export function display(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return UNKNOWN;
    return String(value);
  }
  const trimmed = value.trim();
  return trimmed === "" ? UNKNOWN : trimmed;
}

/** A score, to one decimal. Absent stays absent. */
export function displayScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return UNKNOWN;
  return score.toFixed(1);
}

/**
 * AC-04, the case that matters most.
 *
 * A score of 82 over three known dimensions and a score of 82 over eleven are
 * different facts, and `P2-R03` stored both numbers precisely so the queue could
 * say which. A surface that printed only "82" would be technically accurate and
 * would mislead every time.
 */
export function displayCoverage(
  known: number | null | undefined,
  total: number | null | undefined,
): string {
  if (
    known === null || known === undefined || !Number.isFinite(known) ||
    total === null || total === undefined || !Number.isFinite(total) || total <= 0
  ) {
    return UNKNOWN;
  }
  return `${known}/${total}`;
}

/**
 * Is a score thin enough that showing it alone would mislead?
 *
 * Returns `null` — not `false` — when coverage is unknown. "We do not know how
 * much was assessed" is not "it was assessed thoroughly", and a boolean would
 * collapse those into the reassuring one. UNKNOWN-is-not-false, at the surface.
 */
export function isThinlyAssessed(
  known: number | null | undefined,
  total: number | null | undefined,
): boolean | null {
  if (
    known === null || known === undefined || !Number.isFinite(known) ||
    total === null || total === undefined || !Number.isFinite(total) || total <= 0
  ) {
    return null;
  }
  return known / total < 0.5;
}

// ─── AC-02: the UI computes no ranking ─────────────────────────────

/**
 * Pass rows through in the order the database returned them.
 *
 * This function looks pointless and is not. It exists so that "the UI does not
 * re-rank" is a *testable claim* rather than an absence — a test feeds
 * deliberately unsorted rows and asserts they come out untouched, which is
 * impossible to write against code that simply never sorts. It is also the
 * place a future `.sort()` would have to be added, and the test that guards it
 * would fail the moment someone did.
 *
 * The `ORDER BY` lives in `queries.ts` and nowhere else — the same discipline
 * `P3-R02` holds for `/contentplan`.
 */
export function inStoredOrder<T>(rows: readonly T[]): readonly T[] {
  return rows;
}

// ─── Status presentation ───────────────────────────────────────────
//
// Labels are a mapping, not a judgement. A status the map does not know is
// shown AS ITSELF rather than as "Unknown status" -- a new enum value added by
// a later migration must appear on the page, not disappear behind a default.

export const OPPORTUNITY_STATUS_LABELS: Readonly<Record<string, string>> = {
  CANDIDATE: "Ứng viên",
  APPROVED: "Đã duyệt",
  IN_PROGRESS: "Đang làm",
  PUBLISHED: "Đã xuất bản",
  CLOSED: "Đã đóng",
  REJECTED: "Từ chối",
};

export const SIGNAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  NEW: "Mới",
  TRIAGED: "Đã phân loại",
  LINKED: "Đã liên kết",
  DUPLICATE: "Trùng",
  DISCARDED: "Loại bỏ",
};

export const RUN_STATE_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Chờ chạy",
  RUNNING: "Đang chạy",
  SUCCEEDED: "Thành công",
  FAILED: "Thất bại",
  REFUSED: "Bị từ chối",
};

export function label(map: Readonly<Record<string, string>>, value: string | null): string {
  if (value === null || value.trim() === "") return UNKNOWN;
  return map[value] ?? value;
}

// ─── AC-08: the empty state must be honest ─────────────────────────

export interface EmptyReason {
  /** What the surface is. */
  readonly what: string;
  /** Why it is empty, in terms of the pipeline rather than the database. */
  readonly why: string;
  /** What would fill it. Names a requirement, so the answer is checkable. */
  readonly filledBy: string;
}

/**
 * Every AI Money OS table is empty in production today, and that is a **fact
 * about the pipeline**, not a rendering problem.
 *
 * A surface that showed a sample row, a zero, or a cheerful "no data yet!" with
 * no explanation would all be worse than the truth. The user needs to know that
 * the table is genuinely empty and what would put something in it — otherwise
 * an empty page is indistinguishable from a broken one.
 */
export const EMPTY_REASONS: Readonly<Record<string, EmptyReason>> = {
  opportunities: {
    what: "Hàng đợi cơ hội nội dung",
    why: "Chưa có discovery run nào tạo ra cơ hội.",
    filledBy: "P4-R02 Project Research Agent",
  },
  signals: {
    what: "Tín hiệu cơ hội",
    why: "Chưa có nguồn nào được thu thập.",
    filledBy: "P4-R02 Project Research Agent",
  },
  clusters: {
    what: "Cụm chủ đề",
    why: "Cụm được tạo từ cơ hội đã có; chưa có cơ hội nào.",
    filledBy: "P4-R02, sau khi có cơ hội",
  },
  trends: {
    what: "Trend Radar",
    why: "Allowlist chủ đề chưa được cấu hình.",
    filledBy: "Owner cấu hình, hoặc P4-R02",
  },
  candidates: {
    what: "Ứng viên affiliate từ Bidirectional Discovery",
    why: "Chưa có discovery run nào chạy theo chiều ngược.",
    filledBy: "P4-R02 Project Research Agent",
  },
  evidence: {
    what: "Bằng chứng và claim",
    why: "Bằng chứng được tạo khi agent nghiên cứu; chưa agent nào chạy.",
    filledBy: "P4-R04 Evidence Research Agent",
  },
  agents: {
    what: "Lần chạy agent",
    why: "Agent framework đã deploy nhưng registry rỗng — chưa agent nào được đăng ký.",
    filledBy: "P4-R02 đăng ký agent đầu tiên",
  },
};
