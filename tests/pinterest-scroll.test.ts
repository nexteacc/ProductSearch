import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { executionBudget } from "../src/collection-policy";

for (const target of [150, 500]) {
  test(`virtualized Pinterest waits for usable titles and accumulates ${target} unique records`, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pinterest-150-"));
    let stage = 0,
      ready = true,
      waits = 0;
    const anchors = () =>
      Array.from({ length: 8 }, (_, i) => {
        const id = stage * 5 + i + 1;
        return {
          href: `https://www.pinterest.com/pin/${id}/`,
          getAttribute: () => "",
          querySelector: () => ({
            alt: ready ? `Leopard case ${id}` : "",
            src: null,
          }),
        };
      });
    const context = () => ({
      document: {
        title: "Pinterest",
        body: { innerText: "Search results" },
        documentElement: { scrollHeight: 10000 },
        querySelectorAll: (selector: string) =>
          selector.includes("/pin/") ? anchors() : [],
      },
      location: { href: "https://www.pinterest.com/search/pins/" },
      scrollY: stage * 600,
      innerHeight: 750,
      innerWidth: 1000,
      window: {
        scrollBy: () => {
          stage++;
          ready = false;
        },
      },
    });
    const page = {
      goto: async () => {},
      waitForSelector: async () => {},
      evaluate: async (fn: Function) =>
        runInNewContext(`(${fn.toString()})()`, context()),
      waitForFunction: async (fn: Function, arg: unknown) => {
        waits++;
        assert.equal(
          !!runInNewContext(`(${fn.toString()})(arg)`, { ...context(), arg }),
          false,
        );
        ready = true;
        assert.equal(
          !!runInNewContext(`(${fn.toString()})(arg)`, { ...context(), arg }),
          true,
        );
      },
    };
    const task = { spaceId: 42, page: () => page, finish: async () => {} };
    const source = (
      await fs.readFile(
        new URL("../src/collector.mjs", import.meta.url),
        "utf8",
      )
    ).replace(/^import .*;\n/gm, "");
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction(
      "readFile",
      "writeFile",
      "rename",
      "appendFile",
      "join",
      "taskSpace",
      "globalThis",
      source,
    )(
      fs.readFile,
      fs.writeFile,
      fs.rename,
      fs.appendFile,
      join,
      async () => task,
      {
        COLLECTION_INPUT: {
          budget: executionBudget({
            platforms: ["pinterest"],
            targets: { amazon: 150, etsy: 150, pinterest: target },
          }),
          dir,
          config: {
            theme: "豹纹手机壳",
            keyword: "leopard phone case",
            platforms: ["pinterest"],
            targets: { pinterest: target },
          },
        },
      },
    );
    const raw = JSON.parse(await fs.readFile(join(dir, "raw.json"), "utf8"));
    assert.equal(raw.length, target);
    assert.equal(new Set(raw.map((r: { id: string }) => r.id)).size, target);
    assert.ok(waits > 0);
    const events = (await fs.readFile(join(dir, "capture.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (e) => e.type === "pinterest_wait" && e.outcome === "new_usable_pin",
      ),
    );
  });
}
