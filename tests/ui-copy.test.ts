import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("界面只保留必要的操作文案", async () => {
  const source = await readFile(
    new URL("../src/renderer.ts", import.meta.url),
    "utf8",
  );
  for (const text of [
    "采集前按目标调整",
    "填写选品产品和关键词，采集平台商品信息。",
    "自动识别并连接 Ego Lite，无需手动配置。",
    "未进行自动判断",
    "全球搜索，非美国专属结果",
  ])
    assert.ok(!source.includes(text), text);
  assert.ok(source.includes("结果另存为新任务。"));
  assert.ok(source.includes("最多 2000 字"));
  assert.ok(
    source.includes('title: "与判断规则的匹配程度，不代表销量或商品质量"'),
  );
});
