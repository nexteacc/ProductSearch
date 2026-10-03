import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { Config, PlatformResult, RunEvent } from "./domain";
import { atomicJson, readJson } from "./store";
import { executionBudget } from "./collection-policy";
import { browserEnvironment } from "./safety";
export async function resolveEgo(configured?: string) {
  const locations = configured
    ? [configured]
    : [
        join(homedir(), ".local/bin/ego-browser"),
        "/usr/local/bin/ego-browser",
        "/opt/homebrew/bin/ego-browser",
      ];
  for (const path of locations) {
    if (!isAbsolute(path)) continue;
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(
    "未找到 ego-browser，请安装 Ego Lite 或在设置中填写命令路径。",
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
      ["nodejs", "-e", 'await listTaskSpaces(); console.log("ready");'],
      { env: environment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Ego Lite 连接检查超时，请启动浏览器。"));
    }, 12000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("无法启动 Ego Lite 命令。"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve()
        : reject(new Error("Ego Lite 未就绪，请启动浏览器并检查连接。"));
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
