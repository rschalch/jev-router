import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  claudeModels,
  conversationKey,
  sessionOf,
  startProxy,
} from "../src/proxy.mjs";

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("jev-router"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5-20251001"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("jev-router"), null);
});
import { tierOf, isAuto } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, pruneStale, STATUS_DIR } from "../src/status.mjs";
import { mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

test("keeps available Claude model versions as separate Jev choices", () => {
  assert.deepEqual(
    claudeModels([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    ]).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "claude-opus-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
  );
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          data: [
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          ],
        }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-4-8"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("reads the prompt past a trailing system message", () => {
  const body = withTools([
    { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    { role: "system", content: [{ type: "text", text: "# Environment" }] },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation behind a trailing system message", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    { role: "system", content: "# Environment" },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("strips the transcript of a local command prepended to the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content:
        "<local-command-caveat>Caveat: DO NOT respond to these messages.</local-command-caveat>\n\n" +
        "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n" +
        "            <command-args></command-args>\n\n<local-command-stdout></local-command-stdout>\n\n" +
        "verify the router works",
    },
  ]);
  assert.equal(newTurnPrompt(body), "verify the router works");
});

test("keeps a slash command's arguments as the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content:
        "<command-name>/review</command-name>\n<command-message>review</command-message>\n" +
        "<command-args>the auth refactor</command-args>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "the auth refactor");
});

test("a prompt that is only a local command transcript is not a turn", () => {
  const body = withTools([
    {
      role: "user",
      content:
        "<command-name>/clear</command-name><command-args></command-args>" +
        "<local-command-stdout>cleared</local-command-stdout>",
    },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores Claude Code's next-prompt suggestion call", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "Fixed." },
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>x</system-reminder>" },
        {
          type: "text",
          text: "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nReply with ONLY the suggestion, no quotes or explanation.",
        },
      ],
    },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

/** A proxy in front of a fake API that records the model each request was sent to. */
async function routedProxy(t) {
  const served = [];
  const asked = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      served.push(JSON.parse(Buffer.concat(chunks)).model);
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ prompt }) => {
      asked.push(prompt);
      return {
        choice: prompt.includes("rename") ? "claude-haiku-4-5-20251001" : "claude-opus-5-5",
        confidence: 0.99,
        ms: 1,
      };
    },
  });
  t.after(close);
  const sid = `proxy-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const send = (model, messages) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        metadata: { user_id: JSON.stringify({ session_id: sid }) },
        tools: [{ name: "Bash" }],
        messages,
      }),
    }).then((response) => response.text());
  return { served, asked, port, sid, send };
}

const mainTurn = [{ role: "user", content: "rename this variable" }];
const continuation = [
  ...mainTurn,
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
];

test("a sub-agent on its own model does not mark a routed session manual", async (t) => {
  const { sid, send } = await routedProxy(t);
  await send("jev-router", mainTurn);
  await send("claude-haiku-4-5-20251001", [{ role: "user", content: "search the repo" }]);
  const status = readStatus(sid);
  assert.equal(status.manual, undefined);
  assert.equal(status.history.length, 1);
});

test("switching the routed conversation to a model with /model marks it manual and keeps history", async (t) => {
  const { sid, send } = await routedProxy(t);
  await send("jev-router", mainTurn);
  await send("claude-sonnet-5", [...continuation, { role: "user", content: "now add a test" }]);
  const status = readStatus(sid);
  assert.equal(status.manual, true);
  assert.equal(status.history.length, 1, "jev-explain history survives the switch");
});

test("a session that never routed is manual from its first agent turn", async (t) => {
  const { sid, send } = await routedProxy(t);
  await send("claude-sonnet-5", mainTurn);
  assert.equal(readStatus(sid).manual, true);
});

test("many sub-agents do not evict the main conversation's pinned model mid-turn", async (t) => {
  const { served, send } = await routedProxy(t);
  await send("jev-router", mainTurn);
  assert.equal(served.at(-1), "claude-haiku-4-5-20251001");
  // More sub-agents than the cache holds, with the main conversation active between them.
  for (let i = 0; i < 600; i++) {
    await send("jev-router", [{ role: "user", content: `sub-agent task ${i}` }]);
    if (i % 100 === 0) await send("jev-router", continuation);
  }
  await send("jev-router", continuation);
  assert.equal(served.at(-1), "claude-haiku-4-5-20251001");
});

test("a token count is never routed, but still names a real model", async (t) => {
  const { served, asked, port } = await routedProxy(t);
  // What Claude Code sends to count its tool definitions: no metadata, the session's model,
  // real tools, and a placeholder message (made unique so no earlier run's file can match).
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `foo ${process.pid} ${Date.now()}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.deepEqual(asked, [], "no Jev call");
  assert.equal(served.at(-1), "claude-opus-5-5");
  assert.equal(readStatus(conversationKey(body)), null, "no decision recorded");
});

test("older versions that reject adaptive thinking and effort are never offered to Jev", () => {
  const offered = claudeModels([
    { id: "claude-opus-5-5" },
    { id: "claude-opus-4-6" },
    { id: "claude-opus-4-5-20251101" },
    { id: "claude-opus-4-1-20250805" },
    { id: "claude-opus-4-20250514" },
    { id: "claude-sonnet-5" },
    { id: "claude-sonnet-4-6" },
    { id: "claude-sonnet-4-5-20250929" },
    { id: "claude-sonnet-4-20250514" },
    { id: "claude-3-7-sonnet-20250219" },
    { id: "claude-haiku-4-5-20251001" },
    { id: "claude-3-5-haiku-20241022" },
  ]).map(({ id }) => id);
  assert.deepEqual(offered, [
    "claude-opus-5-5",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ]);
});
