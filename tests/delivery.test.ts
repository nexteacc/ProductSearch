import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, atomicJson } from "../src/store";
import { issueFor, safeMessage } from "../src/issues";
import { Service } from "../src/service";
import { seedDesktopFixture } from "../src/desktop-fixture";

test("fresh user data is created with no tasks, settings or key", async () => {
  const root = join(
    await mkdtemp(join(tmpdir(), "research-fresh-")),
    "new-user",
  );
  const store = new Store(root);
  await store.init();
  assert.deepEqual(await store.list(), []);
  for (const file of ["settings.json", "typesafe.enc", "connection.json"])
    await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
  await store.checkWritable();
});
test("damaged history is isolated without changing the damaged file", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-history-"));
  const store = new Store(root);
  await store.init();
  const valid = await seedDesktopFixture(store);
  const broken = randomUUID();
  await atomicJson(join(root, "runs", valid, "unused.json"), {});
  const run = await store.get(valid);
  await store.save({ ...run, id: broken });
  const path = join(store.dir(broken), "run.json");
  await atomicJson(path, { id: broken });
  const before = await readFile(path, "utf8");
  assert.deepEqual(
    (await store.list()).map((r) => r.id),
    [valid],
  );
  assert.equal(store.warnings.length, 1);
  assert.equal(await readFile(path, "utf8"), before);
});
test("failures have actionable codes and do not expose secrets or local paths", () => {
  assert.equal(issueFor(new Error("Jev HTTP 401")).code, "api_auth");
  assert.equal(issueFor(new Error("Jev HTTP 429")).code, "api_limit");
  assert.equal(
    issueFor(new Error("未找到 ego-browser")).code,
    "browser_missing",
  );
  assert.equal(
    issueFor(Object.assign(new Error("disk"), { code: "ENOSPC" })).code,
    "storage_unavailable",
  );
  const message = safeMessage(
    new Error(
      "apikey_example_private_key Bearer test-secret /Users/example/private/config",
    ),
  );
  assert.ok(!message.includes("test-secret"));
  assert.ok(!message.includes("/Users/"));
  assert.ok(!message.includes("apikey_example"));
});
test("environment separates writable storage, browser connection and key readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-health-"));
  const service = new Service(
    root,
    {
      available: async () => false,
      get: async () => {
        throw new Error("key must not be read");
      },
      set: async () => {},
    },
    "unused",
    { judgmentEnabled: false },
    {
      preflight: async () => {
        throw new Error("未找到 ego-browser");
      },
      collect: async () => [],
      judge: async () => {
        throw new Error("must not judge");
      },
    },
  );
  await service.init();
  const env = await service.environment();
  assert.equal(env.dataReady, true);
  assert.equal(env.egoReady, false);
  assert.equal(env.judgmentEnabled, false);
  service.store.checkWritable = async () => {
    throw new Error("storage unavailable");
  };
  assert.equal((await service.environment()).dataReady, false);
  await service.shutdown();
});
