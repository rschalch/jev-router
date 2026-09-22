try {
  process.loadEnvFile();
} catch {
  // No .env; the key may still come from the real environment.
}
const { askJev } = await import("../src/router.mjs");
const { decide } = await import("../src/policy.mjs");
// The shape the proxy builds from Claude Code's model catalog.
const models = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku" },
  { id: "claude-sonnet-5", tier: "sonnet" },
  { id: "claude-opus-5-5", tier: "opus" },
];
const available = models.map((m) => m.tier);
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
  "delete all rows in production where status is null",
];
for (const prompt of prompts) {
  const a = await askJev({ prompt, current: "claude-sonnet-5", contextTokens: 0, models });
  if (!a) { console.log(`FAIL  ${prompt}`); continue; }
  const tier = models.find((m) => m.id === a.choice)?.tier;
  const out = decide({ prompt, jev: { ...a, choice: tier }, current: "sonnet", available });
  const p = Object.entries(a.probabilities).map(([k,v]) => `${k}=${v.toFixed(2)}`).join(" ");
  console.log(
    `${String(tier).padEnd(7)} conf=${a.confidence.toFixed(2)} stakes=${a.highStakes?.toFixed(2)} ` +
      `${String(a.ms).padStart(5)}ms -> ${out.tier} (${out.reason}) | ${p} | ${prompt}`,
  );
}
