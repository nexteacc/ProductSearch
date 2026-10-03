---
version: alpha
name: 商品研究
description: 面向商品研究人员的本地 macOS 工作台
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    fontSize: "13px"
  utility:
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace'
rounded:
  control: "6px"
  panel: "10px"
  sheet: "12px"
spacing:
  small: "8px"
  medium: "12px"
  large: "20px"
omitted:
  - section: colors
    reason: 系统语义颜色由 macOS 动态提供，运行时主题为唯一值源
  - section: components
    reason: 组件消费共享 CSS 变量，不另建重复配置
---

# 商品研究视觉系统

## Overview

产品型界面。使用场景为当前 Intel Mac 上的商品线索采集、筛选与复查。中文界面，美国平台，时间按用户本机时区显示。用户明确选择 macOS Human Interface Guidelines 方向：系统字体、语义颜色、原生窗口和材质，不保留旧 HTML 的网页式视觉。

第一版不宣称已通过全部 HIG 或无障碍认证。系统控制与渲染器仍需实际检验。

## Colors

模型 B：src/ui/theme.css 是全局主题唯一运行时源。src/main.ts appearance 从系统读取语义颜色和强调色；渲染器只覆盖对应变量，不复制页面色值。未能读取时使用主题的浅深色回退。

| 系统语义                               | 运行时变量            | 共享消费者       |
| -------------------------------------- | --------------------- | ---------------- |
| text / secondary-label                 | --text / --secondary  | 所有文字         |
| control-background / window-background | --surface / --window  | 控件、内容区     |
| separator                              | --separator           | 边框、分隔线     |
| accent / selected-content-background   | --accent / --selected | 操作、导航、分数 |

支持系统浅深色、强调色、减少透明度和强制颜色。未来换主题只改变量映射，不改业务服务。

## Typography

SF Pro 由 macOS 系统字体栈提供，不下载或打包 Apple 字体。常规 13px，辅助 11px，任务标题 20px；数字使用 tabular-nums，技术配置使用系统等宽字体。不使用营销展示字体。

## Layout

208px 左侧导航、60px 工具栏、自然高度内容区。工作台、任务记录、设置共享窗口。名单每次显示 40 条；一任务最多三平台各 500 条，数据有界。列表视图切换不改变设置表单滚动方式。宽度不足时收窄导航；手机宽度仅是布局容错，不是已交付移动版本。

## Elevation & Depth

原生 BrowserWindow vibrancy 承载 sidebar 材质；内容区不透明。减少透明度时关闭 vibrancy，使用实色侧边栏。不用 CSS blur 冒充原生材质。只有 dialog 使用阴影；卡片以分隔线区分。

## Shapes

控件 6px、卡片 10px、sheet 12px。尺寸都由 theme.css 变量集中管理。

## Components

共享 button / field / segment / status / dialog / candidate 样式由 components.css 消费 theme.css。renderer.ts 的 el、button、field、segment 为唯一行为创建入口；页面不新增独立主题。

按钮有 hover、focus-visible、active、disabled、busy；输入有真实 label 与错误关联。模态使用原生 dialog，接受其焦点陷阱、Escape 和恢复行为。不使用自绘下拉菜单。分段选择用 aria-pressed 按钮组，不冒充未实现键盘模型的 ARIA tabs。

原生菜单保留编辑快捷键、⌘N 新建、⌘, 设置、⌘Q 退出。短动画只表示状态；减少动画时不延迟内容。

## Do's and Don'ts

- 系统熟悉感优先于视觉表达；名单为主，过程为辅。
- 不在页面写死颜色、字体和组件圆角。
- 不宣称主题相关性代表销量或质量。
- 不展示模型内部思考；执行过程展示真实日志。

## Sources

- 用户本次 macOS 设计要求。
- https://developer.apple.com/design/human-interface-guidelines/designing-for-macos
- https://www.electronjs.org/docs/latest/api/browser-window
- ../../outputs/product-research-architecture/v1-delivery-plan.md
