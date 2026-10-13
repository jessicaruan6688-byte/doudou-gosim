/**
 * test/contract.test.mjs
 *
 * The contract test that src/domain/household-event.mjs has been claiming to
 * have. Its job is narrowly defined:
 *
 *   - pin the AI/WIRE validator (validateEventDraft) to its documented codes;
 *   - prove the three event validators agree instead of drifting:
 *       domain (JS)  <->  proxy (Node HTTP)  <->  Splash (bundle/main.splash)
 *   - prove the confirm gate cannot be opened by the model itself.
 *
 * Nothing here calls a provider or touches the network.
 * Run:  node --test test/contract.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  EVENT_TYPES,
  RECURRING_EVENT_TYPES,
  EVENT_DRAFT_KEYS,
  MISSING_FIELD_VALUES,
  DRAFT_ERROR_MESSAGES,
  describeDraftErrors,
  createEmptyHouseholdEvent,
  createCareerBreakExample,
  validateEventDraft,
  validateHouseholdEvent,
  confirmHouseholdEvent,
  toScenarioPayload,
  toScenarioDraft
} from "../src/domain/household-event.mjs";

import { prepareEventDraft } from "../src/services/doudou-ai-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SPLASH = readFileSync(path.join(ROOT, "bundle/main.splash"), "utf8");
const PROXY = readFileSync(path.join(ROOT, "server/doudou-agent-proxy.mjs"), "utf8");

/** A complete, valid model reply used as the positive control. */
function wireEvent(overrides = {}) {
  return {
    title: "休息 18 个月",
    eventType: "income_loss",
    monthlyIncomeDelta: -40000,
    monthlyExpenseDelta: 0,
    oneTimeCashDelta: 0,
    durationMonths: 18,
    assumptions: ["休息期间家庭收入降为零"],
    missingFields: [],
    clarificationQuestion: "",
    ...overrides
  };
}

const codes = (raw, opts) => validateEventDraft(raw, opts).errors;
const has = (list, prefix) =>
  list.some((c) => c === prefix || c.startsWith(`${prefix}:`));

/* ================================================================== *
 * C1 — illegal event type
 * ================================================================== */

test("C1 an unknown event type is refused by code, not silently kept", () => {
  const errs = codes(wireEvent({ eventType: "weird_type" }));
  assert.ok(has(errs, "event_type_not_allowed"), JSON.stringify(errs));
  assert.equal(validateEventDraft(wireEvent({ eventType: "weird_type" })).draft, null);
});

test("C1b the type list is the frozen 7, and the wire validator uses it", () => {
  assert.equal(EVENT_TYPES.length, 7);
  for (const t of EVENT_TYPES) {
    const errs = codes(wireEvent({ eventType: t, ...recurringFix(t) }));
    assert.equal(has(errs, "event_type_not_allowed"), false, `type ${t} rejected`);
  }
});

test("C1c a non-string / missing eventType is refused", () => {
  for (const bad of [null, 1, [], {}, undefined]) {
    assert.ok(has(codes(wireEvent({ eventType: bad })), "event_type_not_allowed"));
  }
});

/** Give each type a shape that is valid for it (purchase != recurring). */
function recurringFix(type) {
  if (type === "purchase") {
    return { monthlyIncomeDelta: 0, monthlyExpenseDelta: 0, oneTimeCashDelta: -300000, durationMonths: 0 };
  }
  if (type === "income_loss" || type === "income_change") {
    return { monthlyIncomeDelta: -40000, monthlyExpenseDelta: 0, oneTimeCashDelta: 0, durationMonths: 12 };
  }
  // medical_cost | education_cost | caregiving | other
  return { monthlyIncomeDelta: 0, monthlyExpenseDelta: 3000, oneTimeCashDelta: 0, durationMonths: 12 };
}

/* ================================================================== *
 * C2 — illegal amount
 * ================================================================== */

test("C2 the 1e8 upper bound is enforced on the wire (the draft had none)", () => {
  assert.ok(has(codes(wireEvent({ monthlyIncomeDelta: 100_000_001 })), "amount_out_of_range"));
  assert.ok(has(codes(wireEvent({ oneTimeCashDelta: -100_000_001 })), "amount_out_of_range"));
  // boundary is inclusive
  assert.equal(codes(wireEvent({ monthlyIncomeDelta: -100_000_000 })).length, 0);
});

test("C2b a non-numeric or non-finite amount is refused", () => {
  assert.ok(has(codes(wireEvent({ monthlyIncomeDelta: "40000" })), "invalid_number"));
  assert.ok(has(codes(wireEvent({ monthlyIncomeDelta: NaN })), "invalid_number"));
  assert.ok(has(codes(wireEvent({ monthlyIncomeDelta: Infinity })), "invalid_number"));
  assert.ok(has(codes(wireEvent({ monthlyIncomeDelta: {} })), "invalid_number"));
});

test("C2c an ABSENT amount key counts as a number problem", () => {
  const e = wireEvent();
  delete e.monthlyIncomeDelta;
  assert.ok(has(codes(e), "invalid_number"));
});

test("C2d the legacy Chinese-sentence validator keeps the same bound", () => {
  const bad = { ...createCareerBreakExample(), monthlyIncomeDelta: 100_000_001 };
  assert.ok(validateHouseholdEvent(bad).some((e) => e.includes("monthlyIncomeDelta")));
});

/* ================================================================== *
 * C3 — missing duration
 * ================================================================== */

test("C3 a draft may say 'I do not know the duration yet' (null is legal)", () => {
  const r = validateEventDraft(wireEvent({
    durationMonths: null,
    missingFields: ["duration"]
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.draft.durationMonths, null);
});

test("C3b but an explicit 0 for a recurring type is a no-op and is refused", () => {
  // The Splash app has always refused this (ev_map); the JS domain used to turn
  // it into a 0-month REST scenario that reached the engine as a no-op.
  const errs = codes(wireEvent({ eventType: "income_loss", durationMonths: 0 }));
  assert.ok(has(errs, "recurring_event_requires_valid_duration"), JSON.stringify(errs));
});

test("C3c requireComplete turns an unknown duration into a hard error", () => {
  const opts = { requireComplete: true };
  const errs = codes(wireEvent({ durationMonths: null, missingFields: ["duration"] }), opts);
  assert.ok(has(errs, "recurring_event_requires_valid_duration"));
  // a non-recurring type is not forced to have a duration
  const ok = codes(wireEvent({
    eventType: "purchase", monthlyIncomeDelta: 0, monthlyExpenseDelta: 0,
    oneTimeCashDelta: -300000, durationMonths: null,
    missingFields: ["duration"]
  }), opts);
  assert.equal(has(ok, "invalid_duration"), false, JSON.stringify(ok));
});

test("C3d an out-of-range or fractional duration is refused", () => {
  assert.ok(has(codes(wireEvent({ durationMonths: 601 })), "recurring_event_requires_valid_duration"));
  assert.ok(has(codes(wireEvent({ durationMonths: 12.5 })), "recurring_event_requires_valid_duration"));
  assert.ok(has(codes(wireEvent({ durationMonths: -1 })), "recurring_event_requires_valid_duration"));
  assert.ok(has(codes(wireEvent({
    eventType: "purchase", oneTimeCashDelta: -1, monthlyIncomeDelta: 0,
    monthlyExpenseDelta: 0, durationMonths: 601
  })), "invalid_duration"));
});

test("C3e the confirm boundary still requires a duration for every type", () => {
  const e = { ...createCareerBreakExample(), durationMonths: null };
  assert.ok(validateHouseholdEvent(e).includes("请确认事件持续时间"));
});

/* ================================================================== *
 * C4 — null vs 0
 * ================================================================== */

test("C4 null means 'not known yet' and is never coerced to 0", () => {
  const r = validateEventDraft(wireEvent({
    monthlyExpenseDelta: null, oneTimeCashDelta: null, monthlyIncomeDelta: null,
    missingFields: ["amount"]
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.draft.monthlyIncomeDelta, null);
  assert.strictEqual(r.draft.monthlyExpenseDelta, null);
  assert.strictEqual(r.draft.oneTimeCashDelta, null);
  assert.notStrictEqual(r.draft.monthlyIncomeDelta, 0);
});

test("C4b 0 is preserved as an explicit 'no change', distinct from null", () => {
  const r = validateEventDraft(wireEvent({
    monthlyIncomeDelta: -40000, monthlyExpenseDelta: 0, oneTimeCashDelta: 0
  }));
  assert.equal(r.draft.monthlyExpenseDelta, 0);
  assert.strictEqual(r.draft.monthlyExpenseDelta, 0);
  const p = toScenarioDraft(confirmHouseholdEvent({ ...r.draft, source: "manual", confirmed: false }).event);
  assert.equal(p.scenarioType, "REST");
});

test("C4c an empty draft uses null, and says so via missingFields", () => {
  const d = createEmptyHouseholdEvent();
  assert.strictEqual(d.monthlyIncomeDelta, null);
  assert.strictEqual(d.monthlyExpenseDelta, null);
  assert.strictEqual(d.oneTimeCashDelta, null);
  assert.strictEqual(d.durationMonths, null);
  assert.deepEqual(d.missingFields, ["amount", "duration", "recurrence"]);
});

test("C4d durationMonths null and 0 are different facts at confirm time", () => {
  const asNull = { ...createCareerBreakExample(), durationMonths: null };
  const asZero = { ...createCareerBreakExample(), durationMonths: 0 };
  assert.ok(validateHouseholdEvent(asNull).includes("请确认事件持续时间"));
  assert.ok(validateHouseholdEvent(asZero).includes("持续性事件请填写大于 0 的持续月数"));
  assert.notDeepEqual(validateHouseholdEvent(asNull), validateHouseholdEvent(asZero));
});

test("C4e all-null and all-zero are both refused, for the same reason", () => {
  const allNull = { ...createEmptyHouseholdEvent(), title: "x", durationMonths: 12 };
  const allZero = {
    ...createEmptyHouseholdEvent(), title: "x", durationMonths: 12,
    monthlyIncomeDelta: 0, monthlyExpenseDelta: 0, oneTimeCashDelta: 0
  };
  const reason = "请至少填写一项非零金额";
  assert.ok(validateHouseholdEvent(allNull).includes(reason));
  assert.ok(validateHouseholdEvent(allZero).includes(reason));
});

test("C4f a reply claiming nothing is missing while everything is null is flagged", () => {
  const errs = codes(wireEvent({
    monthlyIncomeDelta: null, monthlyExpenseDelta: null, oneTimeCashDelta: null,
    durationMonths: null, missingFields: []
  }));
  assert.ok(has(errs, "missing_fields_understated"), JSON.stringify(errs));
});

/* ================================================================== *
 * C5 — the model must not be able to confirm its own event
 * ================================================================== */

test("C5 a raw model object carrying confirmed:true cannot reach the engine", () => {
  const raw = wireEvent({ confirmed: true, engineResult: { months: 999 } });
  // it is a WIRE object, so it must be refused structurally first
  assert.ok(has(codes(raw), "unexpected_field"), JSON.stringify(codes(raw)));
  // and the legacy gate must not accept it either
  assert.throws(() => toScenarioPayload(raw), /EVENT_REQUIRES_USER_CONFIRMATION/);
  assert.equal(toScenarioDraft(raw).ok, false);
});

test("C5b the wire draft never carries source/confirmed itself", () => {
  const r = validateEventDraft(wireEvent());
  assert.equal(Object.prototype.hasOwnProperty.call(r.draft, "confirmed"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.draft, "source"), false);
  for (const k of Object.keys(r.draft)) {
    assert.ok(EVENT_DRAFT_KEYS.includes(k), `unexpected draft key ${k}`);
  }
});

test("C5c prepareEventDraft drops keys the model invented", () => {
  const d = prepareEventDraft(wireEvent({ engineResult: { months: 999 }, hijack: "x" }));
  assert.equal(Object.prototype.hasOwnProperty.call(d, "engineResult"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(d, "hijack"), false);
  assert.equal(d.confirmed, false);
  assert.equal(d.source, "ai");
});

test("C5d a rejected reply degrades to an EMPTY draft, never a partial one", () => {
  const d = prepareEventDraft(wireEvent({ engineResult: { months: 999 } }));
  // the whole reply is refused, so nothing from it is kept
  assert.ok(d.draftErrors.includes("unexpected_field:engineResult"));
  assert.equal(d.title, "");
  assert.strictEqual(d.monthlyIncomeDelta, null);
  assert.equal(d.confirmed, false);
  assert.equal(d.source, "ai");
  // and the degraded draft is not confirmable — the person must fill it in
  assert.equal(confirmHouseholdEvent(d).ok, false);
});

test("C5d2 a clean reply yields a confirmable event with only known keys", () => {
  const d = prepareEventDraft(wireEvent());
  assert.deepEqual(d.draftErrors, []);
  const { event } = confirmHouseholdEvent(d);
  assert.ok(event);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "engineResult"), false);
  assert.equal(event.confirmed, true);
  for (const k of Object.keys(event)) {
    assert.ok(
      [...EVENT_DRAFT_KEYS, "schemaVersion", "id", "source", "confirmed"].includes(k),
      `unexpected confirmed-event key ${k}`
    );
  }
});

test("C5e an unconfirmed draft is refused by both engine entry points", () => {
  const draft = prepareEventDraft(wireEvent());
  assert.equal(draft.confirmed, false);
  assert.equal(toScenarioDraft(draft).ok, false);
  assert.equal(toScenarioDraft(draft).reason, "EVENT_REQUIRES_USER_CONFIRMATION");
  assert.throws(() => toScenarioPayload(draft), /EVENT_REQUIRES_USER_CONFIRMATION/);
  // positive control: the same payload becomes mappable only after confirmation
  const { ok, event } = confirmHouseholdEvent(draft);
  assert.equal(ok, true);
  assert.equal(toScenarioDraft(event).ok, true);
});

test("C5f the ai source is promoted, never trusted from the wire", () => {
  const { event } = confirmHouseholdEvent(prepareEventDraft(wireEvent()));
  assert.equal(event.source, "ai_confirmed");
  const manual = confirmHouseholdEvent(createCareerBreakExample()).event;
  assert.equal(manual.source, "manual");
});

/* ================================================================== *
 * C6 — one error protocol per boundary
 * ================================================================== */

test("C6 every machine code has a Chinese sentence (the UI never shows a raw code)", () => {
  const emitted = [
    "draft_must_be_object", "unknown_field_x", "title_required",
    "event_type_not_allowed", "invalid_number:monthlyIncomeDelta",
    "amount_out_of_range:oneTimeCashDelta", "invalid_duration",
    "recurring_event_requires_valid_duration", "invalid_missing_field",
    "assumptions_must_be_string_array", "missing_fields_must_be_string_array",
    "invalid_clarification_question", "missing_fields_understated"
  ];
  const rendered = describeDraftErrors(emitted);
  assert.equal(rendered.length, emitted.length);
  for (const line of rendered) {
    assert.ok(typeof line === "string" && line.length > 0);
    assert.ok(!/^[a-z_]+$/.test(line), `raw code leaked to the UI: ${line}`);
  }
  // an unknown code degrades to a readable sentence instead of throwing
  assert.ok(describeDraftErrors(["totally_new_code"])[0].includes("totally_new_code"));
});

test("C6b unknown keys are refused, and the message name stays generic", () => {
  const errs = codes(wireEvent({ confirmed: true }));
  assert.ok(errs.includes("unexpected_field:confirmed"));
  assert.ok(describeDraftErrors(errs).some((m) => m.includes("未授权字段")));
});

test("C6c missingFields keeps the existing three-value whitelist", () => {
  assert.deepEqual([...MISSING_FIELD_VALUES], ["amount", "duration", "recurrence"]);
  assert.ok(has(codes(wireEvent({ missingFields: ["whatever"] })), "invalid_missing_field"));
  assert.ok(has(codes(wireEvent({ missingFields: [1] })), "missing_fields_must_be_string_array"));
  assert.equal(codes(wireEvent({ missingFields: ["amount", "duration"] })).length, 0);
});

test("C6d clarificationQuestion: string or null are both legal", () => {
  assert.equal(codes(wireEvent({ clarificationQuestion: null })).length, 0);
  assert.equal(codes(wireEvent({ clarificationQuestion: "几个月？" })).length, 0);
  assert.ok(has(codes(wireEvent({ clarificationQuestion: 42 })), "invalid_clarification_question"));
  // normalized to one representation downstream
  assert.equal(validateEventDraft(wireEvent({ clarificationQuestion: null })).draft.clarificationQuestion, "");
});

test("C6e a non-object draft is refused, not thrown on", () => {
  for (const bad of [null, undefined, 42, "str", []]) {
    const r = validateEventDraft(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ["draft_must_be_object"]);
    assert.equal(r.draft, null);
  }
});

/* ================================================================== *
 * C7 — the three implementations must not drift
 * ================================================================== */

test("C7 Splash's EV_TYPES literal equals the domain's EVENT_TYPES", () => {
  const m = SPLASH.match(/let EV_TYPES = \[([^\]]*)\]/);
  assert.ok(m, "EV_TYPES not found in bundle/main.splash");
  const splashTypes = m[1].trim().split(/\s+/).map((s) => s.replace(/"/g, ""));
  assert.deepEqual(splashTypes, [...EVENT_TYPES]);
});

test("C7b the numeric guards agree across the three copies", () => {
  assert.match(SPLASH, /let EV_MAX_AMOUNT = 100000000\.0/);
  assert.match(SPLASH, /let EV_MAX_MONTHS = 600/);
  // and the domain enforces the very same two bounds
  assert.ok(has(codes(wireEvent({ monthlyIncomeDelta: 100_000_001 })), "amount_out_of_range"));
  assert.ok(has(codes(wireEvent({ durationMonths: 601 })), "recurring_event_requires_valid_duration"));
});

test("C7c the proxy no longer carries its own copy of the type list", () => {
  assert.equal(/const TYPES = new Set\(/.test(PROXY), false,
    "proxy still defines a private type set");
  assert.match(PROXY, /from "\.\.\/src\/domain\/household-event\.mjs"/);
});

test("C7d Splash refuses a 0-month income loss; so does the domain now", () => {
  // the Splash rule that this change aligns the JS domain with
  assert.ok(SPLASH.includes("收入中断需要填写大于 0 的持续月数"));
  assert.ok(validateHouseholdEvent({
    ...createCareerBreakExample(), durationMonths: 0
  }).includes("持续性事件请填写大于 0 的持续月数"));
});

test("C7e RECURRING_EVENT_TYPES is a subset of EVENT_TYPES and excludes purchase", () => {
  for (const t of RECURRING_EVENT_TYPES) assert.ok(EVENT_TYPES.includes(t), t);
  assert.equal(RECURRING_EVENT_TYPES.includes("purchase"), false);
  assert.equal(RECURRING_EVENT_TYPES.includes("other"), false);
});

test("C7f the wire validator is not a drop-in for the internal draft", () => {
  // feeding it an internal draft is a type error by design
  const errs = codes(createEmptyHouseholdEvent());
  assert.ok(has(errs, "unexpected_field"), JSON.stringify(errs));
  assert.ok(errs.includes("unexpected_field:confirmed"));
  assert.ok(errs.includes("unexpected_field:source"));
});
