const WIDTH = 33;
const row = (text = "") => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`;
const metric = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
const wrapped = (label, value) => {
  const words = `${label}${value}`.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  for (const word of words) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > WIDTH - 2) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines.map(row);
};

const decision = (reason = "") => {
  if (reason.includes("override")) return "prompt override";
  if (reason.includes("high-stakes")) return "high stakes; raised";
  if (reason.includes("jev-unavailable")) return "Jev unavailable; held";
  if (reason.includes("low-confidence-no-downgrade")) return "low confidence; held";
  if (reason.includes("low-confidence-capped")) return "low confidence; capped";
  if (reason.includes("cache-rebuild")) return "cache rebuild avoided";
  if (reason.includes("unavailable")) return "nearest available tier";
  return "Jev recommendation";
};

export function formatExplanation(status) {
  if (!status) return "Jev Router: no routing decision has been recorded for this session.";
  if (status.manual) return "Jev Router: routing is paused because you selected a model manually.";

  const m = status.metrics ?? {};
  const request = status.jev?.request?.state;
  // Jev's own answer, which policy may have overridden. `model_tier` is the key used before
  // routing moved to exact model ids, kept so older status files still explain.
  const answers = status.jev?.response?.answers;
  const recommendation = answers?.model?.choice ?? answers?.model_tier?.choice ?? "unknown";
  return [
    `┌${"─".repeat(WIDTH)}┐`,
    row("Jev Router"),
    row(),
    row("Jev request"),
    ...wrapped("Prompt: ", status.prompt ?? "not recorded"),
    ...wrapped("Current model: ", (request?.session?.current_model ?? "unknown").toUpperCase()),
    row(`Context tokens: ${request?.session?.context_tokens ?? "unknown"}`),
    row(),
    row("Jev response"),
    row(`Task complexity     ${metric(m.taskComplexity)}`),
    row(`Reasoning required  ${metric(m.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m.toolComplexity)}`),
    row(`Context size        ${metric(m.contextSize)}`),
    row(),
    ...wrapped("Jev recommended: ", recommendation.toUpperCase()),
    ...wrapped("Selected model: ", (status.model ?? status.tier ?? "unknown").toUpperCase()),
    row(),
    row(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    row(`Decision: ${decision(status.reason)}`),
    `└${"─".repeat(WIDTH)}┘`,
  ].join("\n");
}
