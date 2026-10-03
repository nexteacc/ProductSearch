import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Store, atomicJson } from "./store";
import { validateConfig, type Observation, type Run } from "./domain";
export async function seedDesktopFixture(store: Store, enabled = true) {
  const id = randomUUID(),
    at = new Date().toISOString();
  const config = validateConfig({
    theme: "测试替身 · 豹纹手机壳",
    keyword: "leopard phone case",
    platforms: ["amazon", "etsy", "pinterest"],
    targets: { amazon: 1, etsy: 1, pinterest: 1 },
    judgment: { enabled, engine: "jev" },
  });
  const raw: Observation[] = config.platforms.map((p) => ({
    id: `fixture-${p}`,
    platform: p,
    title: `${p} Leopard phone case test fixture`,
    sourceUrl: `https://www.${p === "amazon" ? "amazon.com" : p === "etsy" ? "etsy.com" : "pinterest.com"}/`,
    url: null,
    capturedAt: at,
    priceText: null,
  }));
  const run: Run = {
    id,
    config,
    status: "completed",
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    collected: 3,
    judged: enabled ? 3 : 0,
    recommended: enabled ? 2 : 0,
    totalMs: 20,
    collectMs: 10,
    judgeMs: 10,
    platformResults: config.platforms.map((p) => ({
      platform: p,
      status: "completed",
      count: 1,
      target: 1,
    })),
    message: "自动化 UI 测试替身，非真实采集或模型结果。",
  };
  await store.save(run);
  await atomicJson(join(store.dir(id), "raw.json"), raw);
  if (enabled)
    await store.saveDecisions(
      id,
      raw.map((r, i) => ({
        id: r.id,
        platform: r.platform,
        recommendationScore: [0.95, 0.86, 0.65][i],
        model: "desktop-test-fixture",
        ruleVersion: "test-only",
        judgedAt: at,
      })),
    );
  await store.event(id, { type: "completed", message: "fixture completed" });
  return id;
}
