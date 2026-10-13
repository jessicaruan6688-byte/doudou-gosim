/**
 * src/domain/decision-receipt-adapter.mjs
 *
 * MINIMAL ADAPTER: real GoSim engine output -> decision-receipt.v2 input.
 *
 * This file exists so the receipt module reads the numbers the EXISTING
 * deterministic engine already produced. It deliberately does NOT:
 *
 *   - run or re-derive any cash-flow simulation
 *   - invent a safety line (it converts the engine's own month-based floor
 *     into the cash unit the receipt compares against, and refuses when the
 *     engine's inputs to that conversion are missing)
 *   - set `confirmed` or `source` on an event. Those two fields are read from
 *     the event the confirm gate produced and echoed unchanged. If the field
 *     is absent or false, the adapter refuses.
 *   - rewrite the engine's summaries. `baseline_path` / `scenario_path` are
 *     copied into the receipt verbatim.
 *
 * ---------------------------------------------------------------------------
 * Verified against the real product source (bundle/main.splash, candidate
 * main.splash = 3534ce03…). Every claim below has a line reference.
 * ---------------------------------------------------------------------------
 *
 * 1) CONFIRMED EVENT — `ev_confirm` (main.splash:2602) returns exactly:
 *      { title, event_type, monthly_income_delta, monthly_expense_delta,
 *        one_time_cash_delta, duration_months, source, confirmed: true }
 *    with `source` = "manual" | "ai_confirmed" and `confirmed` set by the gate
 *    itself (main.splash:2607-2618). NOTHING ELSE in the app writes those two
 *    fields, so echoing them is not a fabrication.
 *    The JS domain layer's `confirmHouseholdEvent()` (household-event.mjs:363)
 *    produces the SAME eight facts in camelCase. This adapter accepts either
 *    spelling and records which one it saw.
 *
 *    GAP (reported, not papered over): the real confirmed event has NO `id`
 *    and NO `confirmedAt`. The receipt contract requires a non-empty
 *    `event.id`. The adapter therefore *derives* a deterministic id and labels
 *    it `eventIdSource: 'derived'`; it never claims it came from the engine.
 *    Pass `allowDerivedEventId: false` to make this a hard error instead.
 *
 * 2) TRACE — `g3_simulate` (main.splash:866) builds `trace` at main.splash:919:
 *      trace.push({ period_index: i, baseline: baseline_trace[i],
 *                   scenario: scenario_trace[i] })
 *    and each row comes from `g3_simulate_path` (main.splash:811 / :852) with
 *    the ten snake_case keys the receipt contract expects. Shape matches 1:1.
 *
 * 3) CONTINUITY — guaranteed by construction, not assumed. Inside
 *    `g3_simulate_path` the row records `opening_cash = cash` and then
 *    `cash = cash + cf + ot`; the next period reads the same variable. So
 *    `row[n+1].opening_cash === row[n].ending_cash` exactly (no float drift,
 *    same value). The receipt's TRACE_DISCONTINUITY guard is therefore a real
 *    alarm, not a false positive. Guarded by a source-drift test.
 *
 * 4) SUMMARIES — `g4_policy_evaluate` (main.splash:1399) returns a new
 *    SimulationResult whose `baseline_path` / `scenario_path` are the tagged
 *    6-key summaries (`g4_tagged_path`, main.splash:1388) and whose `trace` is
 *    passed through untouched. Those tagged summaries are what this adapter
 *    copies into `baselineSummary` / `scenarioSummary`.
 *
 * 5) SAFETY FLOOR — UNIT MISMATCH, handled explicitly. The engine's policy is
 *    expressed in MONTHS: `g8_default_policy` (main.splash:2513) sets
 *    `minimum_buffer_months = household.safety_floor_months` (and
 *    `minimum_cash_after_event: 0` is a DIFFERENT threshold). `breach_month`
 *    is the first period where `buffer_months < safety_floor_months`
 *    (main.splash:848). The receipt compares against CASH
 *    (`endingCash < safetyFloor`). Feeding `safety_floor_months` straight in
 *    would compare ~800000 against 12 and silently never breach, so the
 *    adapter converts with the engine's own identity
 *    `floor_cash = (mortgage + living) * safety_floor_months` — the same
 *    expression the app's own chart uses (main.splash:4638, :4744).
 *
 * 6) `last_decision` — NO CONFLICT with the receipt. `flow_decide`
 *    (main.splash:3055) records a DecisionRecord
 *    `{ decision_id, scenario_id, created_at, user_choice,
 *       snapshot: {cash, buffer_months}, policy_status, ... }`
 *    (domain_DecisionRecord, main.splash:165). That is a different artifact
 *    from a v2 receipt and is left untouched: no line of the decision flow
 *    changes. The one thing worth stating is that a PERSISTED record cannot
 *    rebuild a receipt — it carries no trace — so the receipt must be built
 *    while `state.simulation_result` is still in memory. That is what
 *    `receiptGapsFromDecision()` encodes.
 */

import { createHash } from 'node:crypto';

import {
  buildDecisionReceipt,
  decisionReceiptErrorMessage
} from './decision-receipt.mjs';

import { EVENT_TYPES } from './household-event.mjs';

/** Same set the receipt contract accepts. Kept identical on purpose. */
export const RECEIPT_ALLOWED_SOURCES = Object.freeze(['manual', 'ai_confirmed']);

/** The engine kind the adapter insists on, so a stub cannot slip through. */
const SIMULATION_RESULT_KIND = 'SimulationResult';

export class ReceiptAdapterError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ReceiptAdapterError';
    this.code = code;
    this.detail = detail;
  }
}

function pick(source, camel, snake) {
  if (source[camel] !== undefined) return source[camel];
  return source[snake];
}

/**
 * Deterministic, content-addressed id for an event that has no engine id.
 * It is a LABEL, not an engine identifier, and is reported as such.
 */
export function deriveEventId(event) {
  const material = JSON.stringify([
    event.source,
    event.type,
    event.durationMonths,
    event.monthlyIncomeDelta,
    event.monthlyExpenseDelta,
    event.oneTimeCashDelta
  ]);

  const digest = createHash('sha256')
    .update(material)
    .digest('hex')
    .slice(0, 12);

  return `derived-${event.type}-${digest}`;
}

/**
 * Map the real confirmed event onto the receipt's `event` input.
 *
 * Reads `confirmed` and `source` ONLY. Never writes them.
 *
 * @returns {{event: object, provenance: object}}
 */
export function receiptEventFromConfirmedEvent(
  confirmedEvent,
  { allowDerivedEventId = true } = {}
) {
  if (
    !confirmedEvent ||
    typeof confirmedEvent !== 'object' ||
    Array.isArray(confirmedEvent)
  ) {
    throw new ReceiptAdapterError(
      'EVENT_NOT_CONFIRMED',
      '事件对象缺失或格式不正确，无法证明事件已确认。'
    );
  }

  // Echoed, never assigned.
  if (confirmedEvent.confirmed !== true) {
    throw new ReceiptAdapterError(
      'EVENT_NOT_CONFIRMED',
      '事件未经确认，不生成回执。'
    );
  }

  if (!RECEIPT_ALLOWED_SOURCES.includes(confirmedEvent.source)) {
    throw new ReceiptAdapterError(
      'INVALID_EVENT_SOURCE',
      `事件来源 ${JSON.stringify(confirmedEvent.source)} 不是已确认来源；` +
        '未确认的 AI 草稿（source: "ai"）不能生成回执。'
    );
  }

  const fieldStyle =
    confirmedEvent.eventType !== undefined ? 'camel' : 'snake';

  const type = pick(confirmedEvent, 'eventType', 'event_type');
  if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) {
    throw new ReceiptAdapterError(
      'INVALID_EVENT_TYPE',
      `事件类型 ${JSON.stringify(type)} 不在冻结枚举内。`
    );
  }

  const durationMonths = pick(confirmedEvent, 'durationMonths', 'duration_months');
  if (!Number.isInteger(durationMonths) || durationMonths < 0) {
    throw new ReceiptAdapterError(
      'EVENT_DURATION_UNKNOWN',
      '已确认事件必须带明确期限；期限缺失说明确认门禁尚未通过。'
    );
  }

  const title = typeof confirmedEvent.title === 'string'
    ? confirmedEvent.title.trim()
    : '';

  const engineId = typeof confirmedEvent.id === 'string' && confirmedEvent.id.trim()
    ? confirmedEvent.id.trim()
    : null;

  if (!engineId && !allowDerivedEventId) {
    throw new ReceiptAdapterError(
      'EVENT_ID_UNAVAILABLE',
      '引擎不提供 event.id，且本次调用禁止派生标识。'
    );
  }

  const event = {
    id: engineId ?? deriveEventId({
      source: confirmedEvent.source,
      type,
      durationMonths,
      monthlyIncomeDelta: pick(confirmedEvent, 'monthlyIncomeDelta', 'monthly_income_delta'),
      monthlyExpenseDelta: pick(confirmedEvent, 'monthlyExpenseDelta', 'monthly_expense_delta'),
      oneTimeCashDelta: pick(confirmedEvent, 'oneTimeCashDelta', 'one_time_cash_delta')
    }),
    type,
    title: title || type,
    // read from the input verbatim — the adapter has no way to set them
    source: confirmedEvent.source,
    confirmed: confirmedEvent.confirmed,
    confirmedAt: null
  };

  return {
    event,
    provenance: {
      fieldStyle,
      eventIdSource: engineId ? 'engine' : 'derived',
      eventIdNote: engineId
        ? '取自事件对象自带的 id'
        : '引擎不提供 event.id；该 id 由已确认的事实内容本地派生，不是引擎字段',
      confirmedFromInput: true,
      sourceFromInput: true
    }
  };
}

/**
 * The engine's month-based safety floor, converted into CASH.
 *
 * `(mortgage + living) * safety_floor_months` — the engine's own identity
 * (main.splash:4638 / :4744). Never returns the raw month count.
 */
export function cashSafetyFloorFromHousehold(household) {
  if (!household || typeof household !== 'object') {
    return { safetyFloor: null, reason: 'household_missing' };
  }

  const mortgage = household.mortgage;
  const living = household.living;
  const months = household.safety_floor_months;

  if (!Number.isFinite(mortgage) || !Number.isFinite(living)) {
    return { safetyFloor: null, reason: 'necessary_expense_missing' };
  }

  const necessary = mortgage + living;
  if (necessary <= 0) {
    return { safetyFloor: null, reason: 'necessary_expense_non_positive' };
  }

  if (!Number.isFinite(months)) {
    return { safetyFloor: null, reason: 'safety_floor_months_missing' };
  }

  return {
    safetyFloor: necessary * months,
    reason: 'derived_from_household',
    necessaryExpense: necessary
  };
}

/**
 * Build a v2 receipt from what the engine actually produced.
 *
 * @param {object} input
 * @param {object} input.confirmedEvent      ev_confirm() event (snake or camel)
 * @param {object} input.simulationResult    g4_policy_evaluate() output
 * @param {object|null} [input.household]    for the cash safety floor
 * @param {string|null} [input.scenarioId]
 * @param {string|null} [input.createdAt]
 * @returns {{ok:true, receipt:object, provenance:object} |
 *           {ok:false, code:string, message:string, detail:object|null}}
 */
export function buildReceiptFromEngine({
  confirmedEvent,
  simulationResult,
  household = null,
  scenarioId = null,
  createdAt = null,
  allowDerivedEventId = true
}) {
  try {
    if (
      !simulationResult ||
      typeof simulationResult !== 'object' ||
      simulationResult.kind !== SIMULATION_RESULT_KIND
    ) {
      throw new ReceiptAdapterError(
        'NOT_A_SIMULATION_RESULT',
        '只接受引擎真实产出的 SimulationResult；没有引擎结果时不生成回执。'
      );
    }

    // Two distinct failures, deliberately not collapsed:
    //   absent trace  -> the result never carried one (a persisted record)
    //   empty trace   -> the engine emitted nothing; the module owns that code
    const trace = simulationResult.trace;
    if (trace === undefined || trace === null) {
      throw new ReceiptAdapterError(
        'RECEIPT_REQUIRES_LIVE_SIMULATION',
        '这条记录里没有可核验的 trace（例如持久化的 decisions.json 只存 snapshot），' +
          '回执必须在引擎结果仍在内存时构建。'
      );
    }

    const resolvedScenarioId = scenarioId ?? simulationResult.scenario_id;
    if (typeof resolvedScenarioId !== 'string' || !resolvedScenarioId.trim()) {
      throw new ReceiptAdapterError(
        'MISSING_SCENARIO_ID',
        '引擎结果缺少 scenario_id，无法生成回执。'
      );
    }

    const { event, provenance: eventProvenance } =
      receiptEventFromConfirmedEvent(confirmedEvent, { allowDerivedEventId });

    const floor = cashSafetyFloorFromHousehold(household);

    const receipt = buildDecisionReceipt({
      event,
      trace,
      scenarioId: resolvedScenarioId,
      safetyFloor: floor.safetyFloor,
      // copied verbatim from the engine — the 6-key tagged summaries
      scenarioSummary: simulationResult.scenario_path ?? null,
      baselineSummary: simulationResult.baseline_path ?? null,
      createdAt
    });

    return {
      ok: true,
      receipt,
      provenance: {
        engineSource: 'bundle/main.splash — g3_simulate + g4_policy_evaluate',
        traceSource: 'simulationResult.trace（配对轨迹，原样传入，未加工）',
        cashflowRecomputed: false,
        summariesCopiedVerbatim: true,
        baselineSummaryKeys: Object.keys(simulationResult.baseline_path ?? {}),
        scenarioSummaryKeys: Object.keys(simulationResult.scenario_path ?? {}),
        eventIdSource: eventProvenance.eventIdSource,
        eventIdNote: eventProvenance.eventIdNote,
        eventFieldStyle: eventProvenance.fieldStyle,
        safetyFloor: {
          value: floor.safetyFloor,
          reason: floor.reason,
          unit: 'CNY（现金），不是月数',
          expression: '(mortgage + living) * safety_floor_months',
          source: 'household（引擎 g8_default_policy 的 minimum_buffer_months 换算）'
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? 'UNKNOWN',
      message: error instanceof ReceiptAdapterError
        ? error.message
        : decisionReceiptErrorMessage(error),
      detail: error?.detail ?? null
    };
  }
}

/**
 * Adapt the live view state of the Splash app (g8_view_state) in one call.
 *
 * Reads exactly three existing fields; adds nothing to the app state:
 *   state.ev_confirmed_event   <- written by g8_on_click_ev_confirm (main.splash:2844)
 *   state.simulation_result    <- written by flow_run_scenario_to_result (:2993)
 *   state.household            <- the persisted HouseholdState
 */
export function buildReceiptFromViewState(viewState, options = {}) {
  if (!viewState || typeof viewState !== 'object') {
    return {
      ok: false,
      code: 'NOT_A_VIEW_STATE',
      message: '缺少视图状态，无法读取引擎结果。',
      detail: null
    };
  }

  if (viewState.ev_confirmed_event == null) {
    return {
      ok: false,
      code: 'EVENT_NOT_CONFIRMED',
      message: '当前没有已确认的事件（state.ev_confirmed_event 为空），不生成回执。',
      detail: null
    };
  }

  return buildReceiptFromEngine({
    confirmedEvent: viewState.ev_confirmed_event,
    simulationResult: viewState.simulation_result,
    household: viewState.household,
    scenarioId: viewState.last_scenario_id ?? null,
    ...options
  });
}

/**
 * What a PERSISTED decision record can and cannot supply.
 *
 * Encodes the compatibility finding rather than changing flow_decide(): a
 * DecisionRecord has no trace, so it cannot rebuild a receipt. Nothing in the
 * decision flow needed to change for the receipt to exist.
 */
export function receiptGapsFromDecision(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, code: 'NOT_A_DECISION_RECORD', missing: ['record'] };
  }

  const missing = [];
  if (!('decision_id' in record)) missing.push('decision_id');
  if (!('scenario_id' in record)) missing.push('scenario_id');
  if (!('snapshot' in record)) missing.push('snapshot');

  missing.push('trace', 'ev_confirmed_event', 'household');

  return {
    ok: false,
    code: 'RECEIPT_REQUIRES_LIVE_SIMULATION',
    missing,
    note:
      'DecisionRecord 只有 snapshot{cash, buffer_months}，没有 trace、没有已确认事件、' +
      '没有 household；回执必须在 RESULT 页（引擎结果仍在 state 中）构建。'
  };
}
