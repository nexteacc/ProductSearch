# UX Contract

## Product context

商品研究本地测试版；中文界面，美国站。本机时区显示日期；支持当前 macOS 15.8 Intel 测试，其他设备未验收。无障碍目标 WCAG 2.2 AA，尚不宣称全项通过。

## Business-context sources

| 范围                              | 来源                                                            | 核对日期   |
| --------------------------------- | --------------------------------------------------------------- | ---------- |
| 数据生命周期、队列、取消、交付    | ../../outputs/product-research-architecture/v1-delivery-plan.md | 2026-10-02 |
| 80%/90% 阈值、无需 Pinterest 外链 | 用户明确要求；src/domain.ts                                     | 2026-10-02 |
| 密钥边界                          | src/main.ts secrets；Electron safeStorage 官方文档              | 2026-10-02 |
| API 结构                          | https://docs.typesafe.ai/api.md                                 | 2026-10-02 |

不提供数据删除、计费、外部写入、远程用户权限界面。任务调用外部 Jev，启动按钮明确告知。

## Visual contract

DESIGN.md 说明意图；src/ui/theme.css 为主题值源，components.css 为组件样式源。无第二套主题。原始实验界面不改动。

## Canonical UI Map

| Capability | Canonical owner                    | Source of truth    | Allowed variants           | Verification                       |
| ---------- | ---------------------------------- | ------------------ | -------------------------- | ---------------------------------- |
| Form       | renderer.ts field / validateConfig | domain.ts / 本契约 | create / settings          | tests/core.test.ts / desktop smoke |
| Scrollbar  | src/ui/theme.css                   | DESIGN.md          | stable gutter              | computed style                     |
| Toast      | renderer.ts status / globalNotice  | 本契约             | persistent success / error | desktop smoke                      |
| CRUD       | Service / renderer.ts              | 交付计划 / 本契约  | create / read / cancel     | tests/core.test.ts                 |

Select/Listbox、Date、Table Selection 不适用；第一版没有下拉、日期选择与批量行选择。

## Dataset navigation

候选名单：默认 ≥80%，可切 ≥90%；按未四舍五入原分数过滤，显示一位小数以避免显示 90% 但未达阈值。每次 40 条，加载更多。平台与标题检索作用于本次已完成判断的完整有界数据，不只当前页。筛选重置页量，返回同一任务保留筛选。

URL 状态例外：Electron 本地 file 界面，任务与筛选在内存保留，任务历史在服务保存；不需要可分享网页 URL。任何秘密均不进入 URL 或 localStorage。

## Flow ledger

| 操作     | Pending              | 成功                            | 失败                                   |
| -------- | -------------------- | ------------------------------- | -------------------------------------- |
| 新建     | 禁用提交并 aria-busy | 收到服务确认后关闭，进入任务    | 保留输入，表单内错误，首个无效字段聚焦 |
| 保存设置 | 禁用提交             | 清空密钥输入，不回显已保存值    | 保留非敏感字段与修正提示               |
| 取消任务 | 对话框保持直到确认   | 记录 cancel_requested，异步清理 | 对话框内提示                           |
| 阈值筛选 | 本地读取已有分数     | 不再调用模型                    | 保留旧列表和错误提示                   |

## Navigation and overlays

三入口共享壳；菜单设置、新建与按钮行为一致。每页更新标题。dialog 由原生模态能力管理，取消创建时保留输入，不静默丢弃草稿。设置切换保留输入。严重取消初始焦点选择继续运行。关闭窗口只是隐藏，不丢草稿；完全退出后草稿不持久化，任务保存。

## Async and resilience

Service 单队列、requestId 去重，相同编号不同配置拒绝。启动检查环境；失败不自动绕过浏览器风险或无界重试。每次 raw 与 decisions 独立落盘。Jev 有 30 秒超时，拒绝无效返回，不补造分数。只记录数量、阶段及耗时；采集未知总量不伪造百分比。

中断后历史保留，启动标为 interrupted，不自动重做。部分平台与批次保留结果。密钥仅主进程 safeStorage 加密保存；MCP 只查询配置是否存在，不能读取或设置密钥。

## Verification

npm run typecheck；npm test；npm run build；Electron --self-test；strict premium audit。所有测试需真实运行后记录。模拟采集/判断测试必须注明 fixture，不能充当三平台真实验证。正式 key 测试等待用户在应用输入。不要求截取 macOS 屏幕权限。
