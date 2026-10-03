import { test } from "node:test";
import assert from "node:assert/strict";
import { collectionPolicy, executionBudget } from "../src/collection-policy";
import { validateConfig } from "../src/domain";
test("shared maximum and dynamic budgets grow with platform targets", () => {
  const platforms = ["amazon", "etsy", "pinterest"] as const;
  const config = {
    theme: "托特包",
    keyword: "tote bag",
    platforms: [...platforms],
  };
  const low = executionBudget(validateConfig(config));
  const high = executionBudget(
    validateConfig({
      ...config,
      targets: { amazon: 500, etsy: 500, pinterest: 500 },
    }),
  );
  for (const p of platforms) {
    assert.ok(high.platforms[p].units > low.platforms[p].units);
    assert.ok(high.platforms[p].timeoutMs > low.platforms[p].timeoutMs);
    assert.ok(
      high.platforms[p].timeoutMs <= collectionPolicy.hardPlatformTimeoutMs,
    );
  }
  assert.equal(high.platforms.pinterest.units, 250);
  assert.throws(() =>
    validateConfig({
      ...config,
      targets: { pinterest: collectionPolicy.maxTarget + 1 },
    }),
  );
  assert.ok(high.timeoutMs > low.timeoutMs);
});
