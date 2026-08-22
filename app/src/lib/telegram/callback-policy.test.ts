import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAuditRecord } from "../audit/audit-policy";
import {
  CALLBACK_OUTCOMES,
  DEFAULT_CALLBACK_RATE_LIMIT,
  callbackAuditRecordFor,
  isActionId,
  isRateLimited,
  makeActionId,
  resolveCallback,
  type ActionRecord,
  type CallbackInput,
} from "./callback-policy";

/**
 * P3-R03 — callback security, proven entirely offline.
 *
 * No bot token, no network, no database. Expiry is a pure function of
 * `(record, now)`, so the boundary cases below assert exact instants without
 * waiting for one.
 */

const NOW = new Date("2026-08-22T12:00:00.000Z");
const OWNER = 987654321;
const OTHER = 111222333;
const ID = "act_0123456789abcdef0123456789abcdef";

function record(over: Partial<ActionRecord> = {}): ActionRecord {
  return {
    actionId: ID,
    issuedTo: OWNER,
    action: "approve",
    targetType: "article",
    targetId: "a-1",
    issuedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedResult: null,
    consumedAt: null,
    ...over,
  };
}

function press(over: Partial<CallbackInput> = {}): CallbackInput {
  return { callbackData: ID, fromId: OWNER, record: record(), ...over };
}

// ─── AC-01 / AC-02: opaque id, resolved server-side ───────────────

test("AC-01: the payload is an opaque id and nothing else", () => {
  // Anything carrying meaning is refused. An attacker who can edit the payload
  // must not be able to edit what it MEANS, and the only way to guarantee that
  // is for the payload to carry no meaning at all.
  for (const carrying of [
    "approve:article:41",
    "act_0123456789abcdef0123456789abcdef:41",
    "approve",
    "41",
    '{"action":"approve","id":41}',
    "act_" + "z".repeat(32),
    "act_0123456789ABCDEF0123456789ABCDEF", // uppercase: not the format we issue
    "act_0123456789abcdef",                  // too short
    "",
    null,
    42,
  ]) {
    const d = resolveCallback(press({ callbackData: carrying }), NOW);
    assert.notEqual(d.outcome, "ACT", `"${String(carrying)}" was accepted`);
    assert.equal(d.action, undefined);
  }
});

test("AC-02: the target comes from the STORED record, never from the payload", () => {
  const d = resolveCallback(
    press({ record: record({ targetId: "a-real-target", action: "cancel" }) }),
    NOW,
  );
  assert.equal(d.outcome, "ACT");
  assert.equal(d.action, "cancel");
  assert.equal(d.targetId, "a-real-target");
});

test("AC-02: a record whose id does not match the pressed id is refused", () => {
  // Defence against a lookup that returned the wrong row -- a bug in the query
  // layer must not become an authorisation bypass.
  const d = resolveCallback(
    press({ record: record({ actionId: "act_ffffffffffffffffffffffffffffffff" }) }),
    NOW,
  );
  assert.equal(d.outcome, "REFUSE_UNKNOWN");
});

// ─── AC-03: unguessable ───────────────────────────────────────────

test("AC-03: an action id is 128 bits of randomness in a fixed format", () => {
  const id = makeActionId("0123456789abcdef0123456789abcdef");
  assert.equal(id, ID);
  assert.equal(isActionId(id), true);
});

test("AC-03: weak randomness is REFUSED rather than padded or accepted", () => {
  // An id that is short, uppercase or non-hex is one whose entropy nobody
  // checked. Refusing beats emitting it.
  for (const weak of ["short", "", "0123456789abcdef", "g".repeat(32), "0".repeat(31), "0".repeat(33)]) {
    assert.throws(() => makeActionId(weak), /16 bytes/, `"${weak}" produced an id`);
  }
});

test("AC-03: uppercase hex is NORMALISED, not refused -- it carries the same entropy", () => {
  // The check exists to refuse randomness nobody measured, not to police
  // formatting. `randomBytes().toString("hex")` is lowercase, but 32 uppercase
  // hex characters are still 128 bits.
  assert.equal(
    makeActionId("0123456789ABCDEF0123456789ABCDEF"),
    "act_0123456789abcdef0123456789abcdef",
  );
});

test("AC-03: the format admits no counter, timestamp or target hash", () => {
  for (const guessable of ["act_1", "act_" + Date.now(), "act_article41"]) {
    assert.equal(isActionId(guessable), false, `${guessable} is a valid id`);
  }
});

// ─── AC-04 / AC-05: refusals reveal nothing ───────────────────────

test("AC-04+AC-05: an unknown id and a wrong-user id are INDISTINGUISHABLE", () => {
  // The heart of AC-04. If the two refusals differed in any observable way, an
  // attacker enumerating ids would learn which ones are real by watching the
  // reason change.
  const unknown = resolveCallback(press({ record: null }), NOW);
  const wrongUser = resolveCallback(press({ fromId: OTHER }), NOW);

  assert.equal(unknown.reason, wrongUser.reason);
  assert.equal(unknown.action, undefined);
  assert.equal(wrongUser.action, undefined);
  assert.equal(unknown.targetId, undefined);
  assert.equal(wrongUser.targetId, undefined);
  assert.equal(unknown.storedResult, undefined);
  assert.equal(wrongUser.storedResult, undefined);
});

test("AC-04: no refusal leaks the target, the action or the id", () => {
  const refusals = [
    resolveCallback(press({ record: null }), NOW),
    resolveCallback(press({ fromId: OTHER }), NOW),
    resolveCallback(press({ callbackData: "approve:article:41" }), NOW),
    resolveCallback(press({ record: record({ expiresAt: new Date(NOW.getTime() - 1) }) }), NOW),
    resolveCallback(press({ rateLimited: true }), NOW),
  ];

  for (const d of refusals) {
    assert.notEqual(d.outcome, "ACT");
    assert.equal(/a-1|article|approve|act_/.test(d.reason), false, d.reason);
  }
});

test("AC-05: a DIFFERENT allowlisted user cannot use a button offered to the owner", () => {
  // Being on the allowlist is not the same as being the person the button was
  // offered to. P3-R01 authorises the person; this authorises the press.
  const d = resolveCallback(press({ fromId: OTHER }), NOW);
  assert.equal(d.outcome, "REFUSE_WRONG_USER");
  assert.equal(d.action, undefined);
});

test("AC-05: a non-numeric sender cannot match an issuedTo id", () => {
  for (const bad of ["987654321", null, undefined, {}, 1.5]) {
    const d = resolveCallback(press({ fromId: bad }), NOW);
    assert.notEqual(d.outcome, "ACT", `${String(bad)} was accepted as the issuee`);
  }
});

// ─── AC-06 / AC-10 / AC-11: expiry at the boundary ────────────────

test("AC-11: expiry is exact -- at the instant, one ms before, one ms after", () => {
  const expiry = new Date("2026-08-22T12:00:00.000Z");
  const rec = record({ expiresAt: expiry });

  const justBefore = new Date(expiry.getTime() - 1);
  const exactly = new Date(expiry.getTime());
  const justAfter = new Date(expiry.getTime() + 1);

  assert.equal(resolveCallback(press({ record: rec }), justBefore).outcome, "ACT");
  // The expiry instant is the FIRST moment the id is invalid, not the last
  // moment it is valid. `>` instead of `>=` here is a one-millisecond window
  // nobody intended to grant.
  assert.equal(resolveCallback(press({ record: rec }), exactly).outcome, "REFUSE_EXPIRED");
  assert.equal(resolveCallback(press({ record: rec }), justAfter).outcome, "REFUSE_EXPIRED");
});

test("AC-06: an expired id refuses with a legible reason and does not act", () => {
  const d = resolveCallback(
    press({ record: record({ expiresAt: new Date(NOW.getTime() - 1) }) }),
    NOW,
  );
  assert.equal(d.outcome, "REFUSE_EXPIRED");
  assert.match(d.reason, /expired/);
  assert.equal(d.action, undefined);
});

test("AC-06: a record with no usable expiry is refused, not treated as eternal", () => {
  for (const bad of [null, undefined, "soon", new Date("nonsense")]) {
    const d = resolveCallback(
      press({ record: record({ expiresAt: bad as unknown as Date }) }),
      NOW,
    );
    assert.notEqual(d.outcome, "ACT", `${String(bad)} was treated as a valid expiry`);
  }
});

test("AC-10: the decision is a pure function of (record, now)", () => {
  const a = resolveCallback(press(), NOW);
  const b = resolveCallback(press(), NOW);
  assert.deepEqual(a, b);

  // Same inputs, different clock, different answer -- proving `now` is the only
  // source of time and nothing is read from inside.
  const later = resolveCallback(press(), new Date(NOW.getTime() + 120_000));
  assert.equal(a.outcome, "ACT");
  assert.equal(later.outcome, "REFUSE_EXPIRED");
});

// ─── AC-07 / AC-08: replay ────────────────────────────────────────

test("AC-07: a replay returns the STORED result and does not act again", () => {
  const d = resolveCallback(
    press({ record: record({ consumedResult: "published", consumedAt: NOW }) }),
    NOW,
  );
  assert.equal(d.outcome, "REPLAY");
  assert.equal(d.storedResult, "published");
  // Not ACT: nothing downstream may run a second time.
  assert.equal(d.action, undefined);
});

test("AC-07: a replay does not error as if nothing had happened", () => {
  const d = resolveCallback(
    press({ record: record({ consumedResult: "cancelled", consumedAt: NOW }) }),
    NOW,
  );
  assert.notEqual(d.outcome, "REFUSE_UNKNOWN");
  assert.notEqual(d.outcome, "REFUSE_MALFORMED");
  assert.match(d.reason, /already/);
});

test("AC-07: replay is reported even after expiry -- the first press really did act", () => {
  // Order matters. Reporting "expired" for a button that already published
  // something would be a lie about the system's own history.
  const d = resolveCallback(
    press({
      record: record({
        consumedResult: "published",
        consumedAt: new Date(NOW.getTime() - 120_000),
        expiresAt: new Date(NOW.getTime() - 60_000),
      }),
    }),
    NOW,
  );
  assert.equal(d.outcome, "REPLAY");
  assert.equal(d.storedResult, "published");
});

test("AC-08: a replay carries the stored result, which is what idempotency is keyed on", () => {
  // The transaction half is enforced at the write site; what this module owns
  // is that a consumed record is DETECTABLE from the record alone, with no
  // second lookup that could disagree with it.
  const consumed = record({ consumedResult: "published", consumedAt: NOW });
  assert.equal(resolveCallback(press({ record: consumed }), NOW).outcome, "REPLAY");

  const notConsumed = record({ consumedResult: null, consumedAt: null });
  assert.equal(resolveCallback(press({ record: notConsumed }), NOW).outcome, "ACT");
});

// ─── AC-09: rate limiting ─────────────────────────────────────────

test("AC-09: rate limiting is per user, bounded by a window, and REFUSES", () => {
  const { maxPresses, windowMs } = DEFAULT_CALLBACK_RATE_LIMIT;

  const inWindow = Array.from({ length: maxPresses }, (_, i) => new Date(NOW.getTime() - i * 100));
  assert.equal(isRateLimited(inWindow, NOW), true);

  const underLimit = inWindow.slice(0, maxPresses - 1);
  assert.equal(isRateLimited(underLimit, NOW), false);

  // Old presses fall out of the window rather than accumulating forever.
  const old = Array.from({ length: maxPresses * 3 }, () => new Date(NOW.getTime() - windowMs - 1));
  assert.equal(isRateLimited(old, NOW), false);
});

test("AC-09: a rate-limited press REFUSES and never acts", () => {
  const d = resolveCallback(press({ rateLimited: true }), NOW);
  assert.equal(d.outcome, "REFUSE_RATE_LIMITED");
  assert.equal(d.action, undefined, "a rate-limited press was queued rather than refused");
});

test("AC-09: a nonsense config fails CLOSED", () => {
  assert.equal(isRateLimited([], NOW, { maxPresses: 0, windowMs: 1000 }), true);
  assert.equal(isRateLimited([], NOW, { maxPresses: -1, windowMs: 1000 }), true);
});

test("AC-09: rate limiting is checked before the record is trusted", () => {
  // A flood must cost no lookup work, and must not be able to probe for valid
  // ids by watching whether the refusal changes.
  const d = resolveCallback(press({ record: null, rateLimited: true }), NOW);
  assert.equal(d.outcome, "REFUSE_RATE_LIMITED");
});

// ─── Audit seam (P3-R06) ──────────────────────────────────────────

test("the audit record never contains the action id -- it is a live bearer token", () => {
  // An audit row is permanent. Writing a working credential into a table nobody
  // can edit afterwards would leave it there for as long as the row lives.
  for (const d of [
    resolveCallback(press(), NOW),
    resolveCallback(press({ record: null }), NOW),
    resolveCallback(press({ record: record({ consumedResult: "published" }) }), NOW),
    resolveCallback(press({ rateLimited: true }), NOW),
  ]) {
    const rec = callbackAuditRecordFor(d, OWNER, NOW);
    assert.equal(JSON.stringify(rec).includes(ID), false, "the action id reached the audit record");
    assert.equal(JSON.stringify(rec).includes("a-1"), false, "the target leaked into the audit record");
  }
});

test("the canonical P3-R06 writer ACCEPTS every callback audit record", () => {
  // Two modules agreeing by inspection is how they stop agreeing. And since
  // AC-09 of P3-R06 makes a refused audit write FAIL the operation, a callback
  // that could emit an unwritable record would be a denial of service on itself.
  for (const d of [
    resolveCallback(press(), NOW),
    resolveCallback(press({ record: null }), NOW),
    resolveCallback(press({ fromId: OTHER }), NOW),
    resolveCallback(press({ record: record({ consumedResult: "published" }) }), NOW),
    resolveCallback(press({ rateLimited: true }), NOW),
    resolveCallback(press({ record: record({ expiresAt: new Date(NOW.getTime() - 1) }) }), NOW),
  ]) {
    const rec = callbackAuditRecordFor(d, OWNER, NOW);
    const verdict = buildAuditRecord(rec, NOW);
    assert.equal(
      verdict.ok,
      true,
      `P3-R06 refused a callback record: ${verdict.ok === false ? verdict.detail : ""}`,
    );
  }
});

test("a refused caller is not recorded as a verified actor", () => {
  const refused = callbackAuditRecordFor(resolveCallback(press({ fromId: OTHER }), NOW), OTHER, NOW);
  assert.equal(refused.actorId, null);

  const acted = callbackAuditRecordFor(resolveCallback(press(), NOW), OWNER, NOW);
  assert.equal(acted.actorId, OWNER);
});

// ─── AC-12: CONTROL ───────────────────────────────────────────────

test("AC-12 CONTROL: every attack shape in the criterion is exercised and caught", () => {
  const forged = resolveCallback(press({ callbackData: "act_" + "a".repeat(32), record: null }), NOW);
  const expired = resolveCallback(press({ record: record({ expiresAt: new Date(NOW.getTime() - 1) }) }), NOW);
  const replayed = resolveCallback(press({ record: record({ consumedResult: "published" }) }), NOW);
  const crossUser = resolveCallback(press({ fromId: OTHER }), NOW);

  assert.equal(forged.outcome, "REFUSE_UNKNOWN");
  assert.equal(expired.outcome, "REFUSE_EXPIRED");
  assert.equal(replayed.outcome, "REPLAY");
  assert.equal(crossUser.outcome, "REFUSE_WRONG_USER");

  // None of the four acts.
  for (const d of [forged, expired, replayed, crossUser]) {
    assert.equal(d.action, undefined, `${d.outcome} produced an action`);
  }
});

test("AC-12 CONTROL: the resolver can ACT, and every outcome is in the vocabulary", () => {
  // A resolver that refused everything would pass every test above.
  const happy = resolveCallback(press(), NOW);
  assert.equal(happy.outcome, "ACT", "nothing is ever authorised -- the resolver is inert");
  assert.equal(happy.action, "approve");

  const seen = new Set([
    happy.outcome,
    resolveCallback(press({ record: null }), NOW).outcome,
    resolveCallback(press({ fromId: OTHER }), NOW).outcome,
    resolveCallback(press({ callbackData: "x" }), NOW).outcome,
    resolveCallback(press({ rateLimited: true }), NOW).outcome,
    resolveCallback(press({ record: record({ expiresAt: new Date(0) }) }), NOW).outcome,
    resolveCallback(press({ record: record({ consumedResult: "r" }) }), NOW).outcome,
  ]);

  assert.equal(seen.size, CALLBACK_OUTCOMES.length, `only ${seen.size} outcomes exercised`);
  for (const o of seen) {
    assert.ok((CALLBACK_OUTCOMES as readonly string[]).includes(o), `${o} is outside the vocabulary`);
  }
});
