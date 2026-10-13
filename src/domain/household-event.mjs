/**
 * src/domain/household-event.mjs
 *
 * Pure domain functions. No network, no model, no persistence.
 *
 * Contract source: ChatGPT core module #2 (household-event). Landed as given,
 * with ONE addition: `toScenarioDraft()` — the explicit mapping into the
 * existing deterministic engine's scenario types. See the mapping table below.
 *
 * The app (bundle/main.splash) implements the same rules in Splash DSL as
 * `ev_validate` / `ev_confirm` / `ev_map` (main.splash:2559 / 2584 / 2606).
 * `test/contract.test.mjs` asserts the two implementations agree, and also
 * guards against the event-type enum drifting between this file, the proxy and
 * the Splash source.
 *
 * THREE distinct validators exist on purpose — do not collapse them:
 *   1. `validateEventDraft()`     (below)  the AI / WIRE boundary. Machine codes,
 *                                          rejects unexpected keys, tolerates
 *                                          nulls because "the model does not
 *                                          know yet" is a legal answer.
 *   2. `validateHouseholdEvent()` (below)  the INTERNAL draft / CONFIRM boundary.
 *                                          Chinese sentences the UI shows.
 *   3. `validateEvent()` in server/doudou-agent-proxy.mjs (now a thin adapter
 *      over #1), which maps codes onto the proxy's HTTP error contract.
 */

export const EVENT_TYPES = Object.freeze([
  "income_loss",
  "income_change",
  "purchase",
  "medical_cost",
  "education_cost",
  "caregiving",
  "other"
]);

const MAX_AMOUNT = 100_000_000;
const MAX_DURATION_MONTHS = 600;

const NUMERIC_FIELDS = Object.freeze([
  "monthlyIncomeDelta",
  "monthlyExpenseDelta",
  "oneTimeCashDelta"
]);

/** The only values `missingFields` may contain. Mirrors the proxy's whitelist. */
export const MISSING_FIELD_VALUES = Object.freeze([
  "amount",
  "duration",
  "recurrence"
]);

export const EVENT_SOURCE = Object.freeze({
  MANUAL: "manual",
  AI: "ai",
  AI_CONFIRMED: "ai_confirmed"
});

/**
 * Types whose scenario only makes sense over a positive number of months.
 *
 * DECISION, not a discovered fact: nothing in the previous code expressed this
 * axis as a list — one-off vs recurring used to be encoded only in the VALUE of
 * `durationMonths` (0 = one-off). Declaring it here is what lets the draft
 * validator reject `income_loss` + 0 months, which the Splash app already
 * refuses (`ev_map`, main.splash:2627) while the JS domain silently turned into
 * a 0-month REST no-op. `purchase` and `other` stay flexible on purpose.
 *
 * This is a business-semantics choice. It is frozen here so there is ONE
 * definition; ratify or amend it in one place.
 */
export const RECURRING_EVENT_TYPES = Object.freeze([
  "income_loss",
  "income_change",
  "medical_cost",
  "education_cost",
  "caregiving"
]);

/** The exact key set a model reply may carry. Anything else is rejected. */
export const EVENT_DRAFT_KEYS = Object.freeze([
  "title",
  "eventType",
  "monthlyIncomeDelta",
  "monthlyExpenseDelta",
  "oneTimeCashDelta",
  "durationMonths",
  "assumptions",
  "missingFields",
  "clarificationQuestion"
]);

/**
 * Machine code -> the Chinese sentence the UI shows. Keeps the wire validator
 * and the UI talking about the same thing instead of each inventing its own
 * wording (the failure mode the layer split was meant to avoid).
 */
export const DRAFT_ERROR_MESSAGES = Object.freeze({
  draft_must_be_object: "事件草稿必须是 JSON 对象",
  unexpected_field: "草稿包含未授权字段",
  title_required: "请填写事件名称",
  event_type_not_allowed: "事件类型不受支持",
  invalid_number: "金额必须是有效数字，或 null 表示尚未明确",
  amount_out_of_range: "金额超出允许范围（绝对值不超过 1 亿）",
  invalid_duration: "持续月数须为 0–600 的整数，或 null 表示尚未明确",
  recurring_event_requires_valid_duration: "持续性事件需要 1–600 个月的整数期限",
  invalid_missing_field: "missingFields 只能包含 amount / duration / recurrence",
  assumptions_must_be_string_array: "事件假设格式不正确",
  missing_fields_must_be_string_array: "missingFields 必须是字符串数组",
  invalid_clarification_question: "clarificationQuestion 必须是字符串或 null",
  missing_fields_understated: "草稿声称信息完整，但关键金额或期限仍然缺失"
});

/** Render machine codes as the localized sentences the UI shows. */
export function describeDraftErrors(codes) {
  return (codes || []).map((code) => {
    const [name, arg] = String(code).split(":");
    const base = DRAFT_ERROR_MESSAGES[name] || `未知校验错误：${name}`;
    return arg ? `${base}（${arg}）` : base;
  });
}

/**
 * Validate the JSON a model (or a reviewer pasting that JSON) produced.
 *
 * This is the WIRE boundary, deliberately NOT a replacement for
 * `validateHouseholdEvent()`: it rejects keys the internal draft is allowed to
 * carry (`source`, `confirmed`, `schemaVersion`, `id`), so feeding it an
 * internal draft is a type error, not a validation failure to paper over.
 *
 * Faithful to the proposed contract, with four deliberate differences, each
 * marked below, each needed to avoid dropping a guard that already exists.
 *
 * @param {unknown} raw
 * @param {{
 *   allowedEventTypes?: readonly string[],
 *   recurringEventTypes?: readonly string[],
 *   requireComplete?: boolean
 * }} [options]
 * @returns {{ok: boolean, errors: string[], draft: object|null}}
 */
export function validateEventDraft(raw, {
  allowedEventTypes = EVENT_TYPES,
  recurringEventTypes = RECURRING_EVENT_TYPES,
  requireComplete = false
} = {}) {
  const errors = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["draft_must_be_object"], draft: null };
  }

  // DELIBERATE #1 — reject unknown keys. Nothing did this before, and it is the
  // structural guard against a model inventing `confirmed: true` or an
  // `engineResult` of its own.
  for (const key of Object.keys(raw)) {
    if (!EVENT_DRAFT_KEYS.includes(key)) errors.push(`unexpected_field:${key}`);
  }

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) errors.push("title_required");

  const typeKnown =
    typeof raw.eventType === "string" && allowedEventTypes.includes(raw.eventType);
  if (!typeKnown) errors.push("event_type_not_allowed");

  for (const field of NUMERIC_FIELDS) {
    const value = raw[field];
    if (value === null) continue;
    if (value === undefined) {
      // An absent key is not a legal wire value. Reported as a number problem
      // so the code set stays as proposed; the proxy always sends explicit nulls.
      errors.push(`invalid_number:${field}`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`invalid_number:${field}`);
      continue;
    }
    // DELIBERATE #2 — the proposed contract has no upper bound; the existing
    // guards (this file and the proxy) both enforce 1e8. Dropping it would let a
    // hallucinated 1e12 through, so it is restored here.
    if (Math.abs(value) > MAX_AMOUNT) errors.push(`amount_out_of_range:${field}`);
  }

  const isRecurring = typeKnown && recurringEventTypes.includes(raw.eventType);
  const duration = raw.durationMonths === undefined ? null : raw.durationMonths;
  const durationMissing = duration === null;

  if (!durationMissing) {
    if (!Number.isInteger(duration) || duration < 0 || duration > MAX_DURATION_MONTHS) {
      errors.push(
        isRecurring
          ? "recurring_event_requires_valid_duration"
          : "invalid_duration"
      );
    } else if (isRecurring && duration < 1) {
      // DELIBERATE #3 — a recurring event with a 0-month term is a no-op that
      // used to reach the engine. Splash already refuses it; so do we now.
      errors.push("recurring_event_requires_valid_duration");
    }
  } else if (isRecurring && requireComplete) {
    errors.push("recurring_event_requires_valid_duration");
  }

  if (!Array.isArray(raw.assumptions) ||
      !raw.assumptions.every((item) => typeof item === "string")) {
    errors.push("assumptions_must_be_string_array");
  }

  if (!Array.isArray(raw.missingFields) ||
      !raw.missingFields.every((item) => typeof item === "string")) {
    errors.push("missing_fields_must_be_string_array");
  } else {
    // DELIBERATE #4 — the proposed contract only checks string-ness. The proxy
    // already whitelists these three values; keep that guard.
    if (raw.missingFields.some((v) => !MISSING_FIELD_VALUES.includes(v))) {
      errors.push("invalid_missing_field");
    }
    // ADDITION — a reply that says "nothing is missing" while every amount is
    // null is self-contradictory. Catches a model that asserts completeness.
    if (raw.missingFields.length === 0) {
      const anyAmount = NUMERIC_FIELDS.some(
        (k) => typeof raw[k] === "number" && raw[k] !== 0
      );
      if (!anyAmount) errors.push("missing_fields_understated");
    }
  }

  const clarification =
    raw.clarificationQuestion === undefined ? null : raw.clarificationQuestion;
  if (clarification !== null && typeof clarification !== "string") {
    errors.push("invalid_clarification_question");
  }

  const draft = {
    title,
    eventType: raw.eventType,
    monthlyIncomeDelta: raw.monthlyIncomeDelta ?? null,
    monthlyExpenseDelta: raw.monthlyExpenseDelta ?? null,
    oneTimeCashDelta: raw.oneTimeCashDelta ?? null,
    durationMonths: durationMissing ? null : duration,
    assumptions: Array.isArray(raw.assumptions) ? [...raw.assumptions] : [],
    missingFields: Array.isArray(raw.missingFields) ? [...raw.missingFields] : [],
    // one representation downstream: the internal draft uses "" for "no question"
    clarificationQuestion: typeof clarification === "string" ? clarification : ""
  };

  return {
    ok: errors.length === 0,
    errors,
    draft: errors.length === 0 ? draft : null
  };
}

export function createEmptyHouseholdEvent() {
  return {
    schemaVersion: 1,
    id: null,
    title: "",
    eventType: "other",

    // All amounts are CNY.
    monthlyIncomeDelta: null,
    monthlyExpenseDelta: null,
    oneTimeCashDelta: null,

    // 0 = one-off event; null = not yet known.
    durationMonths: null,

    assumptions: [],
    missingFields: ["amount", "duration", "recurrence"],
    clarificationQuestion: "",
    source: "manual",
    confirmed: false
  };
}

function validAmount(value) {
  return value === null ||
    (typeof value === "number" &&
     Number.isFinite(value) &&
     Math.abs(value) <= MAX_AMOUNT);
}

export function validateHouseholdEvent(event) {
  const errors = [];

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return ["事件格式不正确"];
  }

  if (typeof event.title !== "string" || !event.title.trim()) {
    errors.push("请填写事件名称");
  }

  if (!EVENT_TYPES.includes(event.eventType)) {
    errors.push("事件类型不受支持");
  }

  for (const field of [
    "monthlyIncomeDelta",
    "monthlyExpenseDelta",
    "oneTimeCashDelta"
  ]) {
    if (!(field in event) || !validAmount(event[field])) {
      errors.push(`${field} 必须是有效金额或 null`);
    }
  }

  if (
    event.durationMonths !== null &&
    (!Number.isInteger(event.durationMonths) ||
     event.durationMonths < 0 ||
     event.durationMonths > MAX_DURATION_MONTHS)
  ) {
    errors.push("持续时间必须为 0–600 个月的整数，或暂不填写");
  }

  // A recurring event with a 0-month term is a no-op, not a small event.
  // The Splash app already refuses this when mapping (ev_map, main.splash:2627).
  if (event.durationMonths === 0 &&
      RECURRING_EVENT_TYPES.includes(event.eventType)) {
    errors.push("持续性事件请填写大于 0 的持续月数");
  }

  if (!Array.isArray(event.assumptions) ||
      !event.assumptions.every(x => typeof x === "string")) {
    errors.push("事件假设格式不正确");
  }

  if (event.durationMonths === null) {
    errors.push("请确认事件持续时间");
  }

  const amountKnown = [
    event.monthlyIncomeDelta,
    event.monthlyExpenseDelta,
    event.oneTimeCashDelta
  ].some(v => v !== null && v !== 0);

  if (!amountKnown) {
    errors.push("请至少填写一项非零金额");
  }

  if (event.eventType === "purchase" &&
      event.oneTimeCashDelta === null &&
      event.monthlyExpenseDelta === null) {
    errors.push("购买事件需要确认一次性支出或新增月支出");
  }

  return [...new Set(errors)];
}

/**
 * Only call after a person has reviewed the draft.
 * This function does not write storage or run the forecast.
 *
 * The confirmed event is built from an EXPLICIT key list, never `...draft`, so
 * a key a model invented (say `engineResult`) cannot ride along into whatever
 * the confirmed event is later persisted as.
 */
export function confirmHouseholdEvent(draft) {
  const errors = validateHouseholdEvent(draft);

  if (errors.length) {
    return { ok: false, errors, event: null };
  }

  const event = {
    schemaVersion: draft.schemaVersion ?? 1,
    id: draft.id ?? null,
    title: draft.title.trim(),
    eventType: draft.eventType,
    monthlyIncomeDelta: draft.monthlyIncomeDelta,
    monthlyExpenseDelta: draft.monthlyExpenseDelta,
    oneTimeCashDelta: draft.oneTimeCashDelta,
    durationMonths: draft.durationMonths,
    assumptions: [...draft.assumptions],
    missingFields: Array.isArray(draft.missingFields) ? [...draft.missingFields] : [],
    clarificationQuestion:
      typeof draft.clarificationQuestion === "string" ? draft.clarificationQuestion : "",
    source: draft.source === EVENT_SOURCE.AI
      ? EVENT_SOURCE.AI_CONFIRMED
      : EVENT_SOURCE.MANUAL,
    confirmed: true
  };

  return { ok: true, errors: [], event };
}

/**
 * Convert a confirmed event to a neutral domain payload.
 *
 * The gate is NOT `confirmed === true` alone: that boolean is a field a model
 * can write, and a raw model object carrying `confirmed: true` used to pass
 * straight through (proved by test/contract.test.mjs C5). `source` is set only
 * by `confirmHouseholdEvent()`, so requiring one of its two values makes the
 * gate depend on something the model path never produces.
 *
 * IMPORTANT:
 * The integration layer must map this payload to the EXISTING
 * calculation engine's actual input type. Do not pass it directly
 * to flow_decide unless its real signature matches.
 */
export function toScenarioPayload(confirmedEvent) {
  const confirmedByUs =
    confirmedEvent?.confirmed === true &&
    (confirmedEvent.source === EVENT_SOURCE.MANUAL ||
     confirmedEvent.source === EVENT_SOURCE.AI_CONFIRMED);

  if (!confirmedByUs) {
    throw new Error("EVENT_REQUIRES_USER_CONFIRMATION");
  }

  const errors = validateHouseholdEvent(confirmedEvent);
  if (errors.length) {
    throw new Error(`INVALID_EVENT: ${errors.join("; ")}`);
  }

  return Object.freeze({
    title: confirmedEvent.title,
    eventType: confirmedEvent.eventType,
    monthlyIncomeDelta: confirmedEvent.monthlyIncomeDelta,
    monthlyExpenseDelta: confirmedEvent.monthlyExpenseDelta,
    oneTimeCashDelta: confirmedEvent.oneTimeCashDelta,
    durationMonths: confirmedEvent.durationMonths
  });
}

/**
 * Map a confirmed event onto the EXISTING engine's scenario types.
 *
 * The production engine (bundle/main.splash) only understands four scenario
 * types. Verified against the real source:
 *
 *   domain_Scenario  (main.splash:84)  — types REST | CAR_PURCHASE |
 *                                        INCOME_CHANGE | EXPENSE_CHANGE
 *   g3_scenario_cf_per_month (main.splash:742)
 *   g3_simulate (main.splash:848)
 *
 * Mapping table (no new formulas, no guessed fields):
 *
 *   income_loss    + monthlyIncomeDelta  -> REST   (drops ALL income for N months)
 *                                          or INCOME_CHANGE when only part of income goes
 *   income_change                        -> INCOME_CHANGE
 *   purchase       + oneTimeCashDelta    -> CAR_PURCHASE
 *   purchase       + monthlyExpenseDelta -> EXPENSE_CHANGE
 *   medical_cost   -> EXPENSE_CHANGE (monthly) / CAR_PURCHASE (one-off)
 *   education_cost -> EXPENSE_CHANGE (monthly) / CAR_PURCHASE (one-off)
 *   caregiving     -> EXPENSE_CHANGE (monthly) / CAR_PURCHASE (one-off)
 *   other          -> by the populated delta field
 *
 * Returns `{ ok:true, scenarioType, fields, note }` or `{ ok:false, reason }`.
 * It NEVER invents a numeric value the person did not confirm.
 */
export function toScenarioDraft(confirmedEvent) {
  const confirmedByUs =
    confirmedEvent?.confirmed === true &&
    (confirmedEvent.source === EVENT_SOURCE.MANUAL ||
     confirmedEvent.source === EVENT_SOURCE.AI_CONFIRMED);

  if (!confirmedByUs) {
    return { ok: false, reason: "EVENT_REQUIRES_USER_CONFIRMATION" };
  }
  const errors = validateHouseholdEvent(confirmedEvent);
  if (errors.length) {
    return { ok: false, reason: `INVALID_EVENT: ${errors.join("; ")}` };
  }

  const dur = confirmedEvent.durationMonths;
  const inc = confirmedEvent.monthlyIncomeDelta;
  const exp = confirmedEvent.monthlyExpenseDelta;
  const one = confirmedEvent.oneTimeCashDelta;

  const nonNull = (v) => v !== null && v !== 0;

  // One-off cash movement -> CAR_PURCHASE (the engine's only one-time type).
  if (nonNull(one) && !nonNull(exp) && !nonNull(inc)) {
    return {
      ok: true,
      scenarioType: "CAR_PURCHASE",
      fields: { purchase_amount: Math.abs(one), duration_months: 0 },
      note: "一次性现金流出，按引擎的 CAR_PURCHASE（期初一次性扣减）处理"
    };
  }

  // Monthly expense movement -> EXPENSE_CHANGE.
  if (nonNull(exp) && !nonNull(inc)) {
    return {
      ok: true,
      scenarioType: "EXPENSE_CHANGE",
      fields: {
        monthly_expense_delta: Math.abs(exp),
        duration_months: dur
      },
      note: "每月支出变化，按引擎的 EXPENSE_CHANGE 处理"
    };
  }

  // Income movement -> REST (all income to 0) or INCOME_CHANGE (partial).
  if (nonNull(inc)) {
    const isTotalLoss = confirmedEvent.eventType === "income_loss";
    if (isTotalLoss) {
      return {
        ok: true,
        scenarioType: "REST",
        fields: { duration_months: dur },
        note: "收入归零，按引擎的 REST（收入为 0）处理"
      };
    }
    return {
      ok: true,
      scenarioType: "INCOME_CHANGE",
      fields: { monthly_income_delta: inc, duration_months: dur },
      note: "每月收入变化，按引擎的 INCOME_CHANGE 处理"
    };
  }

  return { ok: false, reason: "NO_MAPPABLE_FIELD" };
}

/**
 * Example manual event:
 * One year without salary, no extra income, unchanged monthly spending.
 */
export function createCareerBreakExample() {
  return {
    ...createEmptyHouseholdEvent(),
    title: "休息一年",
    eventType: "income_loss",
    monthlyIncomeDelta: -40000,
    monthlyExpenseDelta: 0,
    oneTimeCashDelta: 0,
    durationMonths: 12,
    assumptions: ["休息期间工资收入减少 40000 元/月"],
    missingFields: [],
    clarificationQuestion: "",
    source: "manual"
  };
}
