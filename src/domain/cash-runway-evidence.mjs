/**
 * src/domain/cash-runway-evidence.mjs
 *
 * Transparent, deterministic arithmetic for the evidence page.
 * This does NOT replace the production forecast engine.
 *
 * Contract source: ChatGPT core module #3 (cash-runway-evidence). Landed as
 * given, plus `crossCheckAgainstProduction()` which compares these simplified
 * numbers with the production engine's own output, so the app can show a
 * match/mismatch verdict instead of two disconnected number sets.
 */

function requireFinite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数字`);
  }
}

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function money(value) {
  return Math.round(value);
}

export function calculateCashRunwayEvidence({
  liquidCash,
  monthlyIncome,
  monthlyEssentialExpense,
  horizonMonths,
  event = null
}) {
  requireFinite("liquidCash", liquidCash);
  requireFinite("monthlyIncome", monthlyIncome);
  requireFinite("monthlyEssentialExpense", monthlyEssentialExpense);
  requireFinite("horizonMonths", horizonMonths);

  if (liquidCash < 0) throw new RangeError("流动现金不能为负数");
  if (monthlyIncome < 0) throw new RangeError("月收入不能为负数");
  if (monthlyEssentialExpense <= 0) {
    throw new RangeError("必要月支出必须大于 0");
  }
  if (!Number.isInteger(horizonMonths) ||
      horizonMonths < 0 || horizonMonths > 600) {
    throw new RangeError("模拟月份必须是 0–600 的整数");
  }

  const baseMonthlyNet = monthlyIncome - monthlyEssentialExpense;

  const monthlyIncomeDelta = event?.monthlyIncomeDelta ?? 0;
  const monthlyExpenseDelta = event?.monthlyExpenseDelta ?? 0;
  const oneTimeCashDelta = event?.oneTimeCashDelta ?? 0;
  const duration = event?.durationMonths ?? 0;

  for (const [name, value] of Object.entries({
    monthlyIncomeDelta,
    monthlyExpenseDelta,
    oneTimeCashDelta
  })) {
    requireFinite(name, value);
  }

  if (!Number.isInteger(duration) || duration < 0 || duration > 600) {
    throw new RangeError("事件持续时间必须是 0–600 的整数");
  }

  // A duration of 0 means a one-off cash event only.
  const activeMonths = Math.min(horizonMonths, duration);
  const eventMonthlyNet = monthlyIncomeDelta - monthlyExpenseDelta;

  const baseCashAtHorizon =
    liquidCash + horizonMonths * baseMonthlyNet;

  const eventCashAtHorizon =
    liquidCash +
    horizonMonths * baseMonthlyNet +
    activeMonths * eventMonthlyNet +
    oneTimeCashDelta;

  const baseCoverageMonths =
    liquidCash / monthlyEssentialExpense;

  const baseHorizonCoverageMonths =
    baseCashAtHorizon / monthlyEssentialExpense;

  const eventHorizonCoverageMonths =
    eventCashAtHorizon / monthlyEssentialExpense;

  return {
    inputs: {
      liquidCash: money(liquidCash),
      monthlyIncome: money(monthlyIncome),
      monthlyEssentialExpense: money(monthlyEssentialExpense),
      horizonMonths,
      event: event ? {
        monthlyIncomeDelta: money(monthlyIncomeDelta),
        monthlyExpenseDelta: money(monthlyExpenseDelta),
        oneTimeCashDelta: money(oneTimeCashDelta),
        durationMonths: duration
      } : null
    },
    formulas: {
      baseMonthlyNet:
        "月收入 - 必要月支出",
      currentCoverage:
        "流动现金 ÷ 必要月支出",
      baseCashAtHorizon:
        "流动现金 + 模拟月数 × (月收入 - 必要月支出)",
      eventCashAtHorizon:
        "基准期末现金 + 事件有效月数 × (收入变化 - 支出变化) + 一次性现金变化",
      eventCoverage:
        "事件情景期末现金 ÷ 必要月支出"
    },
    intermediate: {
      baseMonthlyNet: money(baseMonthlyNet),
      eventMonthlyNet: money(eventMonthlyNet),
      activeMonths,
      baseCashAtHorizon: money(baseCashAtHorizon),
      eventCashAtHorizon: money(eventCashAtHorizon)
    },
    results: {
      currentCoverageMonths: round1(baseCoverageMonths),
      baseHorizonCoverageMonths: round1(baseHorizonCoverageMonths),
      eventHorizonCoverageMonths: round1(eventHorizonCoverageMonths),
      eventVsBaseCashDelta: money(eventCashAtHorizon - baseCashAtHorizon)
    },
    warnings: [
      ...(baseCashAtHorizon < 0 ? ["基准情景期末现金为负"] : []),
      ...(eventCashAtHorizon < 0 ? ["事件情景期末现金为负"] : []),
      "本结果为简化现金覆盖演示，不包含资产变现、投资收益、通胀、税费或未录入的现金流。",
      "正式产品结果必须以现有生产计算引擎为准。"
    ]
  };
}

/**
 * Compare the evidence numbers with the production engine's own output.
 *
 * `production` is the shape the app already stores on the RESULT screen:
 *   { currentCoverageMonths, baselineCoverageMonths, scenarioCoverageMonths }
 * (baseline = 第 N 个月基准期末值, scenario = 第 N 个月事件期末值)
 *
 * Tolerance is 0.05 months — the app displays one decimal.
 */
export function crossCheckAgainstProduction(evidence, production) {
  const pairs = [
    ["currentCoverageMonths", "currentCoverageMonths"],
    ["baseHorizonCoverageMonths", "baselineCoverageMonths"],
    ["eventHorizonCoverageMonths", "scenarioCoverageMonths"]
  ];
  const rows = pairs.map(([evKey, prodKey]) => {
    const a = evidence.results[evKey];
    const b = production[prodKey];
    if (typeof b !== "number" || !Number.isFinite(b)) {
      return { metric: evKey, evidence: a, production: null, match: null };
    }
    return { metric: evKey, evidence: a, production: b, match: Math.abs(a - b) <= 0.05 };
  });
  return {
    rows,
    verdict: rows.every(r => r.match !== false) ? "match" : "mismatch",
    note: "证据页为简化手算演示；一致时说明手算与生产引擎口径相同。"
  };
}

export function buildHandCalculationExample() {
  return calculateCashRunwayEvidence({
    liquidCash: 800000,
    monthlyIncome: 40000,
    monthlyEssentialExpense: 27000,
    horizonMonths: 18,
    event: {
      monthlyIncomeDelta: -40000,
      monthlyExpenseDelta: 0,
      oneTimeCashDelta: 0,
      durationMonths: 18
    }
  });
}
