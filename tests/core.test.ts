import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateConfig,
  parseAnswers,
  candidates,
  questionFor,
  type Observation,
  type PlatformResult,
  activeStatuses,
} from "../src/domain";
import { Service, type Adapters } from "../src/service";
import { atomicJson } from "../src/store";
import { judge } from "../src/jev";
import { startBridge } from "../src/bridge";
const config = {
  theme: "豹纹手机壳",
  keyword: "leopard phone case",
  platforms: ["amazon", "etsy", "pinterest"],
  targets: { amazon: 2, etsy: 2, pinterest: 2 },
  region: "US",
};
test("custom judgment rules are validated and sent as the actual criterion", () => {
  const rule = "仅纳入页面明确显示可重复使用的托特包";
  const c = validateConfig({ ...config, judgmentRule: rule });
  assert.equal(c.judgmentRule, rule);
  const q = questionFor(c.theme, 0, c.judgmentRule);
  assert.equal(q.instructions.judgmentRule, rule);
  assert.match(q.instructions.question, /satisfy judgmentRule/);
  assert.match(q.criteria.true, /satisfy judgmentRule/);
  assert.throws(() => validateConfig({ ...config, judgmentRule: " " }));
  assert.throws(() =>
    validateConfig({ ...config, judgmentRule: "a".repeat(2001) }),
  );
  assert.equal(validateConfig(config).judgmentRule, undefined);
});
const secrets = {
  available: async () => true,
  get: async () => "test-key-not-real",
  set: async () => {},
};
test("collection-only mode requires no key and exposes every raw record", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-optional-"));
  const a = adapters();
  let judgeCalls = 0;
  a.judge = async () => {
    judgeCalls++;
    throw new Error("must not judge");
  };
  const s = new Service(
    root,
    {
      available: async () => false,
      get: async () => {
        throw new Error("must not read key");
      },
      set: async () => {},
    },
    "fake.mjs",
    { judgmentEnabled: false },
    a,
  );
  const run = await s.create(config);
  s.settings.judgmentEnabled = true;
  const done = await terminal(s, run.id);
  assert.equal(done.status, "completed");
  assert.equal(done.collected, 6);
  assert.equal(done.judged, 0);
  assert.equal(judgeCalls, 0);
  const results = await s.results(run.id, 0.9);
  assert.equal(results.mode, "unjudged");
  assert.equal(results.total, 6);
  assert.ok(results.items.every((r) => !("recommendationScore" in r)));
});
test("existing records can be judged without reopening the browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-rejudge-"));
  const a = adapters();
  let collections = 0,
    checks = 0;
  const collect = a.collect;
  a.collect = async (...args) => {
    collections++;
    return collect(...args);
  };
  a.preflight = async () => {
    checks++;
    return "/fake/ego-browser";
  };
  const s = new Service(
    root,
    secrets,
    "fake.mjs",
    { judgmentEnabled: false },
    a,
  );
  const original = await s.create(config);
  await terminal(s, original.id);
  const next = await s.judgeExisting(original.id, "纳入豹纹手机壳");
  const done = await terminal(s, next.id);
  assert.equal(done.status, "completed");
  assert.equal(done.judged, 6);
  assert.equal(done.sourceRunId, original.id);
  assert.equal(collections, 1);
  assert.equal(checks, 1);
  assert.equal((await s.store.get(original.id)).judged, 0);
  assert.equal((await s.results(original.id)).total, 6);
});
const observation = (
  id: string,
  platform: Observation["platform"] = "amazon",
): Observation => ({
  id,
  platform,
  title: "Leopard phone case",
  url: "https://www.amazon.com/dp/test",
  sourceUrl: "https://www.amazon.com/s?k=leopard",
  capturedAt: new Date().toISOString(),
  priceText: "$10",
});
async function terminal(s: Service, id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await s.store.get(id);
    if (!activeStatuses.has(r.status)) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Test timeout");
}
function adapters(
  options: { failure?: boolean; slow?: boolean; invalid?: boolean } = {},
): Adapters {
  return {
    preflight: async () => "/fake/ego-browser",
    collect: async (c, dir, _script, _cli, signal, onEvent) => {
      if (options.slow)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      const raw = c.platforms.flatMap((p) =>
        options.failure && p === "etsy"
          ? []
          : [observation(`${p}-1`, p), observation(`${p}-2`, p)],
      );
      await atomicJson(join(dir, "raw.json"), raw);
      const results: PlatformResult[] = c.platforms.map((p) => ({
        platform: p,
        status: options.failure && p === "etsy" ? "blocked" : "completed",
        count: raw.filter((i) => i.platform === p).length,
        target: c.targets[p],
        stopReason:
          options.failure && p === "etsy" ? "blocked" : "target_reached",
      }));
      for (const r of results)
        await onEvent({
          type: "platform_progress",
          platform: r.platform,
          count: r.count,
        });
      return results;
    },
    judge: async (batch, _c, _key, signal) => {
      signal.throwIfAborted();
      if (options.invalid) throw new Error("无效返回");
      return {
        decisions: batch.map((i, n) => ({
          id: i.id,
          platform: i.platform,
          recommendationScore: n % 2 ? 0.86 : 0.95,
          model: "test-fixture",
          ruleVersion: "theme-candidate-noul-v1",
          judgedAt: new Date().toISOString(),
        })),
        durationMs: 2,
      };
    },
  };
}
async function setup(a = adapters()) {
  const dir = await mkdtemp(join(tmpdir(), "product-research-test-"));
  const service = new Service(dir, secrets, "fake.mjs", {}, a);
  await service.init();
  return service;
}
test("config validates platforms, region, targets; theme is parameterized", () => {
  const c = validateConfig(config);
  assert.equal(c.targets.amazon, 2);
  assert.throws(() => validateConfig({ ...config, region: "CN" }));
  assert.throws(() => validateConfig({ ...config, targets: { amazon: -1 } }));
  assert.throws(() =>
    validateConfig({ ...config, platforms: ["amazon", "amazon"] }),
  );
  assert.ok(JSON.stringify(questionFor("条纹背包", 0)).includes("条纹背包"));
  assert.ok(!JSON.stringify(questionFor("条纹背包", 0)).includes("leopard"));
});
test("Noul must be numeric and in range; thresholds are only 80/90", () => {
  const raw = [observation("a"), observation("b")];
  const d = parseAnswers(
    {
      model: "test",
      answers: {
        item_0: { type: "noul", noul: 0.9 },
        item_1: { type: "noul", noul: 0.8 },
      },
    },
    raw,
  );
  assert.equal(candidates(raw, d, 0.8).length, 2);
  assert.equal(candidates(raw, d, 0.9).length, 1);
  assert.throws(() => candidates(raw, d, 0.5));
  assert.throws(() =>
    parseAnswers(
      { model: "test", answers: { item_0: { type: "noul", noul: "0.9" } } },
      [raw[0]],
    ),
  );
  assert.throws(() =>
    parseAnswers(
      { model: "test", answers: { item_0: { type: "noul", noul: 1.1 } } },
      [raw[0]],
    ),
  );
});
test("Jev HTTP contract, bearer stays outside data, no image judgment", async () => {
  let body: Record<string, unknown> = {};
  const result = await judge(
    [observation("a")],
    validateConfig(config),
    "private-test-secret",
    new AbortController().signal,
    async (_url, init) => {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer private-test-secret",
      );
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "fixture",
          answers: { item_0: { type: "noul", noul: 0.92 } },
        }),
        { status: 200 },
      );
    },
  );
  assert.equal(result.decisions[0].recommendationScore, 0.92);
  assert.ok(!JSON.stringify(body).includes("private-test-secret"));
  assert.ok(!JSON.stringify(body).includes("imageUrl"));
});
test("three fresh runs are isolated, threshold filter does not rejudge", async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) {
    const run = await s.create({
      ...config,
      theme: i ? "条纹背包" : "豹纹手机壳",
      keyword: i ? "striped backpack" : "leopard phone case",
    });
    const done = await terminal(s, run.id);
    assert.equal(done.status, "completed");
    assert.equal(done.collected, 6);
    assert.equal(done.judged, 6);
    assert.equal((await s.results(run.id, 0.8)).total, 6);
    assert.equal((await s.results(run.id, 0.9)).total, 3);
    assert.ok(
      !(await readFile(join(s.store.dir(run.id), "run.json"), "utf8")).includes(
        "test-key-not-real",
      ),
    );
  }
  assert.equal((await s.store.list()).length, 3);
  await s.shutdown();
});
test("simultaneous creates queue and deduplicate same request id", async () => {
  const s = await setup(adapters({ slow: true }));
  const [a, b, c] = await Promise.all([
    s.create({ ...config, requestId: "request_one" }),
    s.create({ ...config, requestId: "request_one" }),
    s.create({ ...config, requestId: "request_two" }),
  ]);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal((await s.store.list()).length, 2);
  await assert.rejects(
    s.create({ ...config, theme: "different", requestId: "request_one" }),
  );
  await terminal(s, a.id);
  await terminal(s, c.id);
  await s.shutdown();
});
test("partial platform never inserts previous data", async () => {
  const s = await setup(adapters({ failure: true }));
  const run = await s.create(config);
  const done = await terminal(s, run.id);
  assert.equal(done.status, "partial");
  assert.equal(done.collected, 4);
  assert.ok((await s.store.raw(run.id)).every((i) => i.platform !== "etsy"));
  await s.shutdown();
});
test("invalid judge preserves raw data without invented scores", async () => {
  const s = await setup(adapters({ invalid: true }));
  const run = await s.create(config);
  const done = await terminal(s, run.id);
  assert.equal(done.status, "failed");
  assert.equal((await s.store.raw(run.id)).length, 6);
  assert.equal((await s.store.decisions(run.id)).length, 0);
  assert.equal((await s.results(run.id)).total, 6);
  assert.equal((await s.results(run.id)).mode, "unjudged");
  assert.ok(done.issue?.action);
  await s.shutdown();
});
test("cancel active and queued tasks; restart marks abandoned runs interrupted", async () => {
  const s = await setup(adapters({ slow: true }));
  const a = await s.create(config),
    b = await s.create(config);
  await s.cancel(b.id);
  assert.equal((await s.store.get(b.id)).status, "cancelled");
  await s.cancel(a.id);
  assert.equal((await terminal(s, a.id)).status, "cancelled");
  const stale = { ...(await s.store.get(a.id)), status: "collecting" as const };
  await s.store.save(stale);
  await s.shutdown();
  const resumed = new Service(
    s.store.root,
    secrets,
    "fake.mjs",
    {},
    adapters(),
  );
  await resumed.init();
  assert.equal((await resumed.store.get(a.id)).status, "interrupted");
  await resumed.shutdown();
});
test("event writes have distinct sequence numbers under concurrency", async () => {
  const s = await setup();
  const run = await s.create(config);
  await terminal(s, run.id);
  await Promise.all(
    Array.from({ length: 10 }, () => s.store.event(run.id, { type: "test" })),
  );
  const events = await s.store.events(run.id);
  assert.equal(new Set(events.map((e) => e.sequence)).size, events.length);
  await s.shutdown();
});
test("local bridge rejects unauthenticated and browser origins", async () => {
  const s = await setup();
  const bridge = await startBridge(s);
  const url = `http://127.0.0.1:${bridge.port}/rpc`;
  assert.equal((await fetch(url, { method: "POST" })).status, 403);
  const connection = JSON.parse(
    await readFile(join(s.store.root, "connection.json"), "utf8"),
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          Origin: "https://example.com",
        },
      })
    ).status,
    403,
  );
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ method: "list" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { result: [] });
  await bridge.close();
  await s.shutdown();
});
