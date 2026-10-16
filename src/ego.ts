import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { Config, PlatformResult, RunEvent } from "./domain";
import { atomicJson, readJson } from "./store";
import { executionBudget } from "./collection-policy";
import { browserEnvironment } from "./safety";
export function egoLocations(home = homedir()) {
  return [
    join(home, ".local/bin/ego-browser"),
    join(home, ".local/share/ego/active_version_dir/Helpers/ego-browser"),
    "/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser",
    join(
      home,
      "Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser",
    ),
    "/usr/local/bin/ego-browser",
    "/opt/homebrew/bin/ego-browser",
  ];
}
export async function resolveEgo(
  configured?: string,
  discovered = egoLocations(),
) {
  const locations = configured ? [configured, ...discovered] : discovered;
  for (const path of locations) {
    if (!isAbsolute(path)) continue;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  throw new Error(
    "未找到 Ego Lite，请安装并完成首次启动引导，然后点击检查连接。",
  );
}
export const egoReadyMarker = "PRODUCT_SEARCH_EGO_READY";
export function verifyEgoOutput(code: number | null, output: string) {
  if (/complete.*onboarding|onboarding.*first|初始化|首次.*引导/i.test(output))
    throw new Error(
      "Ego Lite 首次启动引导尚未完成，请在浏览器完成引导后点击检查连接。",
    );
  if (
    code !== 0 ||
    !output.split(/\r?\n/).some((line) => line.trim() === egoReadyMarker)
  )
    throw new Error(
      "Ego Lite 未能建立可用连接，请检查浏览器或系统授权后点击检查连接。",
    );
}
function environment() {
  return browserEnvironment();
}
export async function preflight(configured?: string) {
  const cli = await resolveEgo(configured);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      cli,
      [
        "nodejs",
        "-e",
        `const spaces = await listTaskSpaces(); if (!Array.isArray(spaces)) throw new Error("Invalid browser response"); console.log("${egoReadyMarker}");`,
      ],
      { env: environment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          "Ego Lite 自动连接超时，请完成浏览器引导或系统授权后点击检查连接。",
        ),
      );
    }, 12000);
    let output = "";
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16384);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("无法启动 Ego Lite 命令。"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      try {
        verifyEgoOutput(code, output);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  return cli;
}
export async function collect(
  config: Config,
  dir: string,
  scriptPath: string,
  cli: string,
  signal: AbortSignal,
  onEvent: (event: Omit<RunEvent, "sequence" | "at">) => Promise<void>,
): Promise<PlatformResult[]> {
  const script = await readFile(scriptPath, "utf8");
  const budget = executionBudget(config);
  await atomicJson(join(dir, "budget.json"), budget);
  const source = `globalThis.COLLECTION_INPUT=${JSON.stringify({ config, dir, budget })};\n${script}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, ["nodejs", "-e", source], {
      env: environment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped = false;
    let delivered = 0;
    let eventChain = Promise.resolve();
    let eventError: unknown;
    const drain = () => {
      eventChain = eventChain.then(async () => {
        let contents: string;
        try {
          contents = await readFile(join(dir, "capture.jsonl"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        const lines = contents.split("\n").slice(0, -1);
        while (delivered < lines.length) {
          const event = JSON.parse(lines[delivered]);
          await onEvent(event);
          delivered++;
        }
      });
      return eventChain;
    };
    const poll = setInterval(() => {
      void drain().catch((error) => {
        eventError = error;
      });
    }, 500);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      stopped = true;
    }, budget.timeoutMs);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      void atomicJson(join(dir, "cancel.json"), { cancelled: true });
      cancelTimer = setTimeout(() => {
        child.kill("SIGTERM");
        stopped = true;
      }, 20000);
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearInterval(poll);
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      reject(new Error("采集命令无法启动。"));
    });
    child.once("close", (code) => {
      clearInterval(poll);
      clearTimeout(timeout);
      if (cancelTimer) clearTimeout(cancelTimer);
      signal.removeEventListener("abort", cancel);
      void drain().then(() => {
        if (eventError) reject(new Error("采集事件无法保存。"));
        else if (stopped)
          reject(
            new Error(
              "采集被强制中断；请检查 Ego Lite 中本次任务空间，未确认自动清理。",
            ),
          );
        else if (code !== 0 && !signal.aborted)
          reject(new Error("采集进程失败，已保存已采集部分。"));
        else resolve();
      }, reject);
    });
  });
  return readJson<PlatformResult[]>(join(dir, "platforms.json"), []);
}
