import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadGate } from "../src/lib/download.ts";
import type { DownloadOffer } from "../src/types.ts";

const offer: DownloadOffer = { key: "model@revision:q4", label: "Model", size: "100 MB", source: "huggingface" };

test("download approval is scoped to the exact artifact set", async () => {
  const prompted: string[] = [];
  const gate = createDownloadGate(({ key }) => prompted.push(key));
  let fetched = false;
  const first = gate.wait(offer).then(() => { fetched = true; });
  await Promise.resolve();
  assert.equal(fetched, false);
  assert.equal(gate.approve("another-model"), false);
  assert.equal(fetched, false);
  assert.equal(gate.approve(offer.key), true);
  await first;
  await gate.wait(offer);
  assert.equal(prompted.length, 1);
  const fallback = gate.wait({ ...offer, key: "model@revision:q8" });
  assert.equal(prompted.length, 2);
  assert.equal(gate.approve(offer.key), false);
  assert.equal(gate.approve("model@revision:q8"), true);
  await fallback;
});

test("concurrent file requests share one approval, different models do not", async () => {
  let prompts = 0;
  const gate = createDownloadGate(() => { prompts += 1; });
  const first = gate.wait(offer);
  assert.equal(first, gate.wait(offer));
  await assert.rejects(gate.wait({ ...offer, key: "different" }), /awaiting approval/);
  assert.equal(prompts, 1);
  gate.approve(offer.key);
  await first;
});
