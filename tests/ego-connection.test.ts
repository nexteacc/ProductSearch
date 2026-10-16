import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  egoLocations,
  egoReadyMarker,
  verifyEgoOutput,
  preflight,
  resolveEgo,
} from "../src/ego";
import { Service } from "../src/service";

test("automatic discovery includes user CLI, active version and installed application", () => {
  const locations = egoLocations("/Users/test");
  assert(locations.includes("/Users/test/.local/bin/ego-browser"));
  assert(
    locations.some(
      (p) =>
        p.startsWith("/Applications/ego lite.app/") &&
        p.includes("Versions/Current/Helpers/ego-browser"),
    ),
  );
  assert(
    locations.some((p) =>
      p.startsWith("/Users/test/Applications/ego lite.app/"),
    ),
  );
});
test("zero exit without the execution marker is not a browser connection", () => {
  assert.throws(() => verifyEgoOutput(0, ""), /可用连接/);
  assert.throws(
    () => verifyEgoOutput(0, "Please complete the onboarding process first."),
    /引导尚未完成/,
  );
  assert.throws(
    () => verifyEgoOutput(0, egoReadyMarker + "_NOT_READY"),
    /可用连接/,
  );
  assert.throws(() => verifyEgoOutput(1, egoReadyMarker), /可用连接/);
  assert.doesNotThrow(() =>
    verifyEgoOutput(0, "notice\n" + egoReadyMarker + "\n"),
  );
});
test("preflight consumes actual child output and refuses false success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "product-search-ego-")),
    cli = join(dir, "ego-browser");
  await writeFile(
    cli,
    "#!/bin/sh\nprintf '%s\\n' 'Please complete the onboarding process first.'\n",
    { mode: 0o700 },
  );
  await assert.rejects(preflight(cli), /引导尚未完成/);
  await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' '${egoReadyMarker}' >&2\n`, {
    mode: 0o700,
  });
  assert.equal(await preflight(cli), cli);
  await chmod(cli, 0o600);
  await assert.rejects(resolveEgo(cli, []), /未找到 Ego Lite/);
});
test("legacy browser path settings no longer override automatic discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-search-legacy-"));
  let argument: unknown = "not-called";
  const service = new Service(
    root,
    { available: async () => false, get: async () => "", set: async () => {} },
    "unused",
    { egoPath: "/stale/ego-browser", judgmentEnabled: false },
    {
      preflight: async (configured) => {
        argument = configured;
        return "/fake/ego-browser";
      },
      collect: async () => [],
      judge: async () => {
        throw Error("must not judge");
      },
    },
  );
  assert.equal((await service.environment()).egoReady, true);
  assert.equal(argument, undefined);
});
