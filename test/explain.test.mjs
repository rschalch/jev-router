import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatExplanation } from "../src/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    model: "claude-sonnet-5",
    confidence: 0.94,
    reason: "jev",
    jev: {
      request: { state: { session: { current_model: "claude-haiku-4-5-20251001", context_tokens: 6200 } } },
      response: { answers: { model: { choice: "claude-sonnet-5" } } },
    },
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current model:\s+│\n│ CLAUDE-HAIKU-4-5-20251001 /);
  assert.match(output, /Context tokens: 6200/);
  assert.match(output, /Jev recommended:\s+│\n│ CLAUDE-SONNET-5 /);
  assert.match(output, /Selected model: CLAUDE-SONNET-5/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});

test("shows Jev's own answer and the high-stakes gate when policy raised the model", () => {
  const output = formatExplanation({
    tier: "opus",
    model: "claude-opus-5-5",
    confidence: 0.98,
    reason: "high-stakes",
    jev: { response: { answers: { model: { choice: "claude-haiku-4-5-20251001" } } } },
  });
  assert.match(output, /Jev recommended:\s+│\n│ CLAUDE-HAIKU-4-5-20251001 /);
  assert.match(output, /Selected model: CLAUDE-OPUS-5-5/);
  assert.match(output, /Decision: high stakes; raised/);
});

test("still explains a status file written before exact-model routing", () => {
  const output = formatExplanation({
    tier: "sonnet",
    reason: "jev",
    jev: { response: { answers: { model_tier: { choice: "sonnet" } } } },
  });
  assert.match(output, /Jev recommended: SONNET/);
});

test("every row fits the box, however long the model id", () => {
  const output = formatExplanation({
    tier: "haiku",
    model: "claude-haiku-4-5-20251001",
    reason: "jev",
    jev: {
      request: { state: { session: { current_model: "claude-haiku-4-5-20251001" } } },
      response: { answers: { model: { choice: "claude-haiku-4-5-20251001" } } },
    },
  });
  assert(output.split("\n").every((line) => line.length === 35), output);
  assert.equal(output.match(/CLAUDE-HAIKU-4-5-20251001 /g)?.length, 3, "no id is truncated");
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});

test("Claude skill pre-approves its read-only explanation command", () => {
  const skill = readFileSync(new URL("../.claude/skills/jev-explain/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^allowed-tools: Bash\(node \*\)$/m);
});
