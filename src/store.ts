import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  appendFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Run, RunEvent, Observation, Decision } from "./domain";
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("本地数据无法读取，请保留数据目录后检查文件。");
  }
}
export class Store {
  warnings: string[] = [];
  private eventWrites = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}
  dir(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("任务编号无效。");
    return join(this.root, "runs", id);
  }
  async init() {
    await mkdir(join(this.root, "runs"), { recursive: true, mode: 0o700 });
    await this.checkWritable();
  }
  async checkWritable() {
    const path = join(this.root, `.check-${randomUUID()}`);
    await writeFile(path, "", { mode: 0o600, flag: "wx" });
    await unlink(path);
  }
  async save(run: Run) {
    await mkdir(this.dir(run.id), { recursive: true, mode: 0o700 });
    await atomicJson(join(this.dir(run.id), "run.json"), run);
  }
  async list(): Promise<Run[]> {
    this.warnings = [];
    const names = await readdir(join(this.root, "runs"));
    const runs: Run[] = [];
    for (const name of names.filter((n) => /^[0-9a-f-]{36}$/.test(n))) {
      try {
        const run = await this.get(name);
        runs.push(run);
      } catch {
        this.warnings.push("一个任务记录无法读取，原文件已保留。");
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string) {
    const run = await readJson<Run | null>(
      join(this.dir(id), "run.json"),
      null,
    );
    if (!run) throw new Error("找不到该任务。");
    if (
      run.id !== id ||
      typeof run.createdAt !== "string" ||
      !run.config ||
      !Array.isArray(run.config.platforms) ||
      !run.config.targets ||
      typeof run.config.theme !== "string" ||
      typeof run.config.keyword !== "string" ||
      !Array.isArray(run.platformResults) ||
      ![
        "queued",
        "checking",
        "collecting",
        "judging",
        "completed",
        "partial",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(run.status)
    )
      throw new Error("本地数据格式无效。");
    return run;
  }
  async event(id: string, event: Omit<RunEvent, "sequence" | "at">) {
    const operation = (this.eventWrites.get(id) || Promise.resolve()).then(
      async () => {
        const events = await this.events(id);
        const value = {
          ...event,
          sequence: events.length,
          at: new Date().toISOString(),
        };
        await appendFile(
          join(this.dir(id), "events.jsonl"),
          `${JSON.stringify(value)}\n`,
          { mode: 0o600 },
        );
        return value;
      },
    );
    this.eventWrites.set(
      id,
      operation.catch(() => {}),
    );
    return operation;
  }
  async events(id: string): Promise<RunEvent[]> {
    try {
      const lines = (
        await readFile(join(this.dir(id), "events.jsonl"), "utf8")
      ).split("\n");
      return lines
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line);
          } catch {
            if (index === lines.length - 1) return null;
            throw new Error("事件记录损坏。");
          }
        })
        .filter(Boolean);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async raw(id: string) {
    return readJson<Observation[]>(join(this.dir(id), "raw.json"), []);
  }
  async decisions(id: string) {
    return readJson<Decision[]>(join(this.dir(id), "decisions.json"), []);
  }
  async saveDecisions(id: string, data: Decision[]) {
    await atomicJson(join(this.dir(id), "decisions.json"), data);
  }
}
