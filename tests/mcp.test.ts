import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicJson } from "../src/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Service } from "../src/service";
import { startBridge } from "../src/bridge";
import { seedDesktopFixture } from "../src/desktop-fixture";
test("official MCP client connects to actual stdio bridge and calls tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "product-research-mcp-test-"));
  const s = new Service(
    dir,
    {
      available: async () => false,
      get: async () => {
        throw new Error("No key");
      },
      set: async () => {},
    },
    "unused",
  );
  await s.init();
  const bridge = await startBridge(s);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/mcp.cjs")],
    env: { ...process.env, PRODUCT_RESEARCH_DATA_DIR: dir } as Record<
      string,
      string
    >,
  });
  const client = new Client({ name: "research-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 5);
    assert.deepEqual(
      list.tools.map((t) => t.name),
      [
        "create_research_task",
        "list_research_tasks",
        "get_research_task",
        "cancel_research_task",
        "judge_existing_task",
      ],
    );
    for (const name of ["get_research_results", "check_research_environment"])
      assert.equal(
        (await client.callTool({ name, arguments: {} })).isError,
        true,
      );
    const tasks = await client.callTool({
      name: "list_research_tasks",
      arguments: {},
    });
    assert.equal((tasks.content as { text: string }[])[0].text, "[]");
    const id = await seedDesktopFixture(s.store);
    const call = async (arguments_: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "get_research_task",
        arguments: arguments_,
      });
      assert.notEqual(result.isError, true);
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    assert.equal((await call({ runId: id })).results, undefined);
    const first = await call({ runId: id, includeResults: true, limit: 1 });
    assert.equal(first.run.id, id);
    assert.equal(first.results.total, 2);
    assert.equal(first.results.items.length, 1);
    assert.equal(
      (await call({ runId: id, includeResults: true, threshold: 0.9 })).results
        .total,
      1,
    );
    assert.equal(
      (await call({ runId: id, includeResults: true, offset: 1, limit: 1 }))
        .results.items[0].platform,
      "etsy",
    );
    const rawId = await seedDesktopFixture(s.store, false);
    const raw = await call({ runId: rawId, includeResults: true });
    assert.equal(raw.results.total, 3);
    assert.equal(raw.events, undefined);
    assert.equal(raw.results.originalTotal, 3);
    assert.equal(raw.results.threshold, null);
    assert.equal(raw.results.hasMore, false);
    const facts = (await s.store.raw(rawId)).map((r, i) => ({
      ...r,
      ratingText: ["4.6 out of 5 stars", "4.5", "1,234 ratings"][i],
      priceText: i === 0 ? "$19.99" : null,
      extraFact: "retained",
    }));
    await atomicJson(join(s.store.dir(rawId), "raw.json"), facts);
    const filtered = await call({
      runId: rawId,
      includeResults: true,
      filters: { ratingAbove: 4.5, hasFields: ["priceText"] },
    });
    assert.equal(filtered.results.total, 1);
    assert.equal(filtered.results.items[0].extraFact, "retained");
    assert.equal(filtered.results.items[0].recommendationScore, undefined);
    assert.equal(
      (
        await call({
          runId: rawId,
          includeResults: true,
          filters: {
            platforms: ["etsy"],
            titleContains: "LEOPARD",
            titleExcludes: "amazon",
          },
        })
      ).results.total,
      1,
    );
    assert.equal(
      (await call({ runId: rawId, includeEvents: true, eventLimit: 1 })).events
        .length,
      1,
    );
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...facts[0],
      id: String(i),
    }));
    await atomicJson(join(s.store.dir(rawId), "raw.json"), many);
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const page = (
        await call({ runId: rawId, includeResults: true, offset, limit: 100 })
      ).results;
      ids.push(...page.items.map((x: { id: string }) => x.id));
      if (!page.hasMore) {
        assert.equal(page.nextOffset, null);
        break;
      }
      offset = page.nextOffset;
    }
    assert.equal(ids.length, 500);
    assert.equal(new Set(ids).size, 500);
    assert.equal(
      (await call({ runId: rawId, includeResults: true, offset: 600 })).results
        .items.length,
      0,
    );
    for (const invalid of [
      { threshold: 0.5 },
      { limit: 101 },
      { offset: -1 },
      { includeResults: "yes" },
      { apiKey: "not-allowed" },
      { filters: { ratingAbove: 6 } },
      { filters: { platforms: ["unknown"] } },
      { filters: { hasFields: ["apiKey"] } },
      { includeEvents: "yes" },
      { eventLimit: 101 },
    ])
      assert.equal(
        (
          await client.callTool({
            name: "get_research_task",
            arguments: { runId: id, ...invalid },
          })
        ).isError,
        true,
      );
    const create = await client.callTool({
      name: "create_research_task",
      arguments: {
        theme: "豹纹手机壳",
        keyword: "leopard phone case",
        platforms: ["amazon"],
      },
    });
    assert.equal(create.isError, true);
    assert.ok(JSON.stringify(create).includes("API Key"));
    assert.ok(!JSON.stringify(create).includes("Bearer"));
  } finally {
    await client.close();
    await bridge.close();
    await s.shutdown();
  }
});
