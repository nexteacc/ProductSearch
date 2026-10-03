import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { preflight, collect } from "../src/ego";
import { validateConfig } from "../src/domain";
import { readJson, atomicJson } from "../src/store";
await mkdir("verification", { recursive: true });
const dir = await mkdtemp(resolve("verification/capture-smoke-"));
const config = validateConfig({
  theme: "豹纹手机壳",
  keyword: "leopard phone case",
  platforms: ["amazon", "etsy", "pinterest"],
  targets: { amazon: 3, etsy: 3, pinterest: 3 },
});
const cli = await preflight();
const events: unknown[] = [];
const results = await collect(
  config,
  dir,
  resolve("src/collector.mjs"),
  cli,
  new AbortController().signal,
  async (event) => {
    events.push(event);
    console.log(JSON.stringify(event));
  },
);
const raw = await readJson<unknown[]>(join(dir, "raw.json"), []);
await atomicJson(join(dir, "evidence.json"), {
  kind: "fresh-collection-only",
  keyword: config.keyword,
  results,
  count: raw.length,
  events,
  judgment: "not-run-no-key",
});
console.log(JSON.stringify({ dir, count: raw.length, results }));
