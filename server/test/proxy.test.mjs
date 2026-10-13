// proxy.test.mjs — exercises doudou-agent-proxy.mjs end to end against a local
// stub provider (no real credentials needed). Run: node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const PROXY = join(SERVER_DIR, "doudou-agent-proxy.mjs");
const STUB = join(HERE, "stub-provider.mjs");

const STUB_PORT = 8791;
const PROXY_PORT = 8790;   // configured with dummy MiniMax env
const NOENV_PORT = 8792;   // no MiniMax env at all

const children = [];

function start(cmd, args, env, label) {
  const child = spawn(cmd, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}!] ${d}`));
  children.push(child);
  return child;
}

async function waitHealthy(port, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`proxy on ${port} never became healthy`);
}

async function callParse(port, description, { signal } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/parse-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description }),
    signal,
  });
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

before(async () => {
  start(process.execPath, [STUB], { STUB_PORT: String(STUB_PORT) }, "stub");
  start(process.execPath, [PROXY], {
    PORT: String(PROXY_PORT),
    MINIMAX_API_KEY: "test-key-not-real",
    MINIMAX_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`,
    MINIMAX_MODEL: "stub-model",
  }, "proxy");
  start(process.execPath, [PROXY], { PORT: String(NOENV_PORT) }, "proxy-noenv");

  await waitHealthy(PROXY_PORT);
  await waitHealthy(NOENV_PORT, 8000).catch(() => {});
  // give stub a moment
  await new Promise((r) => setTimeout(r, 200));
});

after(() => {
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch { /* ignore */ }
  }
});

test("T1 /health returns ok", async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("T2 valid description -> 200 + structured event", async () => {
  const { status, body } = await callParse(PROXY_PORT, "我打算休息 18 个月，期间没有收入");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.event.eventType, "income_loss");
  assert.equal(body.event.durationMonths, 18);
  assert.equal(body.event.monthlyIncomeDelta, -40000);
  assert.equal(body.meta.model, "stub-model");
});

test("T3 fenced JSON (```json) is unwrapped", async () => {
  const { status, body } = await callParse(PROXY_PORT, "MODE_FENCED 休息 18 个月");
  assert.equal(status, 200);
  assert.equal(body.event.eventType, "income_loss");
});

test("T4 missing fields -> 200 with missingFields + clarificationQuestion", async () => {
  const { status, body } = await callParse(PROXY_PORT, "MODE_MISSING 我想休息一阵子");
  assert.equal(status, 200);
  assert.deepEqual(body.event.missingFields, ["amount", "duration"]);
  assert.ok(body.event.clarificationQuestion.length > 0);
});

test("T5 model returns non-JSON -> 502 AI_PARSE_FAILED", async () => {
  const { status, body } = await callParse(PROXY_PORT, "MODE_BADJSON 随便说点什么");
  assert.equal(status, 502);
  assert.equal(body.error, "AI_PARSE_FAILED");
});

test("T6 model returns invalid eventType -> 502 AI_INVALID_OUTPUT", async () => {
  const { status, body } = await callParse(PROXY_PORT, "MODE_INVALIDTYPE 测试非法类型");
  assert.equal(status, 502);
  assert.equal(body.error, "AI_INVALID_OUTPUT");
});

test("T7 upstream HTTP 500 -> 502 AI_PARSE_FAILED", async () => {
  const { status, body } = await callParse(PROXY_PORT, "MODE_HTTP500 触发上游错误");
  assert.equal(status, 502);
  assert.equal(body.error, "AI_PARSE_FAILED");
});

test("T8 model timeout (>20s) -> 502 AI_PARSE_FAILED", { timeout: 30000 }, async () => {
  const t0 = Date.now();
  const { status, body } = await callParse(PROXY_PORT, "MODE_SLOW 触发超时");
  const elapsed = Date.now() - t0;
  assert.equal(status, 502);
  assert.equal(body.error, "AI_PARSE_FAILED");
  assert.ok(elapsed >= 19000, `expected >=19s abort, got ${elapsed}ms`);
});

test("T9 description too short -> 400 INVALID_DESCRIPTION", async () => {
  const { status, body } = await callParse(PROXY_PORT, "ab");
  assert.equal(status, 400);
  assert.equal(body.error, "INVALID_DESCRIPTION");
});

test("T10 malformed JSON body -> 400 INVALID_JSON", async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/parse-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "INVALID_JSON");
});

test("T11 oversized body -> 413 INPUT_TOO_LARGE", async () => {
  const big = "x".repeat(9000);
  const { status, body } = await callParse(PROXY_PORT, big);
  assert.equal(status, 413);
  assert.equal(body.error, "INPUT_TOO_LARGE");
});

test("T12 wrong method/path -> 404 NOT_FOUND", async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/nope`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "NOT_FOUND");
});

test("T13 no MiniMax env -> 503 AI_NOT_CONFIGURED", async () => {
  const { status, body } = await callParse(NOENV_PORT, "配置缺失时应返回未配置");
  assert.equal(status, 503);
  assert.equal(body.error, "AI_NOT_CONFIGURED");
});

test("T14 client cancel (abort) does not crash the server", async () => {
  const ac = new AbortController();
  const p = callParse(PROXY_PORT, "MODE_SLOW 用户取消", { signal: ac.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  await p;
  // server must still be healthy
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("T15 MiniMax base_resp error (HTTP 200) -> 502 AI_PROVIDER_ERROR", async () => {
  // Live MiniMax answers HTTP 200 with base_resp.status_code=1004 on auth failure.
  const { status, body } = await callParse(PROXY_PORT, "MODE_BASERESP 触发 base_resp 错误");
  assert.equal(status, 502);
  assert.equal(body.error, "AI_PROVIDER_ERROR");
});
