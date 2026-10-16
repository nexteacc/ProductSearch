import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  validateConfig,
  candidates,
  activeStatuses,
  questionFor,
  type Config,
  type Run,
  type RunEvent,
  type PlatformResult,
} from "./domain";
import { Store, atomicJson, readJson } from "./store";
import { preflight, collect } from "./ego";
import { judge } from "./jev";
import { judgmentEngines } from "./judgment-engine";
import { issueFor } from "./issues";
import { filterFacts, validateFilters } from "./research-query";
import { UsageGuard, safetyPolicy } from "./safety";
export interface Secrets {
  available(): Promise<boolean>;
  get(): Promise<string>;
  set(key: string): Promise<void>;
}
export interface Settings {
  egoPath?: string;
  judgmentEnabled?: boolean;
  judgmentEngine?: string;
}
export interface Adapters {
  preflight: typeof preflight;
  collect: typeof collect;
  judge: typeof judge;
}
export class Service extends EventEmitter {
  readonly store: Store;
  private running?: { run: Run; controller: AbortController };
  private queue: string[] = [];
  private closing = false;
  private mutation: Promise<unknown> = Promise.resolve();
  private execution?: Promise<void>;
  private usage: UsageGuard;
  constructor(
    root: string,
    private secrets: Secrets,
    private scriptPath: string,
    readonly settings: Settings = {},
    private adapters: Adapters = { preflight, collect, judge },
  ) {
    super();
    this.store = new Store(root);
    this.usage = new UsageGuard(root);
  }
  async init() {
    await this.store.init();
    for (const run of await this.store.list())
      if (activeStatuses.has(run.status)) {
        run.status = "interrupted";
        run.finishedAt = new Date().toISOString();
        run.message = "上次应用退出或中断；不会自动重复采集，请新建运行。";
        await this.store.save(run);
        await this.store.event(run.id, {
          type: "interrupted",
          message: run.message,
        });
      }
  }
  async environment() {
    let dataReady = true;
    try {
      await this.store.checkWritable();
    } catch {
      dataReady = false;
    }
    let egoReady = false,
      egoMessage = "";
    try {
      await this.adapters.preflight();
      egoReady = true;
    } catch (error) {
      egoMessage = (error as Error).message;
    }
    return {
      egoReady,
      dataReady,
      egoMessage,
      keyAvailable: await this.secrets.available(),
      judgmentEnabled: this.settings.judgmentEnabled !== false,
      region: "US",
      scheduling: false,
      issues: this.store.warnings,
    };
  }
  create(input: unknown, sourceRun?: Run): Promise<Run> {
    const operation = this.mutation.then(async () => {
      if (this.closing) throw new Error("应用正在退出，不能创建任务。");
      const config = validateConfig(input);
      config.judgment ??= {
        enabled: this.settings.judgmentEnabled !== false,
        engine: this.settings.judgmentEngine ?? "jev",
      };
      const engine = judgmentEngines(this.adapters.judge).get(
        config.judgment.engine,
      );
      if (config.judgment.enabled && !engine)
        throw new Error("判断引擎尚未支持。");
      if (config.requestId) {
        const old = (await this.store.list()).find(
          (r) => r.config.requestId === config.requestId,
        );
        if (old) {
          const a = {
              ...old.config,
              judgment: old.config.judgment ?? { enabled: true, engine: "jev" },
              requestId: undefined,
            },
            b = { ...config, requestId: undefined };
          if (JSON.stringify(a) !== JSON.stringify(b))
            throw new Error("同一请求编号不能用于不同任务配置。");
          return old;
        }
      }
      if (
        config.judgment.enabled &&
        engine?.requiresKey &&
        !(await this.secrets.available())
      )
        throw new Error("请先在设置中保存 TypeSafe API Key。");
      const run: Run = {
        id: randomUUID(),
        config,
        ...(sourceRun ? { sourceRunId: sourceRun.id } : {}),
        status: "queued",
        createdAt: new Date().toISOString(),
        collected: 0,
        judged: 0,
        recommended: 0,
        totalMs: 0,
        collectMs: 0,
        judgeMs: 0,
        platformResults: config.platforms.map((p) => ({
          platform: p,
          status: "pending",
          count: 0,
          target: config.targets[p],
        })),
      };
      if (this.queue.length >= safetyPolicy.maxQueued)
        throw new Error("待执行任务已达上限，请等待或取消已有任务。");
      await this.usage.reserve("task");
      await this.store.save(run);
      if (sourceRun) {
        await atomicJson(
          join(this.store.dir(run.id), "raw.json"),
          await this.store.raw(sourceRun.id),
        );
        await atomicJson(
          join(this.store.dir(run.id), "platforms.json"),
          sourceRun.platformResults,
        );
      }
      await this.record(run, { type: "queued", message: "任务已排队。" });
      this.queue.push(run.id);
      this.pump();
      return run;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }
  async judgeExisting(id: string, rule: string) {
    const source = await this.store.get(id);
    if (activeStatuses.has(source.status)) throw new Error("请等待采集结束。");
    if (!(await this.store.raw(id)).length)
      throw new Error("没有可判断的数据。");
    return this.create(
      {
        ...source.config,
        requestId: randomUUID(),
        judgmentRule: rule,
        judgment: {
          enabled: true,
          engine: this.settings.judgmentEngine ?? "jev",
        },
      },
      source,
    );
  }
  private pump() {
    if (this.running || this.closing || !this.queue.length) return;
    const id = this.queue.shift()!;
    this.execution = this.execute(id)
      .catch((error) => {
        this.emit("service-error", error);
      })
      .finally(() => {
        this.running = undefined;
        this.pump();
      });
    this.running = { run: { id } as Run, controller: new AbortController() };
  }
  private async record(run: Run, event: Omit<RunEvent, "sequence" | "at">) {
    await this.store.event(run.id, event);
    this.emit("change", run.id);
  }
  private async transition(run: Run, status: Run["status"], message?: string) {
    run.status = status;
    run.message = message;
    await this.store.save(run);
    await this.record(run, { type: status, message });
  }
  private async execute(id: string) {
    const run = await this.store.get(id);
    const controller = this.running!.controller;
    this.running!.run = run;
    const started = performance.now();
    run.startedAt = new Date().toISOString();
    let captureFailed = false;
    try {
      controller.signal.throwIfAborted();
      await this.transition(run, "checking");
      const enabled = run.config.judgment?.enabled !== false;
      const engine = judgmentEngines(this.adapters.judge).get(
        run.config.judgment?.engine ?? "jev",
      );
      if (enabled && !engine) throw new Error("判断引擎尚未支持。");
      const key =
        enabled && engine!.requiresKey ? await this.secrets.get() : "";
      const cli = run.sourceRunId ? "" : await this.adapters.preflight();
      controller.signal.throwIfAborted();
      await atomicJson(join(this.store.dir(id), "rule.json"), {
        enabled,
        engine: enabled ? engine!.id : null,
        version: run.config.judgmentRule
          ? "custom-candidate-noul-v2"
          : "theme-candidate-noul-v1",
        model: enabled ? "jev-latest" : null,
        question: enabled
          ? questionFor(run.config.theme, 0, run.config.judgmentRule)
          : null,
        config: run.config,
      });
      await this.transition(run, "collecting");
      const collectStarted = performance.now();
      try {
        run.platformResults = run.sourceRunId
          ? await readJson<PlatformResult[]>(
              join(this.store.dir(id), "platforms.json"),
              [],
            )
          : await this.adapters.collect(
              run.config,
              this.store.dir(id),
              this.scriptPath,
              cli,
              controller.signal,
              async (event) => {
                if (event.type === "platform_progress") {
                  const result = run.platformResults.find(
                    (r) => r.platform === event.platform,
                  );
                  if (result) result.count = Number(event.count) || 0;
                  run.collected = run.platformResults.reduce(
                    (n, p) => n + p.count,
                    0,
                  );
                  await this.store.save(run);
                }
                await this.record(run, event);
              },
            );
      } catch (error) {
        captureFailed = true;
        run.issue = issueFor(error, "collecting");
        run.platformResults = await readJson<PlatformResult[]>(
          join(this.store.dir(id), "platforms.json"),
          run.platformResults,
        );
        await this.record(run, {
          type: "collection_failed",
          message: `${run.issue.message} ${run.issue.action}`,
        });
      }
      run.collectMs = Math.round(performance.now() - collectStarted);
      const raw = await this.store.raw(id);
      run.collected = raw.length;
      controller.signal.throwIfAborted();
      if (!raw.length) throw new Error("本次没有采集数据。请查看停止原因。");
      if (enabled) {
        await this.transition(run, "judging");
        const decisions = await this.store.decisions(id);
        for (let offset = 0; offset < raw.length; offset += 10) {
          controller.signal.throwIfAborted();
          const batch = raw.slice(offset, offset + 10);
          await this.record(run, {
            type: "batch_started",
            batch: Math.floor(offset / 10) + 1,
            count: batch.length,
          });
          await this.usage.reserve("model", batch.length);
          const result = await engine!.judge(
            batch,
            run.config,
            key,
            controller.signal,
          );
          decisions.push(...result.decisions);
          await this.store.saveDecisions(id, decisions);
          run.judged = decisions.length;
          run.recommended = decisions.filter(
            (d) => d.recommendationScore >= 0.8,
          ).length;
          run.judgeMs += result.durationMs;
          await this.store.save(run);
          await this.record(run, {
            type: "batch_completed",
            batch: Math.floor(offset / 10) + 1,
            count: batch.length,
            durationMs: result.durationMs,
            decisions: result.decisions,
          });
        }
      } else {
        await this.record(run, {
          type: "judgment_skipped",
          message: "已关闭自动判断，展示采集记录。",
        });
      }
      const incomplete =
        captureFailed ||
        run.platformResults.some(
          (p) => p.status !== "completed" || p.count < p.target,
        );
      run.finishedAt = new Date().toISOString();
      run.totalMs = Math.round(performance.now() - started);
      await this.transition(
        run,
        incomplete ? "partial" : "completed",
        incomplete
          ? "已展示成功部分；部分平台未达到目标，请查看执行记录。"
          : undefined,
      );
    } catch (error) {
      run.issue = controller.signal.aborted
        ? issueFor(new Error("取消"), run.status)
        : (run.issue ?? issueFor(error, run.status));
      run.finishedAt = new Date().toISOString();
      run.totalMs = Math.round(performance.now() - started);
      await this.transition(
        run,
        controller.signal.aborted
          ? "cancelled"
          : run.judged > 0
            ? "partial"
            : "failed",
        controller.signal.aborted
          ? "任务已取消，已采集数据和已完成判断保留。"
          : `${run.issue.message} ${run.issue.action}`,
      );
    }
  }
  async cancel(id: string) {
    const run = await this.store.get(id);
    if (this.running?.run.id === id) {
      this.running.controller.abort();
      await this.record(run, {
        type: "cancel_requested",
        message: "已请求取消，正在等待当前操作结束与浏览器清理。",
      });
      return { accepted: true };
    }
    if (run.status === "queued") {
      this.queue = this.queue.filter((x) => x !== id);
      run.finishedAt = new Date().toISOString();
      await this.transition(run, "cancelled", "排队任务已取消。");
      return { accepted: true };
    }
    return { accepted: false };
  }
  async details(id: string) {
    return {
      run: await this.store.get(id),
      events: await this.store.events(id),
    };
  }
  async queryTask(id: string, options: Record<string, unknown> = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new Error("查询参数无效。");
    const offset = options.offset ?? 0,
      limit = options.limit ?? 40,
      eventLimit = options.eventLimit ?? 20;
    if (
      !Number.isInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 100 ||
      !Number.isInteger(eventLimit) ||
      (eventLimit as number) < 1 ||
      (eventLimit as number) > 100
    )
      throw new Error("分页参数无效。");
    if (
      options.threshold !== undefined &&
      ![0.8, 0.9].includes(options.threshold as number)
    )
      throw new Error("推荐分阈值无效。");
    for (const k of ["includeResults", "includeEvents"])
      if (options[k] !== undefined && typeof options[k] !== "boolean")
        throw new Error("查询开关无效。");
    const filters = validateFilters(options.filters);
    const run = await this.store.get(id);
    const response: Record<string, unknown> = { run };
    if (options.includeEvents === true) {
      const events = await this.store.events(id);
      response.events = events.slice(-(eventLimit as number));
      response.eventTotal = events.length;
    }
    if (options.includeResults === true) {
      const raw = await this.store.raw(id);
      const base = await this.results(
        id,
        (options.threshold ?? 0.8) as number,
        0,
        raw.length || 1,
      );
      const rows = filterFacts(base.items, filters);
      const items = rows.slice(
        offset as number,
        (offset as number) + (limit as number),
      );
      const hasMore = (offset as number) + items.length < rows.length;
      response.results = {
        originalTotal: raw.length,
        total: rows.length,
        items,
        mode: base.mode,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? (offset as number) + items.length : null,
        appliedFilters: filters,
        threshold: base.mode === "judged" ? (options.threshold ?? 0.8) : null,
        snapshotStatus: run.status,
      };
    }
    return response;
  }
  async results(id: string, threshold = 0.8, offset = 0, limit = 40) {
    const run = await this.store.get(id);
    const decisions = await this.store.decisions(id);
    if (
      run.config.judgment?.enabled === false ||
      (!activeStatuses.has(run.status) &&
        decisions.length === 0 &&
        run.collected > 0)
    ) {
      const rows = await this.store.raw(id);
      return {
        total: rows.length,
        items: rows.slice(offset, offset + limit),
        mode: "unjudged",
      };
    }
    const rows = candidates(await this.store.raw(id), decisions, threshold);
    return {
      total: rows.length,
      items: rows.slice(offset, offset + limit),
      mode: "judged",
    };
  }
  async shutdown() {
    this.closing = true;
    this.running?.controller.abort();
    if (this.execution) await this.execution;
    for (const id of this.queue) {
      const r = await this.store.get(id);
      r.finishedAt = new Date().toISOString();
      await this.transition(r, "interrupted", "应用退出，排队任务未执行。");
    }
    this.queue = [];
  }
}
