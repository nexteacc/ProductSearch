# 0.1 本地测试版交付与验收记录

日期：2026-10-02。性质：第一版可运行本地测试包，不是全部 V1 验收完成。

## 实现

Electron 44.5.1 + TypeScript，Node 22 构建；独立 .app 内含运行时，不依赖 Codex 启动。外部 Ego Lite 负责浏览器。任务服务、参数校验、单任务队列、取消、重启中断标记、运行目录隔离、Jev Noul 批次校验与保存、名单阈值、真实事件回放、本地 MCP 工具均已实现。

样式分为 theme.css 与 components.css，系统字体、系统颜色、窗口菜单和原生 vibrancy。因对比度实测，辅助文本采用系统 label 语义色，强调色前景按对比度计算；不是简单照搬带低透明度的辅助色。尚不宣称严格通过全部 HIG。

## 已运行检查

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| npm run typecheck / build / format:check | 通过 | 静态工程检查 |
| npm test | 11/11 通过 | 采集/判断使用替身，非真实 API |
| 官方 MCP SDK Client 连接 stdio 桥接 | 通过 | 真实协议；任务列表与缺 Key 拒绝，未在 Codex 中注册 |
| strict premium audit | 零发现 | 不代替运行验收 |
| DESIGN.md 官方 lint | 0 errors / 0 warnings | 系统动态颜色以运行时为准 |
| 依赖 audit | 0 vulnerabilities | 本次锁定依赖扫描结果 |
| 最终 .app 自测 | 13 项均通过 | 隔离目录、显式测试数据、虚构 Key |
| axe 设置页与名单页 | 零违规 | 本次视图和 WCAG A/AA 标签范围，不等于全面认证 |
| 780px 桌面布局 | 宽度与 scrollWidth 均为 780 | 未截取 macOS 屏幕 |
| 真实平台新采集 | 两次每平台 3 条，共每次 9 条 | 无 Jev 判断，无默认 150 数量验收 |
| 实时采集事件桥接 | 第二次记录 11 个阶段事件 | capture.jsonl 文件桥接，非依赖 CLI stdout |

真实采集证据：verification/capture-smoke-uVu3Yg/evidence.json 与 verification/capture-smoke-prg1WR/evidence.json。最终安装包自测：verification/package-final/desktop-smoke.json。测试目录不进入安装包。

## 实测发现与修复

1. 原来的固定 JSON Demo 不会启动采集：改为任务服务启动参数化采集脚本，每次独立 raw.json。
2. Ego Lite CLI 日志不是常规逐行 stdout：改成采集侧追加 capture.jsonl，服务侧有序轮询并保存到任务事件。
3. 系统辅助透明色与白字强调色按钮未达本次对比度要求：改用可读系统 label 色和动态前景色，复测零发现。
4. 旧打包工具存在高危依赖报告：升级到 @electron/packager 20.3.0，扫描零漏洞。
5. 本地认证令牌多字节长度风险：按字节验证再常量时间比较；浏览器 Origin 被拒绝。

## 待真实验收

用户在独立应用中保存自己的 API Key 后，验证新采集 → Jev → 名单的完整任务。然后验证默认 150、至少两个主题、至少三次连续真实运行、窗口关闭继续任务、进程重启、真实故障保留、同机客户端通过 MCP 创建和读取真实任务。

尚未做另一台 Mac、Apple Silicon、签名公证、每日定时、长期可靠性或远程 MCP。当前安装包是本机 Intel macOS 15.8 测试版，不将上述事项标记已完成。

Amazon 当前域名为 amazon.com，地址栏页面配送位置为 Update location，未声称确认美国配送 ZIP；Etsy 显示 United States / USD；Pinterest 保持 www.pinterest.com。三者仍可能受地区、登录与个性化影响。

## 交付边界

干净应用包不含历史实验数据、用户目录、配置 Key、connection.json、浏览器配置或测试产物。所有新数据写入独立用户数据目录。源码保留在 apps/product-research；旧实验和 HTML 预览不覆盖。
