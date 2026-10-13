/**
 * src/services/doudou-ai-client.mjs
 * Browser-safe client. No API key belongs here.
 *
 * Contract source: ChatGPT core module #4 (doudou-ai-client). Landed as given,
 * with one change for testability: `fetchImpl` is injectable so the client can
 * be tested against the local stub without any real provider.
 *
 * SCOPE / HONEST LIMIT:
 * The shipped app (bundle/main.splash) is an OctoScript *Splash* program: it
 * has no JavaScript runtime and cannot import this module. Its transport for a
 * model call is `net.http_request`, which the host refuses for http://,
 * localhost, private addresses and non-declared hosts (verified with
 * `octo check`). So this module is the *contract and test target* for the
 * proxy's JSON shape — it is NOT imported by the app, and it is NOT evidence
 * that AI is connected. The in-app wiring point is `ev_from_ai_json()` in
 * main.splash, which consumes exactly the `event` object this client returns.
 */

import {
  validateEventDraft,
  describeDraftErrors,
  createEmptyHouseholdEvent
} from "../domain/household-event.mjs";

export async function parseHouseholdEventWithAI(description, {
  endpoint = "/api/parse-event",
  signal,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof description !== "string" || description.trim().length < 4) {
    return {
      ok: false,
      error: "请先描述家庭事件"
    };
  }

  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "无法连接 AI 服务；原有手动模拟功能仍可使用" };
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: description.trim() }),
      signal
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok || !payload?.event) {
      const messages = {
        AI_NOT_CONFIGURED: "AI 服务尚未配置，请使用手动输入",
        AI_INVALID_OUTPUT: "AI 返回内容无法验证，请修改事件或手动输入",
        AI_PARSE_FAILED: "AI 暂时不可用，请使用手动输入",
        AI_PROVIDER_ERROR: "AI 服务连接失败，请使用手动输入"
      };

      return {
        ok: false,
        error: messages[payload?.error] || "事件解析失败，请检查网络或手动输入"
      };
    }

    return { ok: true, draft: payload.event };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, error: "已取消事件解析" };
    }

    return {
      ok: false,
      error: "无法连接 AI 服务；原有手动模拟功能仍可使用"
    };
  }
}

/**
 * Keep a clear draft/confirm boundary.
 * The UI must show all values and allow editing before confirmation.
 *
 * Built from the wire allowlist instead of `{...parsedEvent}`: spreading let a
 * key the model invented (`engineResult`, `confirmed`, anything) survive into
 * the draft and then into the confirmed event. Unknown shape is now impossible
 * here rather than merely ignored.
 *
 * `draftErrors` carries both the machine codes and the localized sentences, so
 * the UI never has to invent its own wording.
 */
export function prepareEventDraft(parsedEvent, {
  allowedEventTypes,
  recurringEventTypes
} = {}) {
  const checked = validateEventDraft(parsedEvent, {
    allowedEventTypes,
    recurringEventTypes
  });

  const draft = {
    ...(checked.draft || createEmptyHouseholdEvent()),
    source: "ai",
    confirmed: false
  };

  return {
    ...draft,
    draftErrors: checked.errors,
    draftErrorMessages: describeDraftErrors(checked.errors)
  };
}
