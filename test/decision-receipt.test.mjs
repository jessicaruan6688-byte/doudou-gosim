/**
 * test/decision-receipt.test.mjs
 *
 * The reference test suite supplied WITH src/domain/decision-receipt.mjs.
 * Landed verbatim except for ONE line: the import path
 * (`./decision-receipt.mjs` -> `../src/domain/decision-receipt.mjs`) so the
 * file sits in this repo's `test/` directory instead of next to the module.
 * No assertion was changed.
 *
 * This file proves the ISOLATED MODULE only. It says nothing about the GoSim
 * product flow — that is what test/decision-receipt-adapter.test.mjs is for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDecisionReceipt,
} from '../src/domain/decision-receipt.mjs';

const path = (
  opening_cash,
  ending_cash,
  buffer_months
) => ({
  opening_cash,
  income: 40000,
  mortgage_expense: 15000,
  living_expense: 8000,
  expense_adjustment: 0,
  one_time_expense: 0,
  total_expense: 23000,
  net_change: ending_cash - opening_cash,
  ending_cash,
  buffer_months,
});

const trace = [
  {
    period_index: 0,
    baseline: path(800000, 817000, 12),
    scenario: path(800000, 817000, 12),
  },
  {
    period_index: 1,
    baseline: path(817000, 834000, 12.2),
    scenario: path(817000, 700000, 10.2),
  },
  {
    period_index: 2,
    baseline: path(834000, 851000, 12.4),
    scenario: path(700000, 600000, 8.7),
  },
];

const event = {
  id: 'ev-1',
  type: 'income_loss',
  title: '收入中断',
  confirmed: true,
  source: 'manual',
};

test(
  'summarizes paired trace without inventing causality',
  () => {
    const receipt = buildDecisionReceipt({
      event,
      trace,
      scenarioId: 'scenario-1',
      safetyFloor: 650000,
      scenarioSummary: {
        breach_month: 2,
      },
    });

    assert.equal(
      receipt.schemaVersion,
      'decision-receipt.v2'
    );

    assert.equal(
      receipt.outcome.finalCashDeltaVsBaseline,
      -251000
    );

    assert.equal(
      receipt.outcome.firstScenarioBelowSafetyFloorPeriod,
      2
    );

    assert.equal(
      receipt.interpretation.causalClaim,
      false
    );

    assert.equal(
      receipt.outcome.engineSummary.scenario.breach_month,
      2
    );
  }
);

test('refuses unconfirmed event', () => {
  assert.throws(
    () => buildDecisionReceipt({
      event: {
        ...event,
        confirmed: false,
      },
      trace,
      scenarioId: 's',
    }),
    {
      code: 'EVENT_NOT_CONFIRMED',
    }
  );
});

test('refuses discontinuous cash trace', () => {
  const bad = structuredClone(trace);
  bad[2].scenario.opening_cash = 999;

  assert.throws(
    () => buildDecisionReceipt({
      event,
      trace: bad,
      scenarioId: 's',
    }),
    {
      code: 'TRACE_DISCONTINUITY',
    }
  );
});

test('does not infer safety floor if not supplied', () => {
  const receipt = buildDecisionReceipt({
    event,
    trace,
    scenarioId: 's',
  });

  assert.equal(
    receipt.outcome.firstScenarioBelowSafetyFloorPeriod,
    null
  );

  assert.equal(
    receipt.outcome.scenarioBelowSafetyFloorAtEnd,
    null
  );

  assert.equal(
    receipt.evidence.safetyFloorProvided,
    false
  );
});
