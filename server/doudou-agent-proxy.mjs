import { createServer } from "node:http";

import {
  EVENT_TYPES,
  RECURRING_EVENT_TYPES,
  validateEventDraft
} from "../src/domain/household-event.mjs";

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.MINIMAX_API_KEY;
const API_URL = process.env.MINIMAX_BASE_URL;
const MODEL = process.env.MINIMAX_MODEL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

// The event-type list used to be a second literal copy here. It now comes from
// src/domain/household-event.mjs so the enum cannot drift between the proxy,
// the domain layer and the Splash app (test/contract.test.mjs guards the third).

const SYSTEM_PROMPT = `
你是兜兜家庭现金流模拟器的事件解析模块，不是财务计算器。
根据用户描述，只返回一个 JSON 对象，不要输出 Markdown。

字段：
{
  "title": "事件标题",
  "eventType": "income_loss|income_change|purchase|medical_cost|education_cost|caregiving|other",
  "monthlyIncomeDelta": null,
  "monthlyExpenseDelta": null,
  "oneTimeCashDelta": null,
  "durationMonths": null,
  "assumptions": [],
  "missingFields": [],
  "clarificationQuestion": ""
}

规则：
1. 所有金额单位为人民币元。
2. 每月收入变化：增加为正，减少为负。
3. 每月支出变化：增加为正，减少为负。
4. 一次性现金变化：流入为正，流出为负。
5. 未知金额或持续时间必须填 null，不得猜测。
6. missingFields 只能包含 amount、duration、recurrence。
7. 一次性事件的 durationMonths 为 0。
8. 不计算现金覆盖月数、不判定风险、不生成财务预测。
9. 如果信息不完整，写明需要用户确认的问题。
10. 只返回 JSON。
`;

function reply(res, status, data) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (ALLOWED_ORIGIN) {
    headers["access-control-allow-origin"] = ALLOWED_ORIGIN;
    headers["vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

/**
 * Adapter over the shared wire validator, preserving this proxy's existing
 * HTTP error contract. Previously a third hand-written copy of the rules lived
 * here, which could drift from the domain layer and did not reject unknown keys.
 *
 * Returns the legacy code string, or null when the event is acceptable.
 */
const LEGACY_CODES = [
  ["event_type_not_allowed", "INVALID_EVENT_TYPE"],
  ["title_required", "INVALID_TITLE"],
  ["amount_out_of_range", "INVALID_AMOUNT"],
  ["invalid_number", "INVALID_AMOUNT"],
  ["invalid_duration", "INVALID_DURATION"],
  ["recurring_event_requires_valid_duration", "INVALID_DURATION"],
  ["assumptions_must_be_string_array", "INVALID_ASSUMPTIONS"],
  ["missing_fields_must_be_string_array", "INVALID_MISSING_FIELDS"],
  ["invalid_missing_field", "INVALID_MISSING_FIELDS"],
  ["missing_fields_understated", "INVALID_MISSING_FIELDS"],
  ["invalid_clarification_question", "INVALID_CLARIFICATION"],
  ["unexpected_field", "UNEXPECTED_FIELD"],
  ["draft_must_be_object", "NOT_OBJECT"]
];

function validateEvent(e) {
  const { errors } = validateEventDraft(e, {
    allowedEventTypes: EVENT_TYPES,
    recurringEventTypes: RECURRING_EVENT_TYPES,
    // A reply that is merely incomplete is a normal, useful answer here: the
    // UI prompts the person. Completeness is enforced at confirm time.
    requireComplete: false
  });

  if (errors.length === 0) return null;

  // Report the most structural problem first, and log the rest.
  for (const [code, legacy] of LEGACY_CODES) {
    if (errors.some((err) => err === code || err.startsWith(`${code}:`))) {
      console.error("Rejected model event:", errors.join(", ").slice(0, 120));
      return legacy;
    }
  }
  console.error("Rejected model event:", errors.join(", ").slice(0, 120));
  return "UNKNOWN";
}

function parseModelJson(content) {
  if (typeof content !== "string")
    throw new Error("MODEL_CONTENT_NOT_TEXT");

  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(cleaned);
}

async function callMiniMax(description) {
  if (!API_KEY || !API_URL || !MODEL)
    throw new Error("AI_NOT_CONFIGURED");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: description }
      ]
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok)
    throw new Error(`PROVIDER_HTTP_${response.status}`);

  const payload = await response.json();

  // MiniMax signals application errors through base_resp.status_code while the
  // HTTP status stays 200 (verified live: a missing key answers HTTP 200 with
  // {"base_resp":{"status_code":1004,"status_msg":"login fail: ..."}}). Surface
  // that here instead of failing later with a misleading parse error.
  const base = payload?.base_resp;
  if (base && typeof base.status_code === "number" && base.status_code !== 0) {
    throw new Error(
      `MINIMAX_${base.status_code}:${String(base.status_msg || "").slice(0, 80)}`
    );
  }

  // Compatible with the usual MiniMax chat-completion response.
  const content = payload?.choices?.[0]?.message?.content;
  const event = parseModelJson(content);
  const error = validateEvent(event);

  if (error) throw new Error(`INVALID_OUTPUT_${error}`);

  return event;
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    const headers = {
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    };
    if (ALLOWED_ORIGIN)
      headers["access-control-allow-origin"] = ALLOWED_ORIGIN;
    res.writeHead(204, headers);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return reply(res, 200, { ok: true });
  }

  if (req.method !== "POST" || req.url !== "/api/parse-event")
    return reply(res, 404, { ok: false, error: "NOT_FOUND" });

  try {
    let raw = "";

    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8000)
        return reply(res, 413, {
          ok: false, error: "INPUT_TOO_LARGE"
        });
    }

    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return reply(res, 400, {
        ok: false, error: "INVALID_JSON"
      });
    }

    const description = body?.description;

    if (typeof description !== "string" ||
        description.trim().length < 4 ||
        description.length > 2000) {
      return reply(res, 400, {
        ok: false, error: "INVALID_DESCRIPTION"
      });
    }

    const started = Date.now();
    const event = await callMiniMax(description.trim());

    return reply(res, 200, {
      ok: true,
      event,
      meta: {
        model: MODEL,
        elapsedMs: Date.now() - started
      }
    });
  } catch (error) {
    const code = String(error?.message || "UNKNOWN_ERROR");
    console.error("Doudou AI request failed:", code.slice(0, 60));

    const notConfigured = code === "AI_NOT_CONFIGURED";

    return reply(res, notConfigured ? 503 : 502, {
      ok: false,
      error: notConfigured
        ? "AI_NOT_CONFIGURED"
        : code.startsWith("MINIMAX_")
          ? "AI_PROVIDER_ERROR"
          : code.startsWith("INVALID_OUTPUT")
            ? "AI_INVALID_OUTPUT"
            : "AI_PARSE_FAILED"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Doudou AI proxy listening on port ${PORT}`);
});
