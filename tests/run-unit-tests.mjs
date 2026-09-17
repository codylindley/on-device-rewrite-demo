import { readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

await rm(new URL("../.test-dist", import.meta.url), {
  recursive: true,
  force: true,
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL("..", import.meta.url),
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

await run(process.platform === "win32" ? "npx.cmd" : "npx", [
  "--no-install",
  "tsc",
  "-p",
  "tests/tsconfig.json",
]);
const tests = (await readdir(new URL("../.test-dist/tests", import.meta.url)))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => `.test-dist/tests/${file}`);
await run(process.execPath, ["--test", ...tests]);
