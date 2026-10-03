import { join } from "node:path";
import { atomicJson, readJson } from "./store";
export const safetyPolicy = {
  maxQueued: 5,
  dailyTasks: 20,
  dailyModelCalls: 150,
  dailyModelRecords: 1500,
};
export function browserEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
  ])
    if (source[key]) env[key] = source[key];
  env.PATH = `${source.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/node@22/bin`;
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
  return env;
}
export class UsageGuard {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private policy = safetyPolicy,
    private now = () => new Date(),
  ) {}
  reserve(kind: "task" | "model", records = 0): Promise<void> {
    const op = this.writes.then(async () => {
      const now = this.now();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const path = join(this.root, "usage.json");
      const saved = await readJson<{
        day: string;
        tasks: number;
        calls: number;
        records: number;
      } | null>(path, null);
      if (
        saved &&
        (typeof saved.day !== "string" ||
          ![saved.tasks, saved.calls, saved.records].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          ))
      )
        throw new Error("本地额度记录损坏，请检查，未重置额度。");
      if (saved && saved.day > day)
        throw new Error("系统日期早于额度记录，已停止新增调用。");
      const usage =
        saved?.day === day ? saved : { day, tasks: 0, calls: 0, records: 0 };
      if (kind === "task") {
        if (usage.tasks >= this.policy.dailyTasks)
          throw new Error("已达到每日任务上限，未创建新任务。");
        usage.tasks++;
      } else {
        if (!Number.isSafeInteger(records) || records < 1)
          throw new Error("模型计数无效。");
        if (
          usage.calls >= this.policy.dailyModelCalls ||
          usage.records + records > this.policy.dailyModelRecords
        )
          throw new Error(
            "已达到每日判断额度，采集数据已保留，未发起模型请求。",
          );
        usage.calls++;
        usage.records += records;
      }
      await atomicJson(path, usage);
    });
    this.writes = op.catch(() => {});
    return op;
  }
}
