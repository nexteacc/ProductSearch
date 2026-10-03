import {
  parseAnswers,
  questionFor,
  type Config,
  type Observation,
} from "./domain";
export async function judge(
  batch: Observation[],
  config: Config,
  key: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const state = batch.map((item) => {
    const { imageUrl, sourceUrl, capturedAt, ...facts } = item;
    return facts;
  });
  const questions = Object.fromEntries(
    batch.map((_, i) => [
      `item_${i}`,
      questionFor(config.theme, i, config.judgmentRule),
    ]),
  );
  const started = performance.now();
  let response: Response;
  try {
    response = await request("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
  } catch {
    if (signal.aborted) throw new Error("任务已取消。");
    throw new Error("Jev 请求超时或连接失败，已保存采集数据与完成批次。");
  }
  if (!response.ok)
    throw new Error(
      `Jev HTTP ${response.status}；请检查密钥或服务状态。未自动重试。`,
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Jev 返回格式无效。");
  }
  return {
    decisions: parseAnswers(payload, batch).map((decision) => ({
      ...decision,
      ruleVersion: config.judgmentRule
        ? "custom-candidate-noul-v2"
        : decision.ruleVersion,
    })),
    durationMs: Math.round(performance.now() - started),
  };
}
