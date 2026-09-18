// The deploy workflow builds with --base, but the tests only ever exercise a root-based build. A base
// mismatch still returns HTTP 200 and simply 404s every asset, so the site goes blank with no failing
// signal anywhere. This rebuilds the way Pages does and checks that each referenced asset resolves.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.argv[2] ?? "/on-device-rewrite-demo/";
const OUT = ".pages-check";

function fail(message) {
  console.error(`✗ ${message}`);
  rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
try {
  execFileSync(
    "npx",
    ["vite", "build", `--base=${BASE}`, `--outDir=${OUT}`, "--emptyOutDir"],
    { stdio: "pipe" },
  );
} catch (error) {
  fail(`the base build itself failed:\n${error.stderr?.toString() ?? error.message}`);
}

const html = await readFile(join(OUT, "index.html"), "utf8");
const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)]
  .map(([, value]) => value)
  .filter((value) => !/^(?:https?:)?\/\/|^data:|^#/u.test(value));

if (referenced.length === 0) fail("index.html references no local assets, so nothing was checked.");

const problems = [];
for (const reference of referenced) {
  if (!reference.startsWith(BASE)) {
    problems.push(`${reference} does not start with ${BASE}`);
    continue;
  }
  const onDisk = join(OUT, reference.slice(BASE.length));
  if (!existsSync(onDisk)) problems.push(`${reference} has no file at ${onDisk}`);
}

rmSync(OUT, { recursive: true, force: true });
if (problems.length > 0) fail(`the Pages build would serve a blank page:\n  ${problems.join("\n  ")}`);
console.log(`✓ ${referenced.length} assets resolve under ${BASE}`);
