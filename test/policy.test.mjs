import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
  assert.equal(detectOverride("use opus for this"), "opus");
  assert.equal(detectOverride("please switch to the fast model"), "haiku");
  assert.equal(detectOverride("do it with balanced."), "sonnet");
});

test("a tier adjective used as plain English is not an override", () => {
  for (const prompt of [
    "Drop the users table in production, use fast mode",
    "use strong passwords in the seed script",
    "add types with strong generics to the parser",
    "work on long-running jobs later",
    "make sure the tree stays with balanced nodes",
    "run the tests on fast path",
  ]) {
    assert.equal(detectOverride(prompt), null, prompt);
  }
});

test("a plain-English adjective cannot bypass the high-stakes gate", () => {
  const prompt = "Drop the users table in production, use fast mode";
  const out = decide({ ...base, prompt, jev: { choice: "haiku", confidence: 0.95, highStakes: 0.97 } });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "high-stakes");
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});

const risky = (choice, confidence = 0.95) => ({ choice, confidence, highStakes: 0.97 });

test("a high-stakes request is lifted to the floor tier whatever its difficulty", () => {
  const out = decide({ ...base, prompt: "delete all rows in production where status is null", jev: risky("haiku") });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "high-stakes");
});

test("the high-stakes gate beats the low-confidence cap and the cache-rebuild guard", () => {
  assert.equal(decide({ ...base, jev: risky("haiku", 0.2) }).tier, "opus");
  assert.equal(decide({ ...base, current: "opus", contextTokens: 90000, jev: risky("haiku") }).reason, "high-stakes/no-change");
});

test("the high-stakes gate never lowers a stronger choice", () => {
  assert.equal(decide({ ...base, jev: risky("fable") }).tier, "fable");
});

test("an explicit override still beats the high-stakes gate", () => {
  assert.equal(decide({ ...base, prompt: "use haiku to drop the table", jev: risky("haiku") }).tier, "haiku");
});

test("a low stakes probability, or none at all, leaves routing alone", () => {
  assert.equal(decide({ ...base, jev: { ...sure("haiku"), highStakes: 0.4 } }).tier, "haiku");
  assert.equal(decide({ ...base, jev: { ...sure("haiku"), highStakes: null } }).tier, "haiku");
});

test("the high-stakes gate never causes a downgrade the hold rules would refuse", () => {
  const stronger = { ...base, current: "fable" };
  assert.equal(decide({ ...stronger, jev: risky("haiku", 0.1) }).tier, "fable");
  assert.equal(decide({ ...stronger, contextTokens: 150000, jev: risky("haiku") }).tier, "fable");
});

test("a low-confidence cap never lands below the high-stakes floor", () => {
  const out = decide({ ...base, current: "haiku", jev: risky("fable", 0.2) });
  assert.equal(out.tier, "opus");
  assert.equal(out.reason, "low-confidence-capped");
});
