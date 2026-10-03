import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { atomicJson } from "./store";
import type { Service } from "./service";
import { safeMessage, issueFor } from "./issues";
export async function startBridge(service: Service) {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const provided = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      req.headers.origin ||
      Buffer.byteLength(provided) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "POST" || req.url !== "/rpc")
        throw new Error("仅支持本地任务接口。");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16000) throw new Error("请求过长。");
      }
      const { method, args = [] } = JSON.parse(body);
      let result: unknown;
      if (method === "list") result = await service.store.list();
      else if (method === "create") result = await service.create(args[0]);
      else if (method === "judgeExisting")
        result = await service.judgeExisting(args[0], args[1]);
      else if (method === "details") result = await service.details(args[0]);
      else if (method === "queryTask")
        result = await service.queryTask(args[0], args[1]);
      else if (method === "results") {
        const offset = args[2] ?? 0,
          limit = args[3] ?? 40;
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new Error("分页参数无效。");
        result = await service.results(args[0], args[1] ?? 0.8, offset, limit);
      } else if (method === "cancel") result = await service.cancel(args[0]);
      else if (method === "environment") result = await service.environment();
      else throw new Error("未知本地任务操作。");
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ error: safeMessage(error), issue: issueFor(error) }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const discovery = join(service.store.root, "connection.json");
  await atomicJson(discovery, { port, token, pid: process.pid });
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(discovery).catch(() => {});
    },
    port,
  };
}
