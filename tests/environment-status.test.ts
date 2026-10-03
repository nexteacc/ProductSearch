import { test } from "node:test";
import assert from "node:assert/strict";
import { environmentStatus } from "../src/environment-status";
const ready = { egoReady: true, keyAvailable: true, dataReady: true };
test("environment indicator correctly prioritizes errors over configuration warnings", () => {
  assert.equal(environmentStatus(ready).level, "ready");
  assert.equal(
    environmentStatus({ ...ready, keyAvailable: false }).level,
    "warning",
  );
  assert.equal(
    environmentStatus({ ...ready, keyAvailable: false, judgmentEnabled: false })
      .level,
    "ready",
  );
  assert.equal(
    environmentStatus({ ...ready, issues: ["damaged"] }).level,
    "warning",
  );
  assert.equal(
    environmentStatus({ ...ready, egoReady: false, keyAvailable: false }).level,
    "error",
  );
  assert.equal(
    environmentStatus({ ...ready, dataReady: false }).level,
    "error",
  );
});
