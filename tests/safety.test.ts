import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageGuard, browserEnvironment } from "../src/safety";
import { atomicJson } from "../src/store";
import { Service } from "../src/service";
test("queue limit preserves deduplication and rejects excess tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-queue-"));
  const s = new Service(
    root,
    {
      available: async () => false,
      get: async () => {
        throw Error("unused");
      },
      set: async () => {},
    },
    "unused",
    { judgmentEnabled: false },
  );
  await s.init();
  Object.assign(s, { pump: () => {} });
  const base = {
    theme: "queue test",
    keyword: "tote",
    platforms: ["pinterest"],
    targets: { pinterest: 1 },
  };
  for (let i = 0; i < 5; i++)
    await s.create({ ...base, requestId: `queue-test-${i}` });
  await s.create({ ...base, requestId: "queue-test-0" });
  assert.equal((await s.store.list()).length, 5);
  await assert.rejects(
    s.create({ ...base, requestId: "queue-test-5" }),
    /上限/,
  );
  const rows = await s.store.list();
  await s.cancel(rows[0].id);
  await s.create({ ...base, requestId: "queue-test-5" });
  await s.shutdown();
});
test("browser subprocess only receives allowed environment", () => {
  const env = browserEnvironment({
    HOME: "/test",
    PATH: "/bin",
    TMPDIR: "/tmp",
    TYPESAFE_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    GITHUB_TOKEN: "secret",
    NODE_OPTIONS: "--require bad",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal(env.HOME, "/test");
  for (const k of [
    "TYPESAFE_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.equal(env[k], undefined);
});
test("daily usage is atomic persistent and rejects corrupt records", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-safety-"));
  const p = {
    maxQueued: 1,
    dailyTasks: 2,
    dailyModelCalls: 2,
    dailyModelRecords: 3,
  };
  let day = new Date(2026, 9, 3, 12);
  const guard = new UsageGuard(root, p, () => day);
  const calls = await Promise.allSettled([
    guard.reserve("task"),
    guard.reserve("task"),
    guard.reserve("task"),
  ]);
  assert.equal(calls.filter((x) => x.status === "fulfilled").length, 2);
  await assert.rejects(
    new UsageGuard(root, p, () => day).reserve("task"),
    /上限/,
  );
  await guard.reserve("model", 2);
  await assert.rejects(guard.reserve("model", 2), /额度/);
  await guard.reserve("model", 1);
  await assert.rejects(guard.reserve("model", 1), /额度/);
  day = new Date(2026, 9, 2, 12);
  await assert.rejects(guard.reserve("task"), /系统日期/);
  day = new Date(2026, 9, 4, 12);
  await guard.reserve("task");
  await atomicJson(join(root, "usage.json"), {
    day: "2026-10-04",
    tasks: -1,
    calls: 0,
    records: 0,
  });
  await assert.rejects(guard.reserve("task"), /损坏/);
});
