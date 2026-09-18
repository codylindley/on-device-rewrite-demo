import { readFile, writeFile } from "node:fs/promises";
import { summarize } from "../benchmarks/score.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node scripts/summarize-grammar.mjs <run.json> <scored.json>");
const report = JSON.parse(await readFile(input, "utf8"));
const results = report.results.map((row) => {
  // Earlier run envelopes carried guard refusals in the worker's error field.
  if (row.error && /^The (?:model|proofreader) could not produce a usable edit\./.test(row.error)) {
    return { ...row, outcome: "rejected", rejectionReason: row.error, error: null };
  }
  if (row.outcome === "accepted") return { ...row, outcome: "produced" };
  return row;
});
const evaluation = summarize(report.corpus, results);
const measured = results.slice(1).map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
const artifacts = [...new Set(results.flatMap(({ events = [] }) =>
  events.filter(({ type }) => type === "download-required").map(({ download }) => download.key),
))];
const run = {
  recordedAt: report.recordedAt,
  engine: report.engine,
  browser: report.browser,
  capabilities: report.capabilities,
  artifacts,
  observedExternalBytes: report.downloads.reduce((total, item) => total + (item.bytes ?? 0), 0),
  firstCaseMs: results[0]?.elapsedMs ?? null,
  subsequentCaseMedianMs: measured.length ? measured[Math.floor(measured.length / 2)] : null,
  subsequentCaseP95Ms: measured.length ? measured[Math.ceil(measured.length * 0.95) - 1] : null,
  unmeasured: ["peak memory", "first-attempt rejection rate", "native-model quality"],
};
await writeFile(output, `${JSON.stringify({ run, evaluation }, null, 2)}\n`);
const { scores, byCategory, bySplit, interpretation, ...totals } = evaluation;
console.log(JSON.stringify({ run, totals, byCategory, bySplit }, null, 2));
