import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "../server.js";

const ANALYSIS = {
  hook_summary: "Creator jumps on a cheap couch and it collapses.",
  video_format: "Demo / stunt",
  hook_types: ["Pattern Interrupt", "Negative Hook"],
  psychological_triggers: [{ trigger: "Loss aversion", how_it_is_used: "Fear of wasting money" }],
  elements: { spoken: "Stop buying couches from the mall", on_screen_text: "$200 vs $2000", visual: "Collapse", audio: "Crash SFX", pacing: "Under 2s" },
  structure_template: "Stop [COMMON_ACTION]. Here's why.",
  slots: [{ slot: "COMMON_ACTION", role: "Habit the viewer has", original_value: "buying couches from the mall" }],
  open_loop: "Why not the mall?",
  why_it_works: "Calls out the viewer.",
  strength_score: 8,
  do_not_copy: "His catchphrase.",
};

const HOOKS = {
  hooks: [{
    title: "Mall bed test", spoken_line: "Stop buying beds that creak in a month.", on_screen_text: "Creak test",
    opening_visual: "Jumping on a bed", shot_list: ["Jump", "Close-up joint"],
    template_fill: [{ slot: "COMMON_ACTION", value: "buying beds that creak" }],
    principles_borrowed: ["Negative Hook"], payoff: "Show joinery", why_it_should_work: "Relatable", strength_score: 7,
  }],
  filming_tips: ["Film vertically"],
};

// Real SDK client with a stubbed fetch, so the request/parse path is exercised.
function fakeClient(responses, requests) {
  return new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      const r = responses.shift();
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers || {}) } });
    },
  });
}

function message(obj, stop_reason = "end_turn") {
  return {
    body: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason,
      content: [{ type: "text", text: JSON.stringify(obj) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

async function withServer(client, fn) {
  const server = createApp(client).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));

test("analyze then generate", async () => {
  const requests = [];
  const client = fakeClient([message(ANALYSIS), message(HOOKS)], requests);
  await withServer(client, async (base) => {
    const a = await post(`${base}/api/analyze`, {
      original: { spoken: "Stop buying couches from the mall", images: ["data:image/png;base64,iVBORw0KGgo="] },
    });
    assert.equal(a.status, 200);
    assert.deepEqual(a.data, ANALYSIS);

    const g = await post(`${base}/api/generate`, { analysis: a.data, brand: { name: "Black Gold Furniture" }, count: 3 });
    assert.equal(g.status, 200);
    assert.equal(g.data.hooks[0].title, "Mall bed test");
  });

  const [analyzeReq, generateReq] = requests;
  assert.equal(analyzeReq.model, "claude-opus-5-5");
  assert.equal(analyzeReq.fallbacks, "default");
  assert.equal(analyzeReq.output_config.format.type, "json_schema");
  assert.equal(analyzeReq.messages[0].content[0].type, "image");
  assert.match(generateReq.messages[0].content, /Write 3 original hooks/);
  assert.match(generateReq.messages[0].content, /Black Gold Furniture/);
});

test("validation errors do not call Claude", async () => {
  const requests = [];
  await withServer(fakeClient([], requests), async (base) => {
    assert.equal((await post(`${base}/api/analyze`, { original: {} })).status, 400);
    assert.equal((await post(`${base}/api/generate`, { analysis: ANALYSIS, brand: {} })).status, 400);
  });
  assert.equal(requests.length, 0);
});

test("refusal and auth errors are reported clearly", async () => {
  const requests = [];
  const client = fakeClient([
    message({}, "refusal"),
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "bad key" } } },
  ], requests);
  await withServer(client, async (base) => {
    const r1 = await post(`${base}/api/analyze`, { original: { spoken: "hi" } });
    assert.equal(r1.status, 422);
    const r2 = await post(`${base}/api/analyze`, { original: { spoken: "hi" } });
    assert.equal(r2.status, 401);
    assert.match(r2.data.error, /ANTHROPIC_API_KEY/);
  });
});
