import { collectionPolicy } from "./collection-policy";
import type {
  Run,
  RunEvent,
  Observation,
  Decision,
  Platform,
  Config,
} from "./domain";
import type { Issue } from "./issues";
import { environmentStatus } from "./environment-status";
import {
  activeStatuses,
  defaults,
  validateConfig,
  defaultJudgmentRule,
} from "./domain";
declare global {
  interface Window {
    research: {
      call(
        method: string,
        ...args: unknown[]
      ): Promise<{ result?: unknown; error?: string }>;
      onChange(callback: () => void): () => void;
      onCommand(callback: (command: string) => void): () => void;
      onError(callback: (issue: Issue) => void): () => void;
    };
  }
}
type Candidate = Observation & Partial<Decision>;
function platformLabel(p: Platform) {
  return el(
    "span",
    {
      class: `platform-label platform-${p}`,
      role: "img",
      "aria-label": names[p],
    },
    el("img", {
      class: "platform-logo",
      src: p === "amazon" ? "assets/amazon.ico" : `assets/${p}.svg`,
      alt: "",
      width: "24",
      height: "20",
    }),
    ...(p === "etsy" ? [] : [names[p]]),
  );
}
const names: Record<Platform, string> = {
  amazon: "Amazon",
  etsy: "Etsy",
  pinterest: "Pinterest",
};
const labels: Record<Run["status"], string> = {
  queued: "排队中",
  checking: "检查环境",
  collecting: "采集中",
  judging: "判断中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const reasons: Record<string, string> = {
  target_reached: "达到目标",
  end_of_results: "到达结果末页",
  page_limit: "达到十页上限",
  page_budget: "翻页预算用完",
  scroll_budget: "滚动预算用完",
  no_new_records: "连续没有新增有效记录",
  platform_time_budget: "本平台采集时限用完",
  no_cards: "未发现卡片",
  pagination_loop: "分页循环",
  scroll_limit_or_no_new_records: "滚动上限或没有新增",
  blocked: "平台验证或访问受限",
  login: "需要登录",
  region_unconfirmed: "美国地区未确认",
  region_adjustment_failed: "美国地区自动设置失败；其他平台继续执行",
  empty_or_changed: "没有结果或页面结构变化",
  navigation_or_extraction_failed: "页面导航或提取失败",
  previous_environment_stop: "前一平台环境检查已停止",
  cancelled: "已取消",
};
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== undefined) node.append(c);
  return node;
}
function button(
  text: string,
  action: () => unknown,
  className = "button",
  attrs: Record<string, string> = {},
) {
  const b = el("button", { type: "button", class: className, ...attrs }, text);
  b.addEventListener("click", () => {
    if (!b.disabled) void action();
  });
  return b;
}
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const response = await window.research.call(method, ...args);
  if (response.error) throw new Error(response.error);
  return response.result as T;
}
function status(node: HTMLElement, text: string, error = false) {
  node.textContent = text;
  node.classList.toggle("error", error);
}
function field(id: string, title: string, value = "", type = "text") {
  const input = el("input", {
    id,
    type,
    value,
    "aria-describedby": `${id}-error`,
  });
  const error = el("span", { id: `${id}-error`, class: "field-error" });
  return {
    input,
    error,
    node: el(
      "div",
      { class: "field" },
      el("label", { for: id }, title),
      input,
      error,
    ),
  };
}
const app = document.getElementById("app")!;
const state = {
  view: "work",
  runId: "",
  runs: [] as Run[],
  run: undefined as Run | undefined,
  events: [] as RunEvent[],
  rows: [] as Candidate[],
  platform: "all",
  threshold: 0.8,
  query: "",
  limit: 40,
  panel: "list",
  version: "",
  refreshing: false,
  resultsMode: "judged",
  runtimeIssue: undefined as Issue | undefined,
  dataWarnings: [] as string[],
  selectedKey: "",
  selectedRunId: "",
};
const sidebar = el(
  "aside",
  { class: "sidebar" },
  el("header"),
  el("h2", {}, "Product Search"),
);
const environmentLabel = el(
  "button",
  {
    id: "status",
    class: "environment-label",
    type: "button",
    "data-level": "checking",
    "aria-label": "正在检查运行环境，点击打开设置",
    title: "正在检查运行环境，点击打开设置",
  },
  el("span", { class: "status-dot", "aria-hidden": "true" }),
);
environmentLabel.addEventListener("click", () => showView("settings"));
function setEnvironmentStatus(level: string, label: string) {
  environmentLabel.dataset.level = level;
  environmentLabel.title = label;
  environmentLabel.setAttribute("aria-label", label);
}
const workView = el("section", { id: "work-view" }),
  historyView = el("section", { id: "history-view", hidden: "" }),
  settingsView = el("section", { id: "settings-view", hidden: "" });
const title = el("h1", {}, "工作台");
const newTask = button(
  "新建选品任务",
  () => {
    judgmentEnabled = autoJudgment.checked;
    judgmentField.hidden = !judgmentEnabled;
    composer.showModal();
  },
  "button primary",
  { id: "new-task" },
);
const toolbar = el("header", { class: "toolbar" }, title, newTask);
const globalNotice = el("div", {
  class: "notice error",
  role: "status",
  hidden: "",
});
const content = el(
  "div",
  { class: "content" },
  globalNotice,
  workView,
  historyView,
  settingsView,
);
const workspace = el("main", { class: "workspace" }, toolbar, content);
const nav: Record<string, HTMLButtonElement> = {};
for (const [name, label] of Object.entries({
  work: "工作台",
  history: "选品任务记录",
  settings: "设置",
})) {
  nav[name] = button(label, () => showView(name), "nav-button", {
    "data-view": name,
  });
  sidebar.append(nav[name]);
}
sidebar.append(environmentLabel);
app.append(sidebar, workspace);
function showView(name: string) {
  state.view = name;
  for (const [n, node] of Object.entries(nav))
    node.setAttribute("aria-current", n === name ? "page" : "false");
  workView.hidden = name !== "work";
  historyView.hidden = name !== "history";
  settingsView.hidden = name !== "settings";
  title.textContent =
    { work: "工作台", history: "选品任务记录", settings: "设置" }[name] ||
    "工作台";
  document.title = `${title.textContent} — Product Search`;
  if (name === "settings") void loadSettings();
}
function report(error: unknown) {
  globalNotice.hidden = false;
  globalNotice.textContent =
    (error as Error).message || "应用操作失败，请重试。";
}
const composer = el("dialog", {
  id: "composer",
  "aria-labelledby": "composer-title",
});
const form = el("form", { id: "task-form", novalidate: "" });
const theme = field("theme", "选品产品", "豹纹手机壳"),
  keyword = field("keyword", "搜索关键词", "leopard phone case");
const site = el(
  "select",
  { id: "target-site" },
  el("option", { value: "US" }, "美国（US）"),
);
const judgmentRule = el("textarea", {
  id: "judgment-rule",
  rows: "4",
  maxlength: "2000",
  required: "",
  "aria-describedby": "composer-error",
});
judgmentRule.value = defaultJudgmentRule;
let judgmentEnabled = true;
const judgmentField = el(
  "div",
  { class: "field" },
  el("label", { for: "judgment-rule" }, "判断规则"),
  judgmentRule,
);
const platformFields = {} as Record<
  Platform,
  { check: HTMLInputElement; quantity: HTMLSelectElement }
>;
const platformGroup = el("fieldset", {}, el("legend", {}, "平台与目标采集量"));
for (const p of Object.keys(names) as Platform[]) {
  const check = el("input", {
    type: "checkbox",
    checked: "",
    id: `check-${p}`,
  });
  const quantity = el(
    "select",
    {
      "aria-label": `${names[p]} 目标采集量`,
      "aria-describedby": "composer-error",
    },
    ...[150, 300, 500].map((n) =>
      el("option", { value: String(n) }, String(n)),
    ),
  );
  quantity.value = String(defaults[p]);
  platformFields[p] = { check, quantity };
  platformGroup.append(
    el(
      "div",
      { class: "platform-row" },
      el("label", { for: `check-${p}` }, check, platformLabel(p)),
      quantity,
    ),
  );
}
const formError = el("p", {
  id: "composer-error",
  class: "status-line error",
  role: "status",
});
const submit = el(
  "button",
  { type: "submit", class: "button primary" },
  "开始采集",
);
const composerClose = button("取消", () => composer.close(), "button", {
  id: "composer-close",
});
form.append(
  el("h2", { id: "composer-title" }, "新建选品任务"),
  theme.node,
  keyword.node,
  el(
    "div",
    { class: "field" },
    el("label", { for: "target-site" }, "目标站点"),
    site,
  ),
  judgmentField,
  platformGroup,
  formError,
  el("div", { class: "dialog-actions" }, composerClose, submit),
);
composer.append(form);
document.body.append(composer);
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submit.disabled) return;
  for (const f of [theme, keyword]) {
    f.error.textContent = "";
    f.input.removeAttribute("aria-invalid");
  }
  try {
    const config = validateConfig({
      theme: theme.input.value,
      keyword: keyword.input.value,
      region: site.value,
      judgmentRule: judgmentEnabled ? judgmentRule.value : undefined,
      judgment: { enabled: judgmentEnabled, engine: "jev" },
      platforms: (Object.keys(names) as Platform[]).filter(
        (p) => platformFields[p].check.checked,
      ),
      targets: Object.fromEntries(
        Object.entries(platformFields).map(([p, f]) => [
          p,
          Number(f.quantity.value),
        ]),
      ),
      requestId: crypto.randomUUID(),
    });
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    status(formError, "正在创建任务…");
    const run = await call<Run>("create", config);
    state.runId = run.id;
    state.version = "";
    state.platform = "all";
    state.query = "";
    search.value = "";
    state.limit = 40;
    state.panel = "list";
    composer.close();
    status(formError, "");
    showView("work");
    await refresh();
  } catch (error) {
    status(formError, (error as Error).message, true);
    const invalid = !theme.input.value.trim()
      ? theme
      : !keyword.input.value.trim()
        ? keyword
        : undefined;
    if (invalid) {
      invalid.error.textContent = "请填写此项。";
      invalid.input.setAttribute("aria-invalid", "true");
      invalid.input.focus();
    } else {
      const quantity = (Object.keys(names) as Platform[])
        .map((p) => platformFields[p])
        .find(
          (f) =>
            f.check.checked &&
            (!Number.isInteger(Number(f.quantity.value)) ||
              Number(f.quantity.value) < 1 ||
              Number(f.quantity.value) > 500),
        );
      if (quantity) {
        quantity.quantity.setAttribute("aria-invalid", "true");
        quantity.quantity.focus();
      }
    }
  } finally {
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
  }
});
const empty = el(
  "div",
  { class: "empty" },
  el("h2", {}, "创建你的第一个选品任务"),
  button("新建选品任务", () => composer.showModal(), "button primary"),
);
const taskTitle = el("h2"),
  taskSubtitle = el("div", { class: "muted" }),
  runNotice = el("div", { class: "notice", hidden: "" });
const cancelButton = button(
  "取消任务",
  () => cancelDialog.showModal(),
  "button danger",
);
const rerun = button("重新运行", () => {
  if (!state.run) return;
  theme.input.value = state.run.config.theme;
  keyword.input.value = state.run.config.keyword;
  site.value = state.run.config.region;
  judgmentRule.value = state.run.config.judgmentRule ?? defaultJudgmentRule;
  judgmentEnabled = state.run.config.judgment?.enabled !== false;
  judgmentField.hidden = !judgmentEnabled;
  for (const p of Object.keys(names) as Platform[]) {
    platformFields[p].check.checked = state.run.config.platforms.includes(p);
    platformFields[p].quantity.value = String(
      [150, 300, 500].includes(state.run.config.targets[p])
        ? state.run.config.targets[p]
        : 150,
    );
  }
  composer.showModal();
});
const judgeExistingButton = button("判断这批数据", async () => {
  if (!state.runId) return;
  const sourceId = state.runId;
  const rule = el("textarea", {
    id: "existing-rule",
    rows: "8",
    maxlength: "2000",
    "aria-describedby": "existing-rule-hint",
  });
  rule.value = state.run?.config.judgmentRule || defaultJudgmentRule;
  const message = el("p", { role: "status", class: "status-line" });
  const dialog = el("dialog", {
    class: "judgment-dialog",
    "aria-labelledby": "existing-judgment-title",
    "aria-describedby": "existing-judgment-description",
  });
  const start = button(
    "开始判断",
    async () => {
      start.disabled = true;
      try {
        const run = await call<Run>("judgeExisting", sourceId, rule.value);
        state.runId = run.id;
        state.version = "";
        dialog.close();
        await refresh();
      } catch (error) {
        status(message, (error as Error).message, true);
      } finally {
        start.disabled = false;
      }
    },
    "button primary",
  );
  dialog.append(
    el("h2", { id: "existing-judgment-title" }, "判断这批数据"),
    el(
      "p",
      { id: "existing-judgment-description", class: "muted" },
      `共 ${state.run?.collected ?? 0} 条，使用已有数据。结果另存为新任务。`,
    ),
    el(
      "div",
      { class: "field" },
      el("label", { for: "existing-rule" }, "判断规则"),
      rule,
      el("p", { id: "existing-rule-hint", class: "muted" }, "最多 2000 字"),
    ),
    message,
    el(
      "div",
      { class: "dialog-actions" },
      button("取消", () => dialog.close()),
      start,
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  rule.focus();
  rule.setSelectionRange(0, 0);
  rule.scrollTop = 0;
});
const summary = el("div", { class: "summary" });
const taskHead = el(
  "div",
  { class: "task-heading" },
  el("div", {}, taskTitle, taskSubtitle),
  el("div", { class: "actions" }, cancelButton, rerun, judgeExistingButton),
);
function segment(
  options: [string, string][],
  current: () => string,
  select: (id: string) => void,
) {
  const wrapper = el("div", { class: "segment" });
  for (const [id, text] of options) {
    const b = button(
      text,
      () => {
        select(id);
        update();
      },
      "button",
      { "aria-pressed": String(current() === id) },
    );
    function update() {
      for (const node of wrapper.querySelectorAll("button"))
        node.setAttribute("aria-pressed", String(node === b));
    }
    wrapper.append(b);
    if (id in names) b.replaceChildren(platformLabel(id as Platform));
  }
  return wrapper;
}
const panelSwitch = segment(
  [
    ["list", "候选名单"],
    ["process", "执行过程"],
  ],
  () => state.panel,
  (id) => {
    state.panel = id;
    renderPanels();
  },
);
const listPanel = el("section"),
  processPanel = el("section", { hidden: "" });
const platformSwitch = segment(
  [["all", "全部"], ...Object.entries(names)],
  () => state.platform,
  (id) => {
    state.platform = id;
    state.limit = 40;
    renderRows();
  },
);
const thresholdSwitch = segment(
  [
    ["0.8", "≥80%"],
    ["0.9", "≥90%"],
  ],
  () => String(state.threshold),
  (id) => {
    state.threshold = Number(id);
    state.limit = 40;
    void loadResults().catch(report);
  },
);
const search = el("input", {
  type: "search",
  "aria-label": "搜索候选标题",
  placeholder: "搜索候选标题",
});
const clearSearch = button(
  "×",
  () => {
    search.value = "";
    state.query = "";
    state.limit = 40;
    renderRows();
    search.focus();
  },
  "button",
  { "aria-label": "清空搜索" },
);
const searchBox = el("div", { class: "search" }, search, clearSearch);
search.addEventListener("input", (e) => {
  if (!(e as InputEvent).isComposing) {
    state.query = search.value;
    state.limit = 40;
    renderRows();
  }
});
search.addEventListener("compositionend", () => {
  state.query = search.value;
  state.limit = 40;
  renderRows();
});
const resultCount = el("span", { role: "status" }),
  cards = el("div", { class: "cards" });
const resultLayout = el("div", { class: "result-layout" });
const more = button(
  "加载更多",
  () => {
    state.limit += 40;
    renderRows();
  },
  "button more",
);
listPanel.append(
  el(
    "div",
    { class: "filters" },
    platformSwitch,
    el("div", { class: "actions" }, searchBox, thresholdSwitch),
  ),
  el(
    "div",
    { class: "list-count" },
    resultCount,
    el("span", { id: "list-order" }, "按推荐分排序"),
  ),
  resultLayout,
);
resultLayout.append(el("div", { class: "result-list" }, cards, more));
const flow = el("div", { class: "flow" }),
  platformReports = el("div"),
  timeline = el("ol", { class: "timeline" });
processPanel.append(
  flow,
  platformReports,
  el("div", { class: "panel" }, el("h3", {}, "执行记录"), timeline),
);
const taskBody = el(
  "div",
  {},
  taskHead,
  runNotice,
  summary,
  panelSwitch,
  listPanel,
  processPanel,
);
workView.append(empty, taskBody);
const cancelDialog = el("dialog", { "aria-labelledby": "cancel-title" }),
  cancelError = el("p", { class: "status-line error", role: "status" });
const confirmCancel = button(
  "取消任务",
  async () => {
    try {
      confirmCancel.disabled = true;
      await call("cancel", state.runId);
      cancelDialog.close();
      await refresh();
    } catch (e) {
      status(cancelError, (e as Error).message, true);
    } finally {
      confirmCancel.disabled = false;
    }
  },
  "button danger",
);
cancelDialog.append(
  el("h2", { id: "cancel-title" }, "取消当前任务？"),
  el("p", {}, "已经采集的数据和完成的判断会保留，后续操作停止。"),
  cancelError,
  el(
    "div",
    { class: "dialog-actions" },
    button("继续运行", () => cancelDialog.close()),
    confirmCancel,
  ),
);
document.body.append(cancelDialog);
const detailPanel = el("aside", {
    class: "inspector",
    hidden: "",
    "aria-labelledby": "candidate-title",
  }),
  detailContent = el("div");
const closeDetail = button(
  "关闭详情",
  () => {
    state.selectedKey = "";
    detailPanel.hidden = true;
    resultLayout.classList.remove("has-inspector");
    for (const row of cards.querySelectorAll("button"))
      row.setAttribute("aria-pressed", "false");
  },
  "button inspector-close",
  { id: "candidate-close" },
);
detailPanel.append(
  el(
    "div",
    { class: "inspector-heading" },
    el("h2", {}, "商品详情"),
    closeDetail,
  ),
  detailContent,
);
resultLayout.append(detailPanel);
const imagePreview = el("div", {
  id: "image-preview",
  class: "image-preview",
  hidden: "",
  role: "tooltip",
});
const previewImage = el("img", { alt: "", class: "image-preview-image" });
imagePreview.append(previewImage);
document.body.append(imagePreview);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function hideImagePreview() {
  clearTimeout(previewTimer);
  imagePreview.hidden = true;
  previewImage.removeAttribute("src");
}
function previewFor(img: HTMLImageElement) {
  hideImagePreview();
  if (img.dataset.available !== "true") return;
  previewTimer = setTimeout(() => {
    if (!img.isConnected) return;
    const rect = img.getBoundingClientRect();
    const size = Math.max(
      1,
      Math.min(440, window.innerWidth - 24, window.innerHeight - 24),
    );
    previewImage.src = img.src;
    previewImage.alt = img.alt;
    imagePreview.style.width = `${size}px`;
    imagePreview.style.height = `${size}px`;
    imagePreview.style.left = `${Math.max(12, Math.min(rect.right + 12 + size <= window.innerWidth ? rect.right + 12 : rect.left - size - 12, window.innerWidth - size - 12))}px`;
    imagePreview.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - size - 12))}px`;
    imagePreview.hidden = false;
  }, 180);
}
window.addEventListener("resize", hideImagePreview);
document.addEventListener("scroll", hideImagePreview, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideImagePreview();
});
function image(row: Observation, className: string) {
  const placeholder = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect x="22" y="25" width="36" height="30" rx="4" fill="none" stroke="#8e8e93" stroke-width="2"/><circle cx="33" cy="34" r="3" fill="#8e8e93"/><path d="M25 50l11-11 8 8 5-5 6 8" fill="none" stroke="#8e8e93" stroke-width="2"/></svg>')}`;
  const img = el("img", {
    class: className,
    alt: row.title,
    width: "240",
    height: "160",
    loading: "lazy",
  });
  img.src = placeholder;
  try {
    const url = new URL(row.imageUrl as string);
    if (url.protocol === "https:") {
      img.src = url.href;
      img.dataset.available = "true";
    }
  } catch {}
  img.addEventListener("error", () => {
    if (img.src !== placeholder) img.src = placeholder;
    img.alt = "图片不可用";
    img.dataset.available = "false";
    hideImagePreview();
  });
  img.addEventListener("mouseenter", () => previewFor(img));
  img.addEventListener("mouseleave", hideImagePreview);
  return img;
}
function showCandidate(row: Candidate, reveal = true) {
  state.selectedKey = `${row.platform}:${row.id}`;
  state.selectedRunId = state.runId;
  for (const item of cards.querySelectorAll<HTMLButtonElement>("button"))
    item.setAttribute(
      "aria-pressed",
      String(item.dataset.key === state.selectedKey),
    );
  const facts = el("dl", { class: "facts" });
  for (const [label, value] of [
    ["平台", names[row.platform]],
    ...(row.recommendationScore !== undefined
      ? [["推荐分", `${(row.recommendationScore * 100).toFixed(1)}%`]]
      : [["判断", "未判断"]]),
    ["价格", row.priceText],
    ["评价", row.ratingText],
    ["销量提示", row.boughtText],
    ["采集时间", new Date(row.capturedAt).toLocaleString("zh-CN")],
  ])
    facts.append(
      el("dt", {}, label as string),
      el(
        "dd",
        label === "推荐分"
          ? { title: "与判断规则的匹配程度，不代表销量或商品质量" }
          : {},
        label === "平台"
          ? platformLabel(row.platform)
          : String(value || "未采集"),
      ),
    );
  detailContent.replaceChildren(
    image(row, "detail-image"),
    el("h3", { id: "candidate-title", class: "detail-title" }, row.title),
    facts,
  );
  if (row.url)
    detailContent.append(
      button("打开原始页面", () => call("openExternal", row.url).catch(report)),
    );
  detailPanel.hidden = false;
  resultLayout.classList.add("has-inspector");
  if (reveal && window.innerWidth <= 1000)
    detailPanel.scrollIntoView({ block: "nearest" });
}
function renderRows() {
  hideImagePreview();
  const rows = state.rows.filter(
    (i) =>
      (state.platform === "all" || i.platform === state.platform) &&
      i.title.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()),
  );
  clearSearch.hidden = !search.value;
  const unjudged =
    state.run?.config.judgment?.enabled === false ||
    state.resultsMode === "unjudged";
  thresholdSwitch.hidden = unjudged;
  document.querySelector("#list-order")!.textContent = unjudged
    ? "按采集顺序"
    : "按推荐分排序";
  resultCount.textContent = `${rows.length} 条${unjudged ? "记录" : "候选"} · 已显示 ${Math.min(state.limit, rows.length)} 条`;
  cards.replaceChildren();
  for (const row of rows.slice(0, state.limit)) {
    const b = button("", () => showCandidate(row), "candidate");
    b.dataset.key = `${row.platform}:${row.id}`;
    b.setAttribute(
      "aria-pressed",
      String(
        state.selectedRunId === state.runId &&
          state.selectedKey === b.dataset.key,
      ),
    );
    b.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = [...cards.querySelectorAll<HTMLButtonElement>("button")];
      const next =
        buttons[buttons.indexOf(b) + (event.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      next?.click();
    });
    b.setAttribute(
      "aria-label",
      row.recommendationScore === undefined
        ? `${row.title}，未判断`
        : `${row.title}，推荐分 ${(row.recommendationScore * 100).toFixed(1)}%`,
    );
    b.append(
      image(row, "candidate-image"),
      el(
        "div",
        { class: "body" },
        el("h3", {}, row.title),
        el(
          "div",
          { class: "price" },
          [row.priceText, row.ratingText].filter(Boolean).join(" · ") || "—",
        ),
      ),
      platformLabel(row.platform),
      el(
        "span",
        { class: "score" },
        row.recommendationScore === undefined
          ? "未判断"
          : `${(row.recommendationScore * 100).toFixed(1)}%`,
      ),
    );
    cards.append(b);
  }
  if (!rows.length)
    cards.append(
      el(
        "p",
        { class: "muted" },
        state.run?.judged
          ? "没有匹配候选，请调整平台、阈值或清空搜索。"
          : unjudged
            ? "暂无采集记录。"
            : "判断结果尚未生成。",
      ),
    );
  more.hidden = rows.length <= state.limit;
  const selected = rows
    .slice(0, state.limit)
    .find((row) => `${row.platform}:${row.id}` === state.selectedKey);
  if (state.selectedRunId !== state.runId || !selected) closeDetail.click();
  else if (!detailPanel.hidden) showCandidate(selected, false);
}
function describe(event: RunEvent) {
  if (event.type === "platform_progress")
    return `${names[event.platform!]} 已采集 ${event.count} 条`;
  if (event.type === "platform_finished")
    return `${names[event.platform!]} ${event.count} 条 · ${reasons[String(event.stopReason)] || event.stopReason || "完成"}`;
  if (event.type === "batch_completed")
    return `Jev 第 ${event.batch} 批完成 · ${event.count} 条 · ${(Number(event.durationMs) / 1000).toFixed(2)} 秒`;
  if (event.type === "batch_started") return `Jev 第 ${event.batch} 批开始`;
  return (
    event.message ||
    labels[event.type as Run["status"]] ||
    {
      platform_started: "开始平台采集",
      browser_space: "浏览器已连接",
      browser_closed: "浏览器已清理",
    }[event.type] ||
    event.type
  );
}
function eventRow(event: RunEvent) {
  return el(
    "li",
    {},
    el(
      "time",
      { datetime: event.at },
      new Date(event.at).toLocaleTimeString("zh-CN"),
    ),
    describe(event),
  );
}
function renderPanels() {
  listPanel.hidden = state.panel !== "list";
  processPanel.hidden = state.panel !== "process";
}
function renderRun() {
  const run = state.run;
  empty.hidden = !!run;
  taskBody.hidden = !run;
  if (!run) return;
  taskTitle.textContent = run.config.theme;
  taskSubtitle.textContent = `${run.config.keyword} · 美国站 · ${new Date(run.createdAt).toLocaleString("zh-CN")}`;
  const handoff = [...state.events]
    .reverse()
    .find((e) => e.type === "browser_handed_off");
  runNotice.hidden = !run.message && !handoff;
  runNotice.textContent = handoff?.message || run.message || "";
  summary.replaceChildren(
    el("span", {}, labels[run.status]),
    el("span", {}, `采集 ${run.collected} 条`),
    ...(run.config.judgment?.enabled === false
      ? [el("span", {}, "未判断")]
      : [
          el("span", {}, `判断 ${run.judged} 条`),
          el("span", {}, `≥80% ${run.recommended} 条`),
        ]),
    el("span", { id: "elapsed" }, elapsed(run)),
  );
  cancelButton.hidden = !activeStatuses.has(run.status);
  rerun.hidden = activeStatuses.has(run.status);
  judgeExistingButton.hidden = !run.collected || activeStatuses.has(run.status);
  flow.replaceChildren(
    ...[
      ["采集", run.collected, run.collectMs],
      ...(run.config.judgment?.enabled === false
        ? [["未判断", run.collected, 0]]
        : [
            ["判断", run.judged, run.judgeMs],
            ["候选 ≥80%", run.recommended, 0],
          ]),
    ].map(([label, n, ms]) =>
      el(
        "div",
        {},
        String(label),
        el("strong", {}, `${n} 条`),
        el(
          "span",
          { class: "muted" },
          ms ? `${(Number(ms) / 1000).toFixed(1)} 秒` : "",
        ),
      ),
    ),
  );
  platformReports.replaceChildren(
    ...run.platformResults.map((p) =>
      el(
        "div",
        { class: "notice" },
        platformLabel(p.platform),
        ` · ${p.count} / ${p.target} 条 · ${p.stopReason ? reasons[p.stopReason] || p.stopReason : "待采集"}${p.observedRegion ? ` · ${p.observedRegion}` : ""}`,
      ),
    ),
  );
  timeline.replaceChildren(...state.events.slice(-100).map(eventRow));
  renderPanels();
}
function elapsed(run: Run) {
  const ms =
    activeStatuses.has(run.status) && run.startedAt
      ? Date.now() - Date.parse(run.startedAt)
      : run.totalMs;
  return `总耗时 ${(ms / 1000).toFixed(1)} 秒`;
}
async function loadResults() {
  const id = state.runId,
    threshold = state.threshold;
  if (!id) return;
  const response = await call<{ items: Candidate[]; mode: string }>(
    "results",
    id,
    threshold,
    0,
    collectionPolicy.maxTarget * 3,
  );
  if (state.runId !== id || state.threshold !== threshold) return;
  state.rows = response.items;
  state.resultsMode = response.mode;
  renderRows();
}
function renderHistory() {
  historyView.replaceChildren(el("h2", {}, "选品任务记录"));
  if (!state.runs.length) {
    historyView.append(el("p", { class: "muted" }, "尚无任务。"));
    return;
  }
  const panel = el("div", { class: "panel" });
  for (const run of state.runs)
    panel.append(
      el(
        "div",
        { class: "history-row" },
        el(
          "div",
          {},
          el("strong", {}, run.config.theme),
          el(
            "small",
            {},
            `${new Date(run.createdAt).toLocaleString("zh-CN")} · ${labels[run.status]}`,
          ),
          ...(run.issue
            ? [el("small", { class: "error" }, run.issue.message)]
            : []),
        ),
        el("span", {}, `${run.collected} 条采集 / ${run.recommended} 条候选`),
        button("查看", async () => {
          state.runId = run.id;
          state.version = "";
          await refresh();
          showView("work");
        }),
      ),
    );
  historyView.append(panel);
}
const key = field("api-key", "TypeSafe API Key", "", "password");
key.input.autocomplete = "off";
const reveal = button(
  "显示",
  () => {
    const shown = key.input.type === "text";
    key.input.type = shown ? "password" : "text";
    reveal.textContent = shown ? "显示" : "隐藏";
    reveal.setAttribute("aria-label", shown ? "显示 API Key" : "隐藏 API Key");
    reveal.setAttribute("aria-pressed", String(!shown));
  },
  "button",
  { "aria-label": "显示 API Key", "aria-pressed": "false" },
);
key.node.replaceChildren(
  el("label", { for: "api-key" }, "TypeSafe API Key"),
  el("div", { class: "key-field" }, key.input, reveal),
  key.error,
);
const autoJudgment = el("input", {
  type: "checkbox",
  id: "auto-judgment",
  checked: "",
});
const engine = el(
  "select",
  { id: "judgment-engine", "aria-label": "判断引擎" },
  el("option", { value: "jev" }, "Jev"),
);
autoJudgment.addEventListener("change", () => {
  engine.disabled = !autoJudgment.checked;
});
const settingsStatus = el("p", { class: "status-line", role: "status" }),
  connectionStatus = el("p", { class: "status-line", role: "status" }),
  mcpText = el("pre", { class: "code" }),
  readinessStatus = el("p", {
    class: "status-line",
    role: "status",
    id: "readiness-status",
  });
const checkConnection = button("检查连接", () => checkEnvironment());
const settingsForm = el("form", { novalidate: "", class: "settings-form" });
const saveSettings = el(
  "button",
  { type: "submit", class: "button primary" },
  "保存设置",
);
settingsForm.append(
  el(
    "div",
    { class: "panel" },
    el("h2", {}, "自动判断"),
    el(
      "div",
      { class: "settings-row" },
      el(
        "label",
        { for: "auto-judgment", class: "platform-label" },
        autoJudgment,
        "启用自动判断",
      ),
    ),
    el(
      "div",
      { class: "settings-row" },
      el("label", { for: "judgment-engine" }, "判断引擎"),
      engine,
    ),
    key.node,
    settingsStatus,
  ),
  el(
    "div",
    { class: "panel" },
    el("h2", {}, "Ego Lite 状态"),
    readinessStatus,
    el(
      "div",
      { class: "settings-row connection-row" },
      connectionStatus,
      checkConnection,
    ),
  ),
  el("div", { class: "settings-actions" }, settingsStatus, saveSettings),
);
settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saveSettings.disabled) return;
  saveSettings.disabled = true;
  saveSettings.setAttribute("aria-busy", "true");
  try {
    await call("saveSettings", {
      apiKey: key.input.value,
      judgmentEnabled: autoJudgment.checked,
      judgmentEngine: engine.value,
    });
    key.input.value = "";
    judgmentEnabled = autoJudgment.checked;
    judgmentField.hidden = !judgmentEnabled;
    key.input.type = "password";
    reveal.textContent = "显示";
    reveal.setAttribute("aria-pressed", "false");
    status(settingsStatus, "设置已保存。");
    await checkEnvironment();
  } catch (error) {
    status(settingsStatus, (error as Error).message, true);
  } finally {
    saveSettings.disabled = false;
    saveSettings.removeAttribute("aria-busy");
  }
});
settingsView.append(
  settingsForm,
  el(
    "details",
    { class: "panel mcp-panel", id: "mcp-section" },
    el("summary", {}, "本地 MCP"),
    mcpText,
    button("复制配置", async () => {
      try {
        await navigator.clipboard.writeText(mcpText.textContent || "");
        status(settingsStatus, "MCP 配置已复制。");
      } catch {
        status(settingsStatus, "无法复制，请手动选择配置文本。", true);
      }
    }),
  ),
);
async function loadSettings() {
  try {
    const settings = await call<{
      keyAvailable: boolean;
      judgmentEnabled?: boolean;
      judgmentEngine?: string;
      mcp: unknown;
    }>("settings");
    judgmentEnabled = settings.judgmentEnabled ?? true;
    autoJudgment.checked = judgmentEnabled;
    engine.value = settings.judgmentEngine ?? "jev";
    engine.disabled = !judgmentEnabled;
    judgmentField.hidden = !judgmentEnabled;
    key.input.placeholder = settings.keyAvailable
      ? "已保存；留空保持原密钥"
      : "粘贴 API Key";
    mcpText.textContent = JSON.stringify(settings.mcp, null, 2);
  } catch (error) {
    report(error);
  }
}
async function checkEnvironment() {
  if (checkConnection.disabled) return;
  checkConnection.disabled = true;
  checkConnection.setAttribute("aria-busy", "true");
  setEnvironmentStatus("checking", "正在检查运行环境，点击打开设置");
  status(connectionStatus, "正在自动连接 Ego Lite…");
  try {
    const env = await call<{
      egoReady: boolean;
      keyAvailable: boolean;
      egoMessage: string;
      judgmentEnabled?: boolean;
      dataReady?: boolean;
      issues?: string[];
    }>("environment");
    const indicator = environmentStatus(env);
    setEnvironmentStatus(indicator.level, indicator.label);
    status(
      connectionStatus,
      env.egoReady ? "Ego Lite 已连接。" : env.egoMessage,
      !env.egoReady,
    );
    status(
      readinessStatus,
      env.dataReady === false
        ? "本地数据无法保存，请检查磁盘空间和权限。"
        : env.issues?.length
          ? env.issues[0]
          : "",
      env.dataReady === false || !!env.issues?.length,
    );
    state.dataWarnings = env.issues ?? [];
  } catch (error) {
    status(connectionStatus, (error as Error).message, true);
    setEnvironmentStatus("error", "运行环境检查失败，点击检查设置");
  } finally {
    checkConnection.disabled = false;
    checkConnection.removeAttribute("aria-busy");
  }
}
async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const runs = await call<Run[]>("list");
    state.runs = runs;
    if (!state.runId && runs.length) state.runId = runs[0].id;
    renderHistory();
    if (state.runId) {
      const id = state.runId;
      const detail = await call<{ run: Run; events: RunEvent[] }>(
        "details",
        id,
      );
      if (state.runId !== id) return;
      const version = JSON.stringify(detail);
      if (version !== state.version) {
        state.version = version;
        state.run = detail.run;
        state.events = detail.events;
        renderRun();
        await loadResults();
      }
    } else renderRun();
    globalNotice.hidden = !state.runtimeIssue && !state.dataWarnings.length;
    if (state.runtimeIssue)
      globalNotice.textContent = `${state.runtimeIssue.message} ${state.runtimeIssue.action}`;
    else if (state.dataWarnings.length)
      globalNotice.textContent = state.dataWarnings[0];
  } catch (error) {
    report(error);
  } finally {
    state.refreshing = false;
  }
}
async function applyAppearance() {
  try {
    const value = await call<{
      dark: boolean;
      reducedTransparency: boolean;
      colors: Record<string, string>;
    }>("appearance");
    document.documentElement.style.colorScheme = value.dark ? "dark" : "light";
    for (const [name, color] of Object.entries(value.colors))
      if (/^--[a-z-]+$/.test(name) && /^#[0-9a-f]{6,8}$/i.test(color))
        document.documentElement.style.setProperty(name, color);
    sidebar.style.background = value.reducedTransparency
      ? "var(--sidebar)"
      : "transparent";
  } catch {}
}
window.research.onChange(() => {
  void refresh();
  void applyAppearance();
});
window.research.onError((issue) => {
  state.runtimeIssue = issue;
  globalNotice.hidden = false;
  globalNotice.textContent = `${issue.message} ${issue.action}`;
});
window.research.onCommand((command) => {
  if (command === "settings") showView("settings");
  else if (command === "create") newTask.click();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  if (!document.hidden) void refresh();
  if (state.run) {
    const node = document.getElementById("elapsed");
    if (node) node.textContent = elapsed(state.run);
  }
}, 2000);
showView("work");
void applyAppearance();
void refresh();
void loadSettings();
void checkEnvironment();
