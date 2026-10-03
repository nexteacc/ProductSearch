import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { executionBudget } from "../src/collection-policy";

for (const visible of [true, false]) {
  test(`challenge ${visible ? "visible stops" : "hidden Pinterest iframe permits collection"}`, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "research-challenge-"));
    let handoffs = 0,
      finishes = 0,
      navigations = 0;
    const node = {
      parentElement: null,
      hidden: !visible,
      getBoundingClientRect: () => ({
        width: visible ? 300 : 0,
        height: visible ? 80 : 0,
        top: 0,
        left: 0,
        right: 300,
        bottom: 80,
      }),
      getClientRects: () => (visible ? [1] : []),
    };
    const page = {
      waitForSelector: async () => {},
      goto: async () => {
        navigations++;
      },
      evaluate: async (fn: Function) =>
        runInNewContext(`(${fn.toString()})()`, {
          document: {
            title: "Pinterest",
            body: { innerText: "Search results" },
            querySelectorAll: (selector: string) =>
              selector.startsWith("iframe")
                ? [node]
                : selector.includes("/pin/")
                  ? [
                      {
                        href: "https://www.pinterest.com/pin/123/",
                        getAttribute: () => "Tote bag",
                        querySelector: () => null,
                      },
                    ]
                  : [],
          },
          location: { href: "https://www.pinterest.com/search/pins/" },
          getComputedStyle: () => ({
            display: visible ? "block" : "none",
            visibility: "visible",
            opacity: "1",
          }),
          innerWidth: 1000,
          innerHeight: 800,
        }),
    };
    const task = {
      spaceId: 42,
      page: () => page,
      handOff: async () => {
        handoffs++;
      },
      finish: async () => {
        finishes++;
      },
    };
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
            targets: { amazon: 150, etsy: 150, pinterest: 1 },
          }),
          dir,
          config: {
            theme: "托特包",
            keyword: "tote bag",
            platforms: ["pinterest"],
            targets: { pinterest: 1 },
          },
        },
      },
    );
    const events = (await fs.readFile(join(dir, "capture.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const evidence = events.find((e) => e.type === "environment_stop_evidence");
    if (!visible) {
      assert.equal(evidence, undefined);
      assert.equal(handoffs, 0);
      assert.equal(finishes, 1);
      const records = JSON.parse(
        await fs.readFile(join(dir, "raw.json"), "utf8"),
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].id, "123");
      return;
    }
    assert.equal(evidence.reason, "visible_challenge");
    assert.equal(evidence.signals[0].visible, visible);
    assert.equal(evidence.spaceId, 42);
    assert.equal(handoffs, 1);
    assert.equal(finishes, 0);
    assert.equal(navigations, 1);
    assert.ok(events.some((e) => e.type === "browser_handed_off"));
  });
}
