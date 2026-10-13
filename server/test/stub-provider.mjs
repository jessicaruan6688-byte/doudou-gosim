// stub-provider.mjs — a local, OpenAI-compatible fake of the MiniMax chat endpoint.
// Used only for testing the proxy without real credentials. Dispatches on the
// user message text so one stub can serve every scenario.
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT || 8791);

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function chat(content) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

const VALID_EVENT = {
  title: "休息 18 个月",
  eventType: "income_loss",
  monthlyIncomeDelta: -40000,
  monthlyExpenseDelta: null,
  oneTimeCashDelta: null,
  durationMonths: 18,
  assumptions: ["休息期间家庭收入降为零"],
  missingFields: [],
  clarificationQuestion: "",
};

const MISSING_EVENT = {
  title: "休息一段时间",
  eventType: "income_loss",
  monthlyIncomeDelta: null,
  monthlyExpenseDelta: null,
  oneTimeCashDelta: null,
  durationMonths: null,
  assumptions: [],
  missingFields: ["amount", "duration"],
  clarificationQuestion: "这段时间大约几个月？每月少多少收入？",
};

const BAD_TYPE_EVENT = {
  title: "x",
  eventType: "weird_type",
  monthlyIncomeDelta: null,
  monthlyExpenseDelta: null,
  oneTimeCashDelta: null,
  durationMonths: 0,
  assumptions: [],
  missingFields: [],
  clarificationQuestion: "",
};

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1] || {};
  const user = String(last.content || "");
  const has = (t) => user.includes(t);

  if (has("MODE_HTTP500")) return sendJson(res, 500, { error: "upstream boom" });
  if (has("MODE_BASERESP"))
    return sendJson(res, 200, {
      base_resp: {
        status_code: 1004,
        status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
      },
    });
  if (has("MODE_BADJSON")) return sendJson(res, 200, chat("sorry, I cannot answer that."));
  if (has("MODE_FENCED"))
    return sendJson(res, 200, chat("```json\n" + JSON.stringify(VALID_EVENT) + "\n```"));
  if (has("MODE_MISSING")) return sendJson(res, 200, chat(JSON.stringify(MISSING_EVENT)));
  if (has("MODE_INVALIDTYPE")) return sendJson(res, 200, chat(JSON.stringify(BAD_TYPE_EVENT)));
  if (has("MODE_SLOW")) {
    await new Promise((r) => setTimeout(r, 21000)); // > proxy's 20s AbortSignal timeout
    return sendJson(res, 200, chat(JSON.stringify(VALID_EVENT)));
  }
  return sendJson(res, 200, chat(JSON.stringify(VALID_EVENT)));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub provider listening on ${PORT}`);
});
