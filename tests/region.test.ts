import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  writeFile,
  rename,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/domain";
import { executionBudget } from "../src/collection-policy";

const source = await readFile(
  new URL("../src/collector.mjs", import.meta.url),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const config = {
  theme: "宠物床",
  keyword: "Pet Bed",
  platforms: ["amazon", "etsy", "pinterest"],
  targets: { amazon: 1, etsy: 1, pinterest: 1 },
};
test("US site uses a fixed New York postal code regardless of legacy input", () => {
  assert.equal(validateConfig(config).amazonPostalCode, "11201");
  assert.equal(
    validateConfig({ ...config, amazonPostalCode: "10001" }).amazonPostalCode,
    "11201",
  );
  for (const zip of ["", "1120", "112011", "ABCDE", 11201])
    assert.equal(
      validateConfig({ ...config, amazonPostalCode: zip }).amazonPostalCode,
      "11201",
    );
  assert.throws(() => validateConfig({ ...config, region: "JP" }), /美国/);
});
async function fixture(
  options: {
    failed?: boolean;
    already?: boolean;
    cancelled?: boolean;
    blocked?: boolean;
  } = {},
) {
  let value = options.already ? "Brooklyn 11201" : "China";
  const calls: string[] = [],
    events: any[] = [];
  const page = {
    evaluate: async () => value,
    click: async (selector: string) => {
      calls.push(selector);
      if (options.failed) throw Error("selector missing");
      if (selector === 'button[name="glowDoneButton"]')
        value = "Brooklyn 11201";
      if (selector === 'button[name="save"]')
        value = "Update your settings United States English (US) $ (USD)";
    },
    fill: async (selector: string, zip: string) => {
      calls.push(`${selector}:${zip}`);
    },
    selectOption: async (selector: string, v: string) => {
      calls.push(`${selector}:${v}`);
    },
    waitForSelector: async () => {},
    waitForFunction: async () => {},
    waitForLoadState: async () => {},
  };
  const helpers = source.slice(
    source.indexOf("const readRegion ="),
    source.indexOf('emit({\n  type: "browser_space"'),
  );
  const { ensureRegion, matchesRegion } = await new AsyncFunction(
    "page",
    "config",
    "emit",
    "check",
    "inspect",
    "navigate",
    helpers + "\nreturn {ensureRegion,matchesRegion};",
  )(
    page,
    { amazonPostalCode: "11201" },
    (e: any) => events.push(e),
    async () => {
      if (options.cancelled) throw Error("cancelled");
    },
    async () => {
      if (options.blocked) throw Error("blocked");
    },
    async () => {},
  );
  return { ensureRegion, matchesRegion, calls, events };
}
test("matching Amazon ZIP skips changes; generic US-like text is not proof", async () => {
  const f = await fixture({ already: true });
  await f.ensureRegion("amazon", "https://www.amazon.com/s", {});
  assert.deepEqual(f.calls, []);
  assert.equal(f.matchesRegion("amazon", "Update location"), false);
  assert.equal(f.matchesRegion("amazon", "Brooklyn 11201"), true);
});
for (const platform of ["amazon", "etsy"])
  test(`${platform} changes settings once then verifies`, async () => {
    const f = await fixture();
    const result: any = {};
    await f.ensureRegion(platform, "https://example.invalid", result);
    assert(f.events.some((e) => e.type === "region_adjusted"));
    assert.equal(f.matchesRegion(platform, result.observedRegion), true);
    assert.equal(
      f.calls.filter(
        (s) =>
          s ===
          (platform === "amazon" ? "#GLUXZipUpdate" : 'button[name="save"]'),
      ).length,
      1,
    );
  });
test("failed adjustment reports a specific reason without retry", async () => {
  const f = await fixture({ failed: true });
  await assert.rejects(
    f.ensureRegion("etsy", "https://example.invalid", {}),
    /region_adjustment_failed/,
  );
  assert.equal(f.calls.length, 1);
  assert(f.events.some((e) => e.type === "region_adjustment_failed"));
});
for (const reason of ["cancelled", "blocked"])
  test(`${reason} is preserved, not treated as a regional failure`, async () => {
    const f = await fixture({ [reason]: true });
    await assert.rejects(
      f.ensureRegion("amazon", "https://example.invalid", {}),
      new RegExp(reason),
    );
    assert(!f.events.some((e) => e.type === "region_adjustment_failed"));
  });
test("Etsy region failure does not prevent Pinterest from collecting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "research-region-"));
  let url = "";
  const page = {
    goto: async (u: string) => {
      url = u;
    },
    url: async () => url,
    waitForSelector: async () => {},
    click: async () => {
      throw Error("missing locale UI");
    },
    evaluate: async (fn: Function, arg: any) => {
      if (typeof arg === "string")
        return "Update your settings Japan English (US) ¥ (JPY)";
      if (fn.toString().includes("const selectors"))
        return {
          url,
          title: "Search",
          text: "Results",
          challenge: false,
          visibleChallenge: false,
          signals: [],
        };
      return [
        {
          id: "123",
          title: "Pet bed",
          url: "https://www.pinterest.com/pin/123/",
        },
      ];
    },
  };
  await new AsyncFunction(
    "readFile",
    "writeFile",
    "rename",
    "appendFile",
    "join",
    "taskSpace",
    "globalThis",
    source.replace(/^import .*;\n/gm, ""),
  )(
    readFile,
    writeFile,
    rename,
    appendFile,
    join,
    async () => ({
      spaceId: 1,
      page: () => page,
      finish: async () => {},
      handOff: async () => {
        throw Error("must not hand off for locale failure");
      },
    }),
    {
      COLLECTION_INPUT: {
        dir,
        config: { ...config, platforms: ["etsy", "pinterest"] },
        budget: executionBudget({
          ...config,
          platforms: ["etsy", "pinterest"],
        } as any),
      },
    },
  );
  const results = JSON.parse(
    await readFile(join(dir, "platforms.json"), "utf8"),
  );
  assert.equal(results[0].stopReason, "region_adjustment_failed");
  assert.equal(results[1].count, 1);
  assert.equal(results[1].status, "completed");
});
