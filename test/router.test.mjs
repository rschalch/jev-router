import test from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { askJev } from "../src/router.mjs";

// No network: the client is built for real, and only its API call is replaced.
process.env.JEV_API_KEY ??= "test-key";
const answer = (answers) => {
  TypeSafeClient.prototype.systemOne = async () => ({ answers });
};
const ask = () =>
  askJev({
    prompt: "rename this variable",
    current: "claude-opus-5-5",
    contextTokens: 1000,
    models: [{ id: "claude-haiku-4-5-20251001", tier: "haiku" }],
  });
const model = { choice: "claude-haiku-4-5-20251001", confidence: 0.9, probabilities: {} };

test("normalises the complexity scores for display", async () => {
  answer({
    model,
    task_complexity: { score: 9 },
    reasoning_required: { score: 0 },
    tool_complexity: { score: 3 },
    high_stakes: { noul: 0.1 },
  });
  const jev = await ask();
  assert.equal(jev.choice, "claude-haiku-4-5-20251001");
  assert.equal(jev.highStakes, 0.1);
  assert.equal(jev.metrics.taskComplexity, 1);
  assert.equal(jev.metrics.reasoningRequired, 0);
  assert.equal(jev.metrics.toolComplexity, 3 / 9);
});

test("a missing complexity answer does not throw away the model answer", async () => {
  answer({ model, task_complexity: { score: 4 }, tool_complexity: {} });
  const jev = await ask();
  assert.equal(jev.choice, "claude-haiku-4-5-20251001");
  assert.equal(jev.confidence, 0.9);
  assert.equal(jev.highStakes, null);
  assert.equal(jev.metrics.taskComplexity, 4 / 9);
  assert.equal(jev.metrics.reasoningRequired, null);
  assert.equal(jev.metrics.toolComplexity, null);
});

test("a failed call still degrades to no routing", async () => {
  TypeSafeClient.prototype.systemOne = async () => {
    throw new Error("503 Service Unavailable");
  };
  assert.equal(await ask(), null);
});
