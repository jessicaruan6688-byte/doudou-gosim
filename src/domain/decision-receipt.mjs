/**
 * GoSim / 兜兜 — Decision Receipt core v2
 *
 * 输入：引擎已经生成的 paired trace
 * 输出：可核验的决策回执对象
 *
 * 不负责：
 * - 重新运行现金流模拟
 * - 推断没有提供的安全线
 * - 把情景差额说成已证明的因果关系
 */

const ALLOWED_SOURCES = new Set([
  'manual',
  'ai_confirmed',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function finite(value, path) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value)
  ) {
    fail(
      'INVALID_TRACE_NUMBER',
      `${path} must be a finite number`
    );
  }

  return value;
}

function text(value, path) {
  if (
    typeof value !== 'string' ||
    !value.trim()
  ) {
    fail(
      'INVALID_FIELD',
      `${path} must be a non-empty string`
    );
  }

  return value.trim();
}

function nonNegativeInteger(value, path) {
  finite(value, path);

  if (
    !Number.isInteger(value) ||
    value < 0
  ) {
    fail(
      'INVALID_PERIOD',
      `${path} must be a non-negative integer`
    );
  }

  return value;
}

/**
 * 验证事件是否已确认。
 *
 * 注意：
 * 这里的 confirmed/source 是模块的输入契约。
 * 接入真实 App 时，必须由真实事件对象映射，
 * 不能为了通过校验而伪造这两个字段。
 */
function validateEvent(event) {
  if (
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event)
  ) {
    fail(
      'INVALID_EVENT',
      'event must be an object'
    );
  }

  if (event.confirmed !== true) {
    fail(
      'EVENT_NOT_CONFIRMED',
      'Event must be confirmed'
    );
  }

  if (!ALLOWED_SOURCES.has(event.source)) {
    fail(
      'INVALID_EVENT_SOURCE',
      'Event source is not allowed'
    );
  }

  return Object.freeze({
    id: text(String(event.id ?? ''), 'event.id'),

    type: text(
      String(event.type ?? ''),
      'event.type'
    ),

    title:
      typeof event.title === 'string' &&
      event.title.trim()
        ? event.title.trim()
        : String(event.type),

    source: event.source,

    confirmedAt:
      typeof event.confirmedAt === 'string'
        ? event.confirmedAt
        : null,
  });
}

/**
 * 将引擎的 snake_case 轨迹字段映射为
 * 回执使用的 camelCase 字段。
 */
function validatePathRow(row, path) {
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row)
  ) {
    fail(
      'INVALID_TRACE_ROW',
      `${path} must be an object`
    );
  }

  return Object.freeze({
    openingCash: finite(
      row.opening_cash,
      `${path}.opening_cash`
    ),

    income: finite(
      row.income,
      `${path}.income`
    ),

    mortgageExpense: finite(
      row.mortgage_expense,
      `${path}.mortgage_expense`
    ),

    livingExpense: finite(
      row.living_expense,
      `${path}.living_expense`
    ),

    expenseAdjustment: finite(
      row.expense_adjustment,
      `${path}.expense_adjustment`
    ),

    oneTimeExpense: finite(
      row.one_time_expense,
      `${path}.one_time_expense`
    ),

    totalExpense: finite(
      row.total_expense,
      `${path}.total_expense`
    ),

    netChange: finite(
      row.net_change,
      `${path}.net_change`
    ),

    endingCash: finite(
      row.ending_cash,
      `${path}.ending_cash`
    ),

    bufferMonths: finite(
      row.buffer_months,
      `${path}.buffer_months`
    ),
  });
}

/**
 * 验证基准与情景的配对轨迹。
 *
 * 真实引擎结构：
 * {
 *   period_index,
 *   baseline: pathRow,
 *   scenario: pathRow
 * }
 */
function validateTrace(trace) {
  if (
    !Array.isArray(trace) ||
    trace.length === 0
  ) {
    fail(
      'EMPTY_TRACE',
      'trace must contain at least one period'
    );
  }

  const rows = trace.map((item, i) => {
    const path = `trace[${i}]`;

    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      fail(
        'INVALID_TRACE_ROW',
        `${path} must be an object`
      );
    }

    const period = nonNegativeInteger(
      item.period_index,
      `${path}.period_index`
    );

    return Object.freeze({
      period,

      baseline: validatePathRow(
        item.baseline,
        `${path}.baseline`
      ),

      scenario: validatePathRow(
        item.scenario,
        `${path}.scenario`
      ),
    });
  });

  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];

    if (current.period <= previous.period) {
      fail(
        'TRACE_NOT_CHRONOLOGICAL',
        'period_index must be strictly increasing'
      );
    }

    if (
      current.baseline.openingCash !==
      previous.baseline.endingCash
    ) {
      fail(
        'TRACE_DISCONTINUITY',
        `baseline cash path discontinuity at period ${current.period}`
      );
    }

    if (
      current.scenario.openingCash !==
      previous.scenario.endingCash
    ) {
      fail(
        'TRACE_DISCONTINUITY',
        `scenario cash path discontinuity at period ${current.period}`
      );
    }
  }

  return rows;
}

/**
 * 找出首次低于明确提供的安全线的期数。
 * 未提供安全线时，绝不自行猜测。
 */
function firstBelow(rows, field, threshold) {
  if (
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold)
  ) {
    return null;
  }

  return (
    rows.find(
      row => row[field].endingCash < threshold
    )?.period ?? null
  );
}

/**
 * 生成决策回执。
 *
 * safetyFloor:
 *   必须由调用方明确提供。
 *
 * scenarioSummary / baselineSummary:
 *   引擎已有摘要，只复制，不重新计算。
 */
export function buildDecisionReceipt({
  event,
  trace,
  scenarioId,
  safetyFloor = null,
  scenarioSummary = null,
  baselineSummary = null,
  createdAt = null,
}) {
  const confirmedEvent = validateEvent(event);
  const rows = validateTrace(trace);

  const id = text(
    String(scenarioId ?? ''),
    'scenarioId'
  );

  if (safetyFloor !== null) {
    finite(safetyFloor, 'safetyFloor');
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  const finalDelta =
    last.scenario.endingCash -
    last.baseline.endingCash;

  const minimumScenarioCash = Math.min(
    ...rows.map(row => row.scenario.endingCash)
  );

  const minimumBaselineCash = Math.min(
    ...rows.map(row => row.baseline.endingCash)
  );

  const scenarioBelow =
    safetyFloor === null
      ? null
      : last.scenario.endingCash < safetyFloor;

  const baselineBelow =
    safetyFloor === null
      ? null
      : last.baseline.endingCash < safetyFloor;

  return Object.freeze({
    schemaVersion: 'decision-receipt.v2',

    scenarioId: id,

    createdAt:
      typeof createdAt === 'string'
        ? createdAt
        : null,

    event: confirmedEvent,

    evidence: Object.freeze({
      traceSource: 'g3_simulate paired trace',
      periodCount: rows.length,
      startPeriod: first.period,
      endPeriod: last.period,
      safetyFloorProvided: safetyFloor !== null,
    }),

    outcome: Object.freeze({
      start: Object.freeze({
        period: first.period,

        baselineCash:
          first.baseline.endingCash,

        scenarioCash:
          first.scenario.endingCash,

        baselineBufferMonths:
          first.baseline.bufferMonths,

        scenarioBufferMonths:
          first.scenario.bufferMonths,
      }),

      end: Object.freeze({
        period: last.period,

        baselineCash:
          last.baseline.endingCash,

        scenarioCash:
          last.scenario.endingCash,

        baselineBufferMonths:
          last.baseline.bufferMonths,

        scenarioBufferMonths:
          last.scenario.bufferMonths,
      }),

      finalCashDeltaVsBaseline: finalDelta,

      minimumScenarioCash,
      minimumBaselineCash,

      firstScenarioBelowSafetyFloorPeriod:
        safetyFloor === null
          ? null
          : firstBelow(
              rows,
              'scenario',
              safetyFloor
            ),

      firstBaselineBelowSafetyFloorPeriod:
        safetyFloor === null
          ? null
          : firstBelow(
              rows,
              'baseline',
              safetyFloor
            ),

      scenarioBelowSafetyFloorAtEnd:
        scenarioBelow,

      baselineBelowSafetyFloorAtEnd:
        baselineBelow,

      engineSummary: Object.freeze({
        scenario:
          scenarioSummary &&
          typeof scenarioSummary === 'object'
            ? { ...scenarioSummary }
            : null,

        baseline:
          baselineSummary &&
          typeof baselineSummary === 'object'
            ? { ...baselineSummary }
            : null,
      }),
    }),

    interpretation: Object.freeze({
      kind: 'paired_trace_summary',

      causalClaim: false,

      note:
        '本回执汇总引擎已生成的基准与情景轨迹；' +
        '差额不等于已证明的单一事件因果效应。',
    }),
  });
}

/**
 * 将内部错误代码映射为用户可读提示。
 */
export function decisionReceiptErrorMessage(error) {
  const messages = {
    EVENT_NOT_CONFIRMED:
      '请先确认这项生活事件，再查看决策回执。',

    INVALID_EVENT_SOURCE:
      '事件来源无效，请重新确认事件。',

    EMPTY_TRACE:
      '当前没有可核验的模拟轨迹，暂时无法生成回执。',

    TRACE_NOT_CHRONOLOGICAL:
      '模拟记录的期数顺序异常，请重新计算。',

    TRACE_DISCONTINUITY:
      '现金流轨迹不连续，暂时无法生成可信回执。',

    INVALID_TRACE_NUMBER:
      '模拟记录包含无效数值，请重新计算。',
  };

  return (
    messages[error?.code] ??
    '暂时无法生成决策回执，请检查输入与模拟记录。'
  );
}
