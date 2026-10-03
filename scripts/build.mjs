import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";
const release = process.argv.includes("--release");
await mkdir("dist/ui", { recursive: true });
await Promise.all(
  ["main", "mcp", "preload"].map((name) =>
    build({
      entryPoints: [`src/${name}.ts`],
      outfile: `dist/${name}.cjs`,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      external: ["electron"],
      define: { __TEST_ENABLED__: String(!release) },
      minifySyntax: release,
    }),
  ),
);
await build({
  entryPoints: ["src/renderer.ts"],
  outfile: "dist/ui/app.js",
  bundle: true,
  platform: "browser",
  target: "chrome130",
});
await copyFile("src/ui/index.html", "dist/ui/index.html");
await copyFile("src/ui/theme.css", "dist/ui/theme.css");
await copyFile("src/ui/components.css", "dist/ui/components.css");
await cp("src/ui/assets", "dist/ui/assets", { recursive: true });
await copyFile("src/collector.mjs", "dist/collector.mjs");
console.log("Built desktop application, collectors and MCP bridge.");
