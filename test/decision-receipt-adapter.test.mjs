/**
 * test/decision-receipt-adapter.test.mjs
 *
 * Integration tests for the ADAPTER layer between the GoSim engine and
 * decision-receipt.v2.
 *
 * Scope honesty: everything here runs in Node against engine-SHAPED values and
 * against the engine's real SOURCE TEXT (drift guards). It does NOT run
 * bundle/main.splash, so it is NOT a product end-to-end acceptance run. The
 * product UI acceptance for onboarding/simulation lives in the separate UI
 * driver evidence.
 *
 * Real anchors used below, captured from the real app run of 2026-10-13:
 *   household  income 40000 / mortgage 15000 / living 12000 / cash 800000
 *              / safety_floor_months 12          (真实五步建档写入的值)
 *   event      休息一年 · 持续 18 个月 · 每月收入变化 -40000
 *   engine     “预计第 18 个月跌破 12 个月安全底线。” / “期末现金 31.4 万”
 *              / 缓冲 11.6 个月
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ReceiptAdapterError,
  RECEIPT_ALLOWED_SOURCES,
  deriveEventId,
  receiptEventFromConfirmedEvent,
  cashSafetyFloorFromHousehold,
  buildReceiptFromEngine,
  buildReceiptFromViewState,
  receiptGapsFromDecision
} from '../src/domain/decision-receipt-adapter.mjs';

import { EVENT_TYPES } from '../src/domain/household-event.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPLASH = path.resolve(HERE, '..', 'bundle', 'main.splash');
const splashSource = () => readFileSync(SPLASH, 'utf8');

/* ------------------------------------------------------------------ */
/* fixtures — the REAL household from the real onboarding run          */
/* ------------------------------------------------------------------ */

const HOUSEHOLD = Object.freeze({
  schema_version: 2,
  household_id: 'h_main',
  monthly_income: 40000,
  mortgage: 15000,
  living: 12000,
  liquid_cash: 800000,
  safety_floor_months: 12
});

/** (15000 + 12000) */
const NECESSARY = 27000;
/** 27000 * 12 — the engine's cash equivalent of its 12-month floor */
const FLOOR_CASH = 324000;

/**
 * Assemble one engine trace row. Every CASH value is a literal supplied by the
 * caller — this helper never computes a future cash figure, it only fills in
 * the constant expense split the engine records (main.splash:811 / :852).
 */
function engineRow({ period, opening, ending, income }) {
  return {
    period_index: period,
    opening_cash: opening,
    income,
    mortgage_expense: HOUSEHOLD.mortgage,
    living_expense: HOUSEHOLD.living,
    expense_adjustment: 0,
    one_time_expense: 0,
    total_expense: HOUSEHOLD.mortgage + HOUSEHOLD.living,
    net_change: ending - opening,
    ending_cash: ending,
    buffer_months: ending / NECESSARY
  };
}

/** { period_index, baseline, scenario } — the real g3_simulate pairing. */
function paired(period, bOpen, bEnd, sOpen, sEnd) {
  return {
    period_index: period,
    baseline: engineRow({
      period, opening: bOpen, ending: bEnd, income: HOUSEHOLD.monthly_income
    }),
    scenario: engineRow({ period, opening: sOpen, ending: sEnd, income: 0 })
  };
}

/**
 * Six contiguous periods. Scenario drains 100000/month, so it crosses the
 * 324000 floor at period 5 while the baseline never does — a case whose
 * breach period can be checked by hand.
 */
const TRACE = [
  paired(0, 800000, 800000, 800000, 800000),
  paired(1, 800000, 813000, 800000, 700000),
  paired(2, 813000, 826000, 700000, 600000),
  paired(3, 826000, 839000, 600000, 500000),
  paired(4, 839000, 852000, 500000, 400000),
  paired(5, 852000, 865000, 400000, 300000)
];

const ENGINE_BREACH_PERIOD = 5;

/** g4_policy_evaluate output: tagged summaries + the trace passed through. */
function engineResult(overrides = {}) {
  return {
    kind: 'SimulationResult',
    scenario_id: 'sc_rest',
    horizon: 5,
    baseline_path: {
      cash_at_horizon: 865000,
      buffer_at_horizon: 865000 / NECESSARY,
      minimum_cash: 800000,
      minimum_buffer: 800000 / NECESSARY,
      breach_month: null,
      policy_status: 'ok'
    },
    scenario_path: {
      cash_at_horizon: 300000,
      buffer_at_horizon: 300000 / NECESSARY,
      minimum_cash: 300000,
      minimum_buffer: 300000 / NECESSARY,
      breach_month: ENGINE_BREACH_PERIOD,
      policy_status: 'danger'
    },
    delta: {
      cash_delta: 300000 - 865000,
      buffer_delta: (300000 - 865000) / NECESSARY,
      minimum_cash_delta: 300000 - 800000,
      minimum_buffer_delta: (300000 - 800000) / NECESSARY
    },
    trace: TRACE,
    ...overrides
  };
}

/** The real emoji: ev_confirm() emits snake_case (main.splash:2609). */
const SPLASH_EVENT = Object.freeze({
  title: '休息一年',
  event_type: 'income_loss',
  monthly_income_delta: -40000,
  monthly_expense_delta: 0,
  one_time_cash_delta: 0,
  duration_months: 18,
  source: 'manual',
  confirmed: true
});

/** The JS domain twin, confirmHouseholdEvent() output (camelCase). */
const JS_EVENT = Object.freeze({
  schemaVersion: 1,
  id: null,
  title: '休息一年',
  eventType: 'income_loss',
  monthlyIncomeDelta: -40000,
  monthlyExpenseDelta: 0,
  oneTimeCashDelta: 0,
  durationMonths: 18,
  assumptions: [],
  missingFields: [],
  clarificationQuestion: '',
  source: 'manual',
  confirmed: true
});

const build = (over = {}) => buildReceiptFromEngine({
  confirmedEvent: SPLASH_EVENT,
  simulationResult: engineResult(),
  household: HOUSEHOLD,
  scenarioId: 'sc_rest',
  ...over
});

/* ================================================================== */
/* G1 — real trace mapping                                             */
/* ================================================================== */

test('G1a engine-shaped paired trace maps and keeps its endpoints', () => {
  const r = build();
  assert.equal(r.ok, true, JSON.stringify(r));

  const { receipt } = r;

  assert.equal(receipt.schemaVersion, 'decision-receipt.v2');
  assert.equal(receipt.evidence.traceSource, 'g3_simulate paired trace');
  assert.equal(receipt.evidence.periodCount, 6);
  assert.equal(receipt.evidence.startPeriod, 0);
  assert.equal(receipt.evidence.endPeriod, 5);

  assert.equal(receipt.outcome.start.baselineCash, 800000);
  assert.equal(receipt.outcome.start.scenarioCash, 800000);
  assert.equal(receipt.outcome.end.baselineCash, 865000);
  assert.equal(receipt.outcome.end.scenarioCash, 300000);
  assert.equal(receipt.outcome.minimumScenarioCash, 300000);
  assert.equal(receipt.outcome.minimumBaselineCash, 800000);
});

test('G1b snake_case and camelCase confirmed events both map', () => {
  const a = receiptEventFromConfirmedEvent(SPLASH_EVENT);
  const b = receiptEventFromConfirmedEvent(JS_EVENT);

  assert.equal(a.event.type, 'income_loss');
  assert.equal(b.event.type, 'income_loss');
  assert.equal(a.event.title, '休息一年');
  assert.equal(a.provenance.fieldStyle, 'snake');
  assert.equal(b.provenance.fieldStyle, 'camel');
  assert.equal(a.event.source, 'manual');
  assert.equal(a.event.confirmed, true);
});

test('G1c the cash safety floor reproduces the engine breach period', () => {
  const r = build();
  assert.equal(r.ok, true, JSON.stringify(r));

  // The receipt's own "below the floor" search must agree with the engine's
  // breach_month, which is computed independently in g3_simulate_path.
  assert.equal(
    r.receipt.outcome.firstScenarioBelowSafetyFloorPeriod,
    engineResult().scenario_path.breach_month,
    'adapter 的安全线口径必须与引擎 breach_month 一致'
  );
  assert.equal(
    r.receipt.outcome.firstBaselineBelowSafetyFloorPeriod,
    engineResult().baseline_path.breach_month
  );
  assert.equal(r.receipt.outcome.scenarioBelowSafetyFloorAtEnd, true);
  assert.equal(r.receipt.outcome.baselineBelowSafetyFloorAtEnd, false);
});

test('G1d final delta equals the engine delta identity', () => {
  const sim = engineResult();
  const r = buildReceiptFromEngine({
    confirmedEvent: SPLASH_EVENT,
    simulationResult: sim,
    household: HOUSEHOLD,
    scenarioId: 'sc_rest'
  });

  assert.equal(
    r.receipt.outcome.finalCashDeltaVsBaseline,
    sim.delta.cash_delta
  );
});

test('G1e engine summaries are copied verbatim, never recomputed', () => {
  const sim = engineResult();
  const r = buildReceiptFromEngine({
    confirmedEvent: SPLASH_EVENT,
    simulationResult: sim,
    household: HOUSEHOLD,
    scenarioId: 'sc_rest'
  });

  assert.deepEqual(r.receipt.outcome.engineSummary.scenario, sim.scenario_path);
  assert.deepEqual(r.receipt.outcome.engineSummary.baseline, sim.baseline_path);
  assert.equal(r.provenance.cashflowRecomputed, false);
  assert.equal(r.provenance.summariesCopiedVerbatim, true);

  // the real run's observed values survive untouched
  assert.equal(r.receipt.outcome.engineSummary.scenario.breach_month, 5);
  assert.equal(r.receipt.outcome.engineSummary.scenario.policy_status, 'danger');
});

test('G1f the real 18-month run passes through verbatim', () => {
  // Observed in the real app: “预计第 18 个月跌破 12 个月安全底线。”
  const sim = engineResult({
    horizon: 18,
    scenario_path: {
      cash_at_horizon: 314000,
      buffer_at_horizon: 314000 / NECESSARY,
      minimum_cash: 314000,
      minimum_buffer: 314000 / NECESSARY,
      breach_month: 18,
      policy_status: 'danger'
    }
  });

  const r = buildReceiptFromEngine({
    confirmedEvent: SPLASH_EVENT,
    simulationResult: sim,
    household: HOUSEHOLD,
    scenarioId: 'sc_rest',
    createdAt: '2026-10-13T13:37:35Z'
  });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.receipt.outcome.engineSummary.scenario.breach_month, 18);
  assert.equal(r.receipt.createdAt, '2026-10-13T13:37:35Z');
  assert.equal(r.receipt.interpretation.causalClaim, false);
});

/* ================================================================== */
/* G2 — the event is confirmed, and the adapter proves nothing itself   */
/* ================================================================== */

test('G2a an unconfirmed event is refused', () => {
  const r = build({ confirmedEvent: { ...SPLASH_EVENT, confirmed: false } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EVENT_NOT_CONFIRMED');
});

test('G2b an un-confirmed AI draft (source "ai") is refused', () => {
  const draft = { ...SPLASH_EVENT, source: 'ai', confirmed: false };
  assert.equal(build({ confirmedEvent: draft }).code, 'EVENT_NOT_CONFIRMED');

  // even if the boolean were forged, the source gate still holds
  assert.equal(
    build({ confirmedEvent: { ...draft, confirmed: true } }).code,
    'INVALID_EVENT_SOURCE'
  );

  assert.deepEqual([...RECEIPT_ALLOWED_SOURCES], ['manual', 'ai_confirmed']);
});

test('G2c a model-shaped object without confirm fields is refused', () => {
  // the shape a model reply could produce: no confirmed, no source
  const forged = {
    eventType: 'income_loss',
    title: '收入中断',
    monthlyIncomeDelta: -40000,
    monthlyExpenseDelta: null,
    oneTimeCashDelta: null,
    durationMonths: 12,
    assumptions: [],
    missingFields: []
  };

  assert.equal(build({ confirmedEvent: forged }).code, 'EVENT_NOT_CONFIRMED');
});

test('G2d the adapter echoes confirmed/source and never assigns them', () => {
  const before = JSON.stringify(SPLASH_EVENT);
  const { event } = receiptEventFromConfirmedEvent(SPLASH_EVENT);

  assert.equal(event.confirmed, SPLASH_EVENT.confirmed);
  assert.equal(event.source, SPLASH_EVENT.source);
  assert.equal(JSON.stringify(SPLASH_EVENT), before, '输入事件不得被修改');
  assert.equal(event.confirmedAt, null, '不得凭空补出确认时间');

  // ai_confirmed is the only other accepted provenance
  const ai = receiptEventFromConfirmedEvent({
    ...SPLASH_EVENT, source: 'ai_confirmed'
  });
  assert.equal(ai.event.source, 'ai_confirmed');
});

test('G2e the derived event id is labelled, and refuses when disallowed', () => {
  const r = build();
  assert.equal(r.provenance.eventIdSource, 'derived');
  assert.match(r.provenance.eventIdNote, /不是引擎字段/);
  assert.match(r.receipt.event.id, /^derived-income_loss-[0-9a-f]{12}$/);

  // deterministic: same confirmed facts -> same label
  assert.equal(
    deriveEventId({ ...SPLASH_EVENT, event_type: 'income_loss' }),
    deriveEventId(SPLASH_EVENT)
  );

  // and it can be turned into a hard failure instead of a derived value
  assert.equal(
    build({ allowDerivedEventId: false }).code,
    'EVENT_ID_UNAVAILABLE'
  );

  // an engine-provided id, when one exists, wins and is labelled 'engine'
  const withId = receiptEventFromConfirmedEvent({ ...SPLASH_EVENT, id: 'ev_9' });
  assert.equal(withId.event.id, 'ev_9');
  assert.equal(withId.provenance.eventIdSource, 'engine');
});

test('G2f an event type outside the frozen enum is refused', () => {
  assert.equal(
    build({ confirmedEvent: { ...SPLASH_EVENT, event_type: 'car' } }).code,
    'INVALID_EVENT_TYPE'
  );
});

/* ================================================================== */
/* G3 — trace integrity                                                */
/* ================================================================== */

test('G3a a scenario discontinuity is refused', () => {
  const bad = structuredClone(TRACE);
  bad[3].scenario.opening_cash = 999;
  assert.equal(
    build({ simulationResult: engineResult({ trace: bad }) }).code,
    'TRACE_DISCONTINUITY'
  );
});

test('G3b a baseline discontinuity is refused', () => {
  const bad = structuredClone(TRACE);
  bad[2].baseline.ending_cash = 1;
  assert.equal(
    build({ simulationResult: engineResult({ trace: bad }) }).code,
    'TRACE_DISCONTINUITY'
  );
});

test('G3c a non-chronological trace is refused', () => {
  const bad = structuredClone(TRACE);
  bad[4].period_index = 3;
  assert.equal(
    build({ simulationResult: engineResult({ trace: bad }) }).code,
    'TRACE_NOT_CHRONOLOGICAL'
  );
});

test('G3d a missing trace is refused, not invented', () => {
  // absent trace = the result never carried one (a persisted record)
  assert.equal(build({ simulationResult: engineResult({ trace: undefined }) }).code,
    'RECEIPT_REQUIRES_LIVE_SIMULATION');
  assert.equal(build({ simulationResult: engineResult({ trace: null }) }).code,
    'RECEIPT_REQUIRES_LIVE_SIMULATION');
  // empty trace = the engine emitted nothing, and the module says so
  assert.equal(build({ simulationResult: engineResult({ trace: [] }) }).code,
    'EMPTY_TRACE');
});

test('G3e a non-engine result object is refused', () => {
  assert.equal(build({ simulationResult: { trace: TRACE } }).code,
    'NOT_A_SIMULATION_RESULT');
  assert.equal(build({ simulationResult: null }).code,
    'NOT_A_SIMULATION_RESULT');
});

test('G3f a non-finite trace number is refused', () => {
  const bad = structuredClone(TRACE);
  bad[2].scenario.ending_cash = Number.NaN;
  assert.equal(
    build({ simulationResult: engineResult({ trace: bad }) }).code,
    'INVALID_TRACE_NUMBER'
  );
});

/* ================================================================== */
/* G4 — the safety floor is converted, or withheld. Never guessed.     */
/* ================================================================== */

test('G4a the floor is CNY cash, not the raw month count', () => {
  const floor = cashSafetyFloorFromHousehold(HOUSEHOLD);
  assert.equal(floor.safetyFloor, FLOOR_CASH);
  assert.notEqual(floor.safetyFloor, HOUSEHOLD.safety_floor_months);

  const r = build();
  assert.equal(r.provenance.safetyFloor.value, FLOOR_CASH);
  assert.equal(r.provenance.safetyFloor.unit, 'CNY（现金），不是月数');
  assert.equal(r.receipt.evidence.safetyFloorProvided, true);
});

test('G4b with no household the floor is withheld and nothing is guessed', () => {
  const r = build({ household: null });

  assert.equal(r.ok, true);
  assert.equal(r.provenance.safetyFloor.value, null);
  assert.equal(r.provenance.safetyFloor.reason, 'household_missing');
  assert.equal(r.receipt.evidence.safetyFloorProvided, false);

  // null, NOT false — "unknown" must not read as "safe"
  assert.equal(r.receipt.outcome.scenarioBelowSafetyFloorAtEnd, null);
  assert.equal(r.receipt.outcome.baselineBelowSafetyFloorAtEnd, null);
  assert.equal(r.receipt.outcome.firstScenarioBelowSafetyFloorPeriod, null);
  assert.equal(r.receipt.outcome.firstBaselineBelowSafetyFloorPeriod, null);

  // the engine trace is still reported
  assert.equal(r.receipt.outcome.end.scenarioCash, 300000);
});

test('G4c a non-positive necessary expense withholds the floor', () => {
  const floor = cashSafetyFloorFromHousehold({ mortgage: 0, living: 0, safety_floor_months: 12 });
  assert.equal(floor.safetyFloor, null);
  assert.equal(floor.reason, 'necessary_expense_non_positive');
});

test('G4d a missing month count withholds the floor', () => {
  const floor = cashSafetyFloorFromHousehold({ mortgage: 15000, living: 12000 });
  assert.equal(floor.safetyFloor, null);
  assert.equal(floor.reason, 'safety_floor_months_missing');
});

/* ================================================================== */
/* G5 — the existing decision flow is untouched                        */
/* ================================================================== */

test('G5a a persisted decision record cannot rebuild a receipt', () => {
  const record = {
    decision_id: 'd_1',
    scenario_id: 'sc_rest',
    created_at: '2026-10-13T13:37:35Z',
    user_choice: 'defer',
    reason: null,
    snapshot: { cash: 800000, buffer_months: 800000 / NECESSARY },
    policy_status: 'danger',
    review_at: null,
    legacy_migration: false
  };

  const gaps = receiptGapsFromDecision(record);
  assert.equal(gaps.ok, false);
  assert.equal(gaps.code, 'RECEIPT_REQUIRES_LIVE_SIMULATION');
  assert.ok(gaps.missing.includes('trace'));
  assert.ok(gaps.missing.includes('ev_confirmed_event'));
});

test('G5b nothing is mutated, and deep-frozen input still works', () => {
  const sim = engineResult();
  const household = { ...HOUSEHOLD };
  const before = JSON.stringify({ sim, household });

  buildReceiptFromEngine({
    confirmedEvent: SPLASH_EVENT,
    simulationResult: Object.freeze(sim),
    household: Object.freeze(household),
    scenarioId: 'sc_rest'
  });

  assert.equal(JSON.stringify({ sim, household }), before);
  assert.equal(sim.trace.length, 6, 'trace 长度不得变化');
});

test('G5c the live view state path reads only existing fields', () => {
  const state = {
    screen: 'RESULT',
    ev_confirmed_event: SPLASH_EVENT,
    simulation_result: engineResult(),
    household: HOUSEHOLD,
    last_scenario_id: 'sc_rest'
  };

  const r = buildReceiptFromViewState(state);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.receipt.scenarioId, 'sc_rest');

  const none = buildReceiptFromViewState({ ...state, ev_confirmed_event: null });
  assert.equal(none.code, 'EVENT_NOT_CONFIRMED');
  assert.equal(buildReceiptFromViewState(null).code, 'NOT_A_VIEW_STATE');
});

/* ================================================================== */
/* G6 — source drift guards (the engine must still look like this)      */
/* ================================================================== */

test('G6a the engine still emits the trace row keys the module reads', () => {
  const src = splashSource();
  const row = src.match(/trace\.push\(\{ period_index: 0,[^}]*\}\)/);
  assert.ok(row, 'g3_simulate_path 的初始 trace 行不见了');

  for (const key of [
    'opening_cash', 'income', 'mortgage_expense', 'living_expense',
    'expense_adjustment', 'one_time_expense', 'total_expense',
    'net_change', 'ending_cash', 'buffer_months'
  ]) {
    assert.ok(row[0].includes(`${key}:`), `引擎行缺少 ${key}`);
  }
});

test('G6b the engine still pairs baseline/scenario by period_index', () => {
  const src = splashSource();
  assert.match(
    src,
    /trace\.push\(\{\s*period_index:\s*i,\s*baseline:\s*baseline_trace\[i\],\s*scenario:\s*scenario_trace\[i\]\s*\}\)/,
    'g3_simulate 的配对语句变了 —— 模块的 trace 契约需要重新核对'
  );
});

test('G6c continuity is still guaranteed by construction', () => {
  const src = splashSource();
  assert.match(src, /let opening_cash = cash/);
  assert.match(src, /cash = cash \+ cf \+ ot/);
  // opening_cash is sampled BEFORE cash advances, so row[n+1].opening_cash
  // is literally row[n].ending_cash. If that order flips, the receipt's
  // TRACE_DISCONTINUITY check becomes a false alarm.
  const opening = src.indexOf('let opening_cash = cash');
  const advance = src.indexOf('cash = cash + cf + ot');
  assert.ok(opening > 0 && advance > opening, '期初取值必须早于现金推进');
});

test('G6d the safety floor still comes from household.safety_floor_months', () => {
  const src = splashSource();
  assert.match(src, /minimum_buffer_months:\s*household\.safety_floor_months/);
  assert.match(src, /warn_buffer_threshold:\s*household\.safety_floor_months/);
  assert.match(src, /if buffer < safety_floor && breach_month == nil/);
  // the app's own cash-floor identity that the adapter mirrors
  assert.match(src, /\(h\.mortgage \+ h\.living\) \* h\.safety_floor_months/);
});

test('G6e g4 still passes the trace through and tags the summaries', () => {
  const src = splashSource();
  assert.match(src, /baseline_path:\s*g4_tagged_path\(simulation_result\.baseline_path, baseline_status\)/);
  assert.match(src, /scenario_path:\s*g4_tagged_path\(simulation_result\.scenario_path, scenario_status\)/);
  assert.match(src, /trace:\s*simulation_result\.trace/);
  assert.match(src, /cash_delta:\s*scenario_path\.cash_at_horizon - baseline_path\.cash_at_horizon/);
});

test('G6f ev_confirm still writes source+confirmed, and nothing else does', () => {
  const src = splashSource();
  assert.match(src, /if draft\.source == "ai" \{ src = "ai_confirmed" \}/);
  assert.match(src, /source:\s*src,\s*\n\s*confirmed:\s*true/);

  // the two gate values the receipt accepts must stay the two the app emits
  for (const value of RECEIPT_ALLOWED_SOURCES) {
    assert.ok(src.includes(`"${value}"`), `引擎里找不到确认来源 ${value}`);
  }
});

test('G6g the decision record contract is unchanged (regression guard)', () => {
  const src = splashSource();
  const fn = src.match(/fn domain_DecisionRecord\(args\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'domain_DecisionRecord 不见了');

  for (const field of [
    'decision_id', 'scenario_id', 'created_at', 'user_choice',
    'reason', 'snapshot', 'policy_status', 'review_at', 'legacy_migration'
  ]) {
    assert.ok(fn[0].includes(field), `DecisionRecord 缺少 ${field}`);
  }

  // flow_decide still records exactly these, with the same snapshot shape
  assert.match(src, /snapshot:\s*snapshot/);
  assert.match(src, /cash:\s*current_cash,\s*\n\s*buffer_months:\s*current_buffer/);
});

test('G6h the receipt event enum stays anchored to the frozen 7 types', () => {
  const src = splashSource();
  assert.equal(EVENT_TYPES.length, 7);
  assert.equal(SPLASH_EVENT.event_type !== undefined, true);
  assert.ok(EVENT_TYPES.includes(SPLASH_EVENT.event_type));
  assert.match(src, /let EV_TYPES = \[/, 'main.splash 的事件类型枚举不见了');
});

test('G6i the adapter does not call or re-implement the finance engine', () => {
  const raw = readFileSync(
    path.resolve(HERE, '..', 'src', 'domain', 'decision-receipt-adapter.mjs'),
    'utf8'
  );

  // read-only guarantees, stated in code rather than only in a report
  assert.match(raw, /cashflowRecomputed: false/);

  // strip comments, then look for INVOCATIONS (engine names appear in prose /
  // in the provenance label on purpose, so only calls-with-parens count)
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');

  for (const fn of ['g3_simulate', 'g3_scenario_cf_per_month', 'g4_policy_evaluate', 'g3_simulate_path']) {
    assert.ok(!new RegExp(`${fn}\\s*\\(`).test(code), `适配层不得调用 ${fn}`);
  }

  // it must import the receipt module and the frozen event enum, nothing else
  const imports = [...raw.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(
    imports.sort(),
    ['./decision-receipt.mjs', './household-event.mjs', 'node:crypto'].sort()
  );
});

test('G6j ReceiptAdapterError carries a machine code', () => {
  const err = new ReceiptAdapterError('X', 'boom');
  assert.equal(err.code, 'X');
  assert.equal(err.name, 'ReceiptAdapterError');
  assert.ok(err instanceof Error);
});
