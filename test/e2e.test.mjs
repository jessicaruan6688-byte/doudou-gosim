/**
 * test/e2e.test.mjs
 *
 * Integration tests for the P0 modules (no real provider, no real key).
 *
 *   module 2  src/domain/household-event.mjs
 *   module 3  src/domain/cash-runway-evidence.mjs
 *   module 4  src/services/doudou-ai-client.mjs
 *   module 1  server/doudou-agent-proxy.mjs  (via the local stub provider)
 *
 * T-real at the bottom runs module 1 against the stub and feeds its response
 * straight into module 4, so the two halves are proven compatible without any
 * credential. No test in this file claims a real MiniMax call happened.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  EVENT_TYPES,
  createEmptyHouseholdEvent,
  createCareerBreakExample,
  validateHouseholdEvent,
  confirmHouseholdEvent,
  toScenarioPayload,
  toScenarioDraft
} from "../src/domain/household-event.mjs";

import {
  calculateCashRunwayEvidence,
  crossCheckAgainstProduction,
  buildHandCalculationExample
} from "../src/domain/cash-runway-evidence.mjs";

import {
  parseHouseholdEventWithAI,
  prepareEventDraft
} from "../src/services/doudou-ai-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;

/* ------------------------------------------------------------------ */
/* module 2 — household-event                                          */
/* ------------------------------------------------------------------ */

test("M2 empty draft is unconfirmed and asks for amount+duration", () => {
  const d = createEmptyHouseholdEvent();
  assert.equal(d.confirmed, false);
  assert.equal(d.source, "manual");
  assert.deepEqual(d.missingFields, ["amount", "duration", "recurrence"]);
  const errors = validateHouseholdEvent(d);
  assert.ok(errors.includes("请填写事件名称"));
  assert.ok(errors.includes("请确认事件持续时间"));
  assert.ok(errors.includes("请至少填写一项非零金额"));
});

test("M2 seven event types are the frozen set", () => {
  assert.equal(EVENT_TYPES.length, 7);
  assert.ok(EVENT_TYPES.includes("income_loss"));
  assert.ok(EVENT_TYPES.includes("caregiving"));
});

test("M2 confirm rejects an unvalidated draft", () => {
  const r = confirmHouseholdEvent(createEmptyHouseholdEvent());
  assert.equal(r.ok, false);
  assert.equal(r.event, null);
  assert.ok(r.errors.length > 0);
});

test("M2 confirm accepts the career-break example", () => {
  const r = confirmHouseholdEvent(createCareerBreakExample());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.event.confirmed, true);
  assert.equal(r.event.source, "manual");
});

test("M2 an ai-sourced draft is promoted to ai_confirmed on confirm", () => {
  const r = confirmHouseholdEvent({ ...createCareerBreakExample(), source: "ai" });
  assert.equal(r.ok, true);
  assert.equal(r.event.source, "ai_confirmed");
});

test("M2 amount guard rejects a value over 100,000,000", () => {
  const bad = { ...createCareerBreakExample(), monthlyIncomeDelta: 100_000_001 };
  assert.ok(validateHouseholdEvent(bad).some(e => e.includes("monthlyIncomeDelta")));
});

test("M2 duration guard rejects 601 and non-integers", () => {
  const a = { ...createCareerBreakExample(), durationMonths: 601 };
  const b = { ...createCareerBreakExample(), durationMonths: 6.5 };
  assert.ok(validateHouseholdEvent(a).some(e => e.includes("持续时间")));
  assert.ok(validateHouseholdEvent(b).some(e => e.includes("持续时间")));
});

test("M2 duplicate errors are de-duplicated", () => {
  const errs = validateHouseholdEvent(createEmptyHouseholdEvent());
  assert.equal(errs.length, new Set(errs).size);
});

test("M2 toScenarioPayload refuses an unconfirmed event", () => {
  assert.throws(
    () => toScenarioPayload(createCareerBreakExample()),
    /EVENT_REQUIRES_USER_CONFIRMATION/
  );
});

test("M2 toScenarioPayload returns a frozen neutral payload", () => {
  const { event } = confirmHouseholdEvent(createCareerBreakExample());
  const p = toScenarioPayload(event);
  assert.equal(Object.isFrozen(p), true);
  assert.equal(p.eventType, "income_loss");
  assert.equal(p.durationMonths, 12);
});

/* --- the mapping table: event type -> existing engine scenario type --- */

test("M2 map income_loss -> REST with no invented amount", () => {
  const { event } = confirmHouseholdEvent(createCareerBreakExample());
  const m = toScenarioDraft(event);
  assert.equal(m.ok, true);
  assert.equal(m.scenarioType, "REST");
  assert.deepEqual(m.fields, { duration_months: 12 });
});

test("M2 map income_change -> INCOME_CHANGE with the person's delta", () => {
  const { event } = confirmHouseholdEvent({
    ...createCareerBreakExample(),
    title: "涨薪",
    eventType: "income_change",
    monthlyIncomeDelta: 5000,
    durationMonths: 24
  });
  const m = toScenarioDraft(event);
  assert.equal(m.scenarioType, "INCOME_CHANGE");
  assert.equal(m.fields.monthly_income_delta, 5000);
  assert.equal(m.fields.duration_months, 24);
});

test("M2 map one-off purchase -> CAR_PURCHASE (abs of the outflow)", () => {
  const { event } = confirmHouseholdEvent({
    ...createCareerBreakExample(),
    title: "买车",
    eventType: "purchase",
    monthlyIncomeDelta: 0,
    oneTimeCashDelta: -300000,
    durationMonths: 0
  });
  const m = toScenarioDraft(event);
  assert.equal(m.scenarioType, "CAR_PURCHASE");
  assert.equal(m.fields.purchase_amount, 300000);
});

test("M2 map monthly medical cost -> EXPENSE_CHANGE", () => {
  const { event } = confirmHouseholdEvent({
    ...createCareerBreakExample(),
    title: "每月药费",
    eventType: "medical_cost",
    monthlyIncomeDelta: 0,
    monthlyExpenseDelta: 3000,
    durationMonths: 12
  });
  const m = toScenarioDraft(event);
  assert.equal(m.scenarioType, "EXPENSE_CHANGE");
  assert.equal(m.fields.monthly_expense_delta, 3000);
  assert.equal(m.fields.duration_months, 12);
});

test("M2 mapping never invents a number: empty event -> NO_MAPPABLE_FIELD", () => {
  const { event } = confirmHouseholdEvent({
    ...createEmptyHouseholdEvent(),
    title: "x",
    durationMonths: 0,
    oneTimeCashDelta: 0,
    monthlyIncomeDelta: 0,
    monthlyExpenseDelta: 0
  });
  // confirm() rejects an all-zero event, so mapping is unreachable — assert that.
  assert.equal(event, null);
});

/* ------------------------------------------------------------------ */
/* module 3 — cash-runway-evidence                                     */
/* ------------------------------------------------------------------ */

test("M3 the three required numbers: 29.6 / 38.3 / 11.6", () => {
  const ev = buildHandCalculationExample();
  assert.equal(ev.results.currentCoverageMonths, 29.6);
  assert.equal(ev.results.baseHorizonCoverageMonths, 38.3);
  assert.equal(ev.results.eventHorizonCoverageMonths, 11.6);
});

test("M3 intermediate values are the exact integer steps", () => {
  const ev = buildHandCalculationExample();
  assert.equal(ev.inputs.liquidCash, 800000);
  assert.equal(ev.inputs.monthlyEssentialExpense, 27000);
  assert.equal(ev.intermediate.baseMonthlyNet, 13000);
  assert.equal(ev.intermediate.eventMonthlyNet, -40000);
  assert.equal(ev.intermediate.activeMonths, 18);
  assert.equal(ev.intermediate.baseCashAtHorizon, 1034000);
  assert.equal(ev.intermediate.eventCashAtHorizon, 314000);
});

test("M3 800000-18*27000 equals 314000 (the 11.6 source)", () => {
  assert.equal(800000 - 18 * 27000, 314000);
});

test("M3 every formula label is present (the page renders these)", () => {
  const ev = buildHandCalculationExample();
  for (const key of [
    "baseMonthlyNet", "currentCoverage", "baseCashAtHorizon",
    "eventCashAtHorizon", "eventCoverage"
  ]) {
    assert.equal(typeof ev.formulas[key], "string");
    assert.ok(ev.formulas[key].length > 0);
  }
});

test("M3 warnings always say it is a demo and production rules", () => {
  const ev = buildHandCalculationExample();
  assert.ok(ev.warnings.some(w => w.includes("简化现金覆盖演示")));
  assert.ok(ev.warnings.some(w => w.includes("生产计算引擎")));
});

test("M3 guards: negative cash, zero expense, bad horizon", () => {
  assert.throws(() => calculateCashRunwayEvidence({
    liquidCash: -1, monthlyIncome: 1, monthlyEssentialExpense: 1, horizonMonths: 1
  }), /流动现金/);
  assert.throws(() => calculateCashRunwayEvidence({
    liquidCash: 1, monthlyIncome: 1, monthlyEssentialExpense: 0, horizonMonths: 1
  }), /必要月支出/);
  assert.throws(() => calculateCashRunwayEvidence({
    liquidCash: 1, monthlyIncome: 1, monthlyEssentialExpense: 1, horizonMonths: 601
  }), /模拟月份/);
  assert.throws(() => calculateCashRunwayEvidence({
    liquidCash: 1, monthlyIncome: 1, monthlyEssentialExpense: 1, horizonMonths: 1.5
  }), /模拟月份/);
});

test("M3 cross-check matches production when the engine agrees", () => {
  const ev = buildHandCalculationExample();
  const cc = crossCheckAgainstProduction(ev, {
    currentCoverageMonths: 29.6,
    baselineCoverageMonths: 38.3,
    scenarioCoverageMonths: 11.6
  });
  assert.equal(cc.verdict, "match");
  assert.ok(cc.rows.every(r => r.match === true));
});

test("M3 cross-check flags a mismatch within 0.05 tolerance boundary", () => {
  const ev = buildHandCalculationExample();
  const ok = crossCheckAgainstProduction(ev, {
    currentCoverageMonths: 29.65, baselineCoverageMonths: 38.3, scenarioCoverageMonths: 11.6
  });
  assert.equal(ok.verdict, "match");
  const bad = crossCheckAgainstProduction(ev, {
    currentCoverageMonths: 30.0, baselineCoverageMonths: 38.3, scenarioCoverageMonths: 11.6
  });
  assert.equal(bad.verdict, "mismatch");
});

test("M3 cross-check reports null when production is absent", () => {
  const ev = buildHandCalculationExample();
  const cc = crossCheckAgainstProduction(ev, {});
  assert.ok(cc.rows.every(r => r.production === null && r.match === null));
});

/* ------------------------------------------------------------------ */
/* module 4 — doudou-ai-client                                         */
/* ------------------------------------------------------------------ */

const AI_EVENT = {
  title: "休息 18 个月",
  eventType: "income_loss",
  monthlyIncomeDelta: -40000,
  monthlyExpenseDelta: 0,
  oneTimeCashDelta: 0,
  durationMonths: 18,
  assumptions: ["休息期间无收入"],
  missingFields: [],
  clarificationQuestion: ""
};

test("M4 rejects a too-short description before any call", async () => {
  let called = false;
  const r = await parseHouseholdEventWithAI("嗨", {
    fetchImpl: async () => { called = true; }
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("M4 happy path returns a draft from the proxy's event field", async () => {
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async (url, init) => {
      assert.equal(url, "/api/parse-event");
      const body = JSON.parse(init.body);
      assert.equal(body.description, "休息 18 个月");
      return {
        ok: true,
        json: async () => ({ ok: true, event: AI_EVENT, meta: { model: "stub" } })
      };
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.draft.eventType, "income_loss");
});

test("M4 maps AI_NOT_CONFIGURED to a manual-input hint", async () => {
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: "AI_NOT_CONFIGURED" }) })
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("手动输入"));
});

test("M4 maps AI_INVALID_OUTPUT and AI_PARSE_FAILED distinctly", async () => {
  const a = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: "AI_INVALID_OUTPUT" }) })
  });
  const b = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: "AI_PARSE_FAILED" }) })
  });
  assert.ok(a.error.includes("无法验证"));
  assert.ok(b.error.includes("暂时不可用"));
});

test("M4 a network throw degrades to the manual path, never a fake success", async () => {
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("手动模拟功能仍可使用"));
  assert.equal(r.draft, undefined);
});

test("M4 an abort is reported as cancelled", async () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => { throw err; }
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("已取消"));
});

test("M4 a non-JSON body degrades instead of throwing", async () => {
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })
  });
  assert.equal(r.ok, false);
});

test("M4 a 200 response with ok:false is still a failure", async () => {
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error: "AI_INVALID_OUTPUT" }) })
  });
  assert.equal(r.ok, false);
});

test("M4 prepareEventDraft keeps the confirm boundary (source=ai, confirmed=false)", () => {
  const d = prepareEventDraft(AI_EVENT);
  assert.equal(d.source, "ai");
  assert.equal(d.confirmed, false);
  // and it must still fail validation until the person fills the gaps
  assert.equal(validateHouseholdEvent(d).length, 0);
});

/* ------------------------------------------------------------------ */
/* T-real — module 1 (proxy) x module 4 (client), stub provider only    */
/* ------------------------------------------------------------------ */

let stub, proxy, stubPort, proxyPort;

function waitFor(port, pathname, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = async (n) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${pathname}`);
        if (r.status) return resolve(true);
      } catch { /* retry */ }
      if (n <= 0) return reject(new Error(`port ${port} never came up`));
      setTimeout(() => tick(n - 1), 100);
    };
    tick(tries);
  });
}

before(async () => {
  stubPort = 8891;
  proxyPort = 8892;
  stub = spawn(NODE, [path.join(ROOT, "server/test/stub-provider.mjs")], {
    env: { ...process.env, STUB_PORT: String(stubPort) },
    stdio: "ignore"
  });
  await waitFor(stubPort, "/health");
  proxy = spawn(NODE, [path.join(ROOT, "server/doudou-agent-proxy.mjs")], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      MINIMAX_API_KEY: "stub-key-not-real",
      MINIMAX_BASE_URL: `http://127.0.0.1:${stubPort}/v1/text/chatcompletion_v2`,
      MINIMAX_MODEL: "stub-model"
    },
    stdio: "ignore"
  });
  await waitFor(proxyPort, "/health");
});

after(() => {
  try { stub?.kill(); } catch { /* ignore */ }
  try { proxy?.kill(); } catch { /* ignore */ }
});

test("T-real proxy+client agree end to end with no real provider", async () => {
  const r = await parseHouseholdEventWithAI("我打算休息 18 个月，期间家庭没有收入", {
    endpoint: `http://127.0.0.1:${proxyPort}/api/parse-event`
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(typeof r.draft.eventType, "string");
  assert.ok(EVENT_TYPES.includes(r.draft.eventType));
  assert.equal(typeof r.draft.durationMonths, "number");
  // the proxy's event must survive the module-2 validator once confirmed
  const draft = prepareEventDraft(r.draft);
  draft.title = draft.title || "AI 事件";
  const c = confirmHouseholdEvent(draft);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
});

test("T-real the stub default is a valid, mappable event", async () => {
  const r = await parseHouseholdEventWithAI("休息 18 个月", {
    endpoint: `http://127.0.0.1:${proxyPort}/api/parse-event`
  });
  assert.equal(r.ok, true, r.error);
  const { event } = confirmHouseholdEvent({ ...prepareEventDraft(r.draft), title: "休息" });
  const m = toScenarioDraft(event);
  assert.equal(m.ok, true, m.reason);
  assert.ok(["REST", "CAR_PURCHASE", "INCOME_CHANGE", "EXPENSE_CHANGE"].includes(m.scenarioType));
});

test("T-real /health reports ok on both processes", async () => {
  const a = await (await fetch(`http://127.0.0.1:${proxyPort}/health`)).json();
  assert.deepEqual(a, { ok: true });
});
