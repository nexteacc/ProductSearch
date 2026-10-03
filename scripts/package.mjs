import { packager } from "@electron/packager";
import { listPackage, extractFile } from "@electron/asar";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const architecture = process.env.PRODUCT_RESEARCH_ARCH || "x64";
if (!["x64", "arm64"].includes(architecture))
  throw new Error("Unsupported release architecture");
const stage = await mkdtemp(join(tmpdir(), "product-research-release-"));
const packageTemp = await mkdtemp(join(tmpdir(), "product-research-pack-"));
const files = [
  "dist/main.cjs",
  "dist/mcp.cjs",
  "dist/preload.cjs",
  "dist/collector.mjs",
  "dist/ui/app.js",
  "dist/ui/index.html",
  "dist/ui/theme.css",
  "dist/ui/components.css",
  "dist/ui/assets/pinterest.svg",
  "dist/ui/assets/etsy.svg",
  "dist/ui/assets/amazon.ico",
];
for (const file of files) {
  await mkdir(join(stage, file, ".."), { recursive: true });
  await copyFile(file, join(stage, file));
}
await writeFile(
  join(stage, "package.json"),
  JSON.stringify({
    name: metadata.name,
    productName: metadata.productName,
    version: metadata.version,
    main: metadata.main,
    type: metadata.type,
  }),
);
const paths = await packager({
  dir: stage,
  name: "ProductResearch",
  platform: "darwin",
  arch: architecture,
  electronVersion: metadata.devDependencies.electron,
  out: resolve("release"),
  overwrite: true,
  asar: true,
  prune: false,
  tmpdir: packageTemp,
  appBundleId: "local.productresearch.desktop",
});
const archive = join(
  paths[0],
  "ProductResearch.app",
  "Contents",
  "Resources",
  "app.asar",
);
const entries = listPackage(archive, { isPack: false }).map((p) =>
  p.replace(/^\//, ""),
);
const permitted = new Set([...files, "package.json"]);
const directories = new Set(["dist", "dist/ui", "dist/ui/assets"]);
for (const entry of entries)
  if (!permitted.has(entry) && !directories.has(entry))
    throw new Error(`Unexpected packaged entry: ${entry}`);
const hashes = [];
for (const file of permitted) {
  const data = extractFile(archive, file);
  if (
    /\/(?:Users|Volumes)\/[^\s"'\\]+|apikey_[a-zA-Z0-9_-]{24,}|desktop-test-fixture|fixture-only-not-a-real/.test(
      data.toString("utf8"),
    )
  )
    throw new Error(`Privacy or test-fixture audit failed: ${file}`);
  hashes.push({
    file,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await copyFile("docs/USER_GUIDE.zh-CN.md", join(paths[0], "使用说明.md"));
const output = resolve(
  "release",
  `ProductResearch-${metadata.version}-macOS-${architecture}.zip`,
);
execFileSync("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  paths[0],
  output,
]);
const zipHash = createHash("sha256")
  .update(await readFile(output))
  .digest("hex");
await writeFile(
  resolve(
    "release",
    `ProductResearch-${metadata.version}-${architecture}-release-audit.json`,
  ),
  JSON.stringify(
    {
      version: metadata.version,
      platform: "macOS",
      architecture,
      signed: false,
      notarized: false,
      packaging: "allowlist",
      personalDataIncluded: false,
      syntheticTestFixturesIncluded: false,
      artifact: basename(output),
      sha256: zipHash,
      files: hashes,
    },
    null,
    2,
  ),
);
console.log(`Audited delivery: ${basename(output)}`);
