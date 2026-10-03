import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  Menu,
  nativeTheme,
  systemPreferences,
  shell,
  dialog,
} from "electron";
import { join, basename } from "node:path";
import { readFile, access, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Service, type Secrets, type Settings } from "./service";
import { atomicJson, readJson } from "./store";
import { startBridge } from "./bridge";
import { activeStatuses } from "./domain";
import { collectionPolicy } from "./collection-policy";
import { seedDesktopFixture } from "./desktop-fixture";
import { issueFor, safeMessage } from "./issues";
declare const __TEST_ENABLED__: boolean;
app.setName("ProductResearch");
const selfTest = process.argv.includes("--self-test");
const verifyStart = process.argv.includes("--verify-start");
if (selfTest && !__TEST_ENABLED__)
  throw new Error("Production package does not contain test fixtures.");
if (selfTest || verifyStart) {
  if (
    !process.env.PRODUCT_RESEARCH_TEST_DIR ||
    !process.env.PRODUCT_RESEARCH_TEST_DIR.includes("/verification/")
  )
    throw new Error("Self-test requires an isolated verification directory.");
  app.setPath("userData", process.env.PRODUCT_RESEARCH_TEST_DIR);
}
const root = app.getPath("userData");
const base = __dirname;
const uiFile = join(base, "ui", "index.html");
let window: BrowserWindow | undefined;
let service: Service;
let bridge: Awaited<ReturnType<typeof startBridge>>;
let quitting = false;
const secrets: Secrets = {
  async available() {
    try {
      await access(join(root, "typesafe.enc"));
      if (!safeStorage.isEncryptionAvailable()) return false;
      return (
        safeStorage.decryptString(await readFile(join(root, "typesafe.enc")))
          .length >= 16
      );
    } catch {
      return false;
    }
  },
  async get() {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用。");
    try {
      return safeStorage.decryptString(
        await readFile(join(root, "typesafe.enc")),
      );
    } catch {
      throw new Error("无法读取 API Key，请在设置中重新保存。");
    }
  },
  async set(key) {
    if (
      typeof key !== "string" ||
      key.trim().length < 16 ||
      key.length > 2048 ||
      /[\r\n]/.test(key)
    )
      throw new Error("API Key 格式无效。");
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，未保存密钥。");
    const temp = join(root, "typesafe.enc.tmp");
    await writeFile(temp, safeStorage.encryptString(key.trim()), {
      mode: 0o600,
    });
    const { rename } = await import("node:fs/promises");
    await rename(temp, join(root, "typesafe.enc"));
  },
};
function appearance() {
  const mappings = {
    "--surface": "control-background",
    "--window": "window-background",
    "--sidebar": "under-page-background",
    "--text": "text",
    "--secondary": "label",
    "--separator": "separator",
    "--selected": "selected-content-background",
  };
  const colors: Record<string, string> = {};
  for (const [variable, name] of Object.entries(mappings))
    try {
      colors[variable] = systemPreferences.getColor(
        name as Parameters<typeof systemPreferences.getColor>[0],
      );
    } catch {}
  try {
    colors["--accent"] = `#${systemPreferences.getAccentColor()}`;
  } catch {}
  const foreground = (hex: string) => {
    const values = hex
      .slice(1, 7)
      .match(/.{2}/g)
      ?.map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    if (!values) return "#000000";
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 > 0.179
      ? "#000000"
      : "#ffffff";
  };
  if (colors["--accent"])
    colors["--on-accent"] = foreground(colors["--accent"]);
  if (colors["--selected"])
    colors["--selected-text"] = foreground(colors["--selected"]);
  return {
    dark: nativeTheme.shouldUseDarkColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    colors,
  };
}
function mcpConfig() {
  const executable = app.isPackaged
    ? process.execPath
    : join(
        base,
        "..",
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      );
  return {
    mcpServers: {
      "product-research": {
        command: executable,
        args: [join(base, "mcp.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
}
async function dispatch(method: string, args: unknown[]) {
  if (method === "list") return service.store.list();
  if (method === "details") return service.details(String(args[0]));
  if (method === "results") {
    const offset = Number(args[2] ?? 0),
      limit = Number(args[3] ?? 40);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > collectionPolicy.maxTarget * 3
    )
      throw new Error("分页参数无效。");
    return service.results(
      String(args[0]),
      Number(args[1] ?? 0.8),
      offset,
      limit,
    );
  }
  if (method === "create") return service.create(args[0]);
  if (method === "judgeExisting")
    return service.judgeExisting(String(args[0]), String(args[1]));
  if (method === "cancel") return service.cancel(String(args[0]));
  if (method === "environment") return service.environment();
  if (method === "appearance") return appearance();
  if (method === "settings")
    return {
      ...service.settings,
      keyAvailable: await secrets.available(),
      mcp: mcpConfig(),
    };
  if (method === "saveSettings") {
    const values = args[0] as {
      egoPath?: string;
      apiKey?: string;
      judgmentEnabled?: boolean;
      judgmentEngine?: string;
    };
    if (!values || typeof values !== "object")
      throw new Error("设置格式无效。");
    if (
      values.egoPath &&
      (!values.egoPath.startsWith("/") ||
        basename(values.egoPath) !== "ego-browser")
    )
      throw new Error("请选择 ego-browser 的绝对路径。");
    if (
      values.judgmentEnabled !== undefined &&
      typeof values.judgmentEnabled !== "boolean"
    )
      throw new Error("判断开关无效。");
    if (values.judgmentEngine !== undefined && values.judgmentEngine !== "jev")
      throw new Error("判断引擎尚未支持。");
    if (values.apiKey) await secrets.set(values.apiKey);
    service.settings.judgmentEnabled =
      values.judgmentEnabled ?? service.settings.judgmentEnabled ?? true;
    service.settings.judgmentEngine =
      values.judgmentEngine ?? service.settings.judgmentEngine ?? "jev";
    service.settings.egoPath = values.egoPath || undefined;
    await atomicJson(join(root, "settings.json"), service.settings);
    return { saved: true };
  }
  if (method === "openExternal") {
    const url = new URL(String(args[0]));
    const allowed = /^(www\.)?(amazon\.com|etsy\.com|pinterest\.com)$/;
    if (url.protocol !== "https:" || !allowed.test(url.hostname))
      throw new Error("仅允许打开采集平台的 HTTPS 来源链接。");
    await shell.openExternal(url.href);
    return { opened: true };
  }
  if (method === "export") {
    throw new Error("导出功能已暂停。");
  }
  throw new Error("未知应用操作。");
}
function showWindow() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 540,
    title: "商品研究",
    titleBarStyle: "hiddenInset",
    vibrancy: appearance().reducedTransparency ? undefined : "sidebar",
    visualEffectState: "followWindow",
    webPreferences: {
      preload: join(base, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== pathToFileURL(uiFile).href) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window!.hide();
    }
  });
  window.on("closed", () => {
    window = undefined;
  });
  void window.loadFile(uiFile);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app
    .whenReady()
    .then(async () => {
      const settings = await readJson<Settings>(
        join(root, "settings.json"),
        {},
      );
      service = new Service(
        root,
        secrets,
        join(base, "collector.mjs"),
        settings,
      );
      await service.init();
      bridge = await startBridge(service);
      if (__TEST_ENABLED__ && selfTest) await seedDesktopFixture(service.store);
      service.on("change", () => window?.webContents.send("research:change"));
      service.on("service-error", (error) =>
        window?.webContents.send("research:error", issueFor(error)),
      );
      ipcMain.handle("research:call", async (event, method, args) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== pathToFileURL(uiFile).href
        )
          throw new Error("应用访问被拒绝。");
        try {
          return { result: await dispatch(method, args) };
        } catch (error) {
          return { error: safeMessage(error), issue: issueFor(error) };
        }
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "商品研究",
            submenu: [
              { role: "about" },
              {
                label: "设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  showWindow();
                  window?.webContents.send("research:command", "settings");
                },
              },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "文件",
            submenu: [
              {
                label: "新建任务…",
                accelerator: "CmdOrCtrl+N",
                click: () => {
                  showWindow();
                  window?.webContents.send("research:command", "create");
                },
              },
              { role: "close" },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "窗口",
            submenu: [
              { role: "minimize" },
              { role: "zoom" },
              { label: "显示商品研究", click: showWindow },
            ],
          },
        ]),
      );
      nativeTheme.on("updated", () => {
        window?.webContents.send("research:change");
        window?.setVibrancy(
          appearance().reducedTransparency ? null : "sidebar",
        );
      });
      showWindow();
      if (verifyStart) {
        await new Promise<void>((resolve) =>
          window!.webContents.once("did-finish-load", () => resolve()),
        );
        const identity = await window!.webContents.executeJavaScript(
          `({ title: document.title, workbench: !!document.querySelector('#work-view'), noPersonalPath: !document.body.textContent.includes('/Users/'), noExport: ![...document.querySelectorAll('button')].some(b=>b.textContent.includes('导出')), noReplay: ![...document.querySelectorAll('button')].some(b=>b.textContent==='回放') })`,
        );
        await atomicJson(join(root, "clean-start.json"), {
          packaged: app.isPackaged,
          tasks: (await service.store.list()).length,
          keyAvailable: await secrets.available(),
          settings: service.settings,
          writable: true,
          identity,
        });
        app.quit();
      }
      if (__TEST_ENABLED__ && selfTest) {
        await new Promise<void>((resolve) =>
          window!.webContents.once("did-finish-load", () => resolve()),
        );
        await window!.webContents.executeJavaScript(
          'new Promise(resolve => { const check = () => document.querySelector("#status").dataset.level !== "checking" ? resolve(true) : setTimeout(check, 100); check(); })',
        );
        const evidence = await window!.webContents.executeJavaScript(
          `(async()=>{ const checks=[];document.querySelector('#new-task').click();checks.push({name:'create-modal',pass:document.querySelector('#composer').open});document.querySelector('#theme').value='';document.querySelector('#task-form').requestSubmit();checks.push({name:'validation-focus',pass:document.activeElement.id==='theme'});document.querySelector('#composer-close').click();document.querySelector('[data-view="settings"]').click();checks.push({name:'settings',pass:!document.querySelector('#settings-view').hidden});checks.push({name:'masked-key',pass:document.querySelector('#api-key').type==='password'});checks.push({name:'no-secrets-in-storage',pass:localStorage.length===0});checks.push({name:'font',pass:getComputedStyle(document.body).fontFamily.includes('-apple-system')});return checks; })()`,
        );
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(()=>{document.querySelector('#new-task').click();const selects=[...document.querySelectorAll('.platform-row select')];const checks=[{name:'quantity-presets',pass:selects.length===3&&selects.every(s=>[...s.options].map(o=>o.value).join(',')==='150,300,500'&&s.value==='150')},{name:'no-typed-quantity',pass:!document.querySelector('.platform-row input[type="number"]')},{name:'etsy-no-duplicate',pass:[...document.querySelectorAll('.platform-etsy')].every(e=>e.textContent.trim()===''&&e.querySelector('img'))},{name:'amazon-icon-loaded',pass:[...document.querySelectorAll('.platform-amazon img')].every(i=>i.complete&&i.naturalWidth>0)}];selects.forEach(s=>{s.value='500';s.dispatchEvent(new Event('change'));});checks.push({name:'quantity-selectable',pass:selects.every(s=>s.value==='500')});selects.forEach(s=>s.value='150');document.querySelector('#composer-close').click();return checks;})()`,
          )),
        );
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(()=>{document.querySelector('#new-task').click();const rule=document.querySelector('#judgment-rule');const checks=[{name:'judgment-rule-visible',pass:document.querySelector('#composer').open&&rule.tagName==='TEXTAREA'&&rule.value.includes('今日候选名单')}];rule.value='仅纳入页面明确显示可重复使用的托特包';checks.push({name:'judgment-rule-editable',pass:rule.value.includes('可重复使用')&&getComputedStyle(rule).fontFamily===getComputedStyle(document.body).fontFamily});document.querySelector('#composer-close').click();return checks;})()`,
          )),
        );
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(()=>{document.querySelector('[data-view="settings"]').click();const section=document.querySelector('#mcp-section');const checks=[{name:'mcp-collapsed-default',pass:!section.open}];section.querySelector('summary').click();checks.push({name:'mcp-expands',pass:section.open&&section.querySelector('pre')!==null});section.querySelector('summary').click();checks.push({name:'mcp-collapses',pass:!section.open});checks.push({name:'compact-settings',pass:parseFloat(getComputedStyle(section).paddingTop)<parseFloat(getComputedStyle(document.querySelector('#history-view .panel')??section).paddingTop)});return checks;})()`,
          )),
        );
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(()=>{document.querySelector('[data-view="settings"]').click();const rect=n=>n.getBoundingClientRect();const connection=document.querySelector('.connection-row');const status=rect(connection.querySelector('.status-line')),check=rect(connection.querySelector('.button'));const actions=document.querySelector('.settings-actions'),save=rect(actions.querySelector('.button'));return [{name:'settings-connection-aligned',pass:Math.abs((status.top+status.height/2)-(check.top+check.height/2))<2}, {name:'settings-save-right-aligned',pass:Math.abs(save.right-rect(actions).right)<2}, {name:'settings-engine-spacing',pass:document.querySelector('#judgment-engine').closest('.settings-row')!==document.querySelector('#auto-judgment').closest('.settings-row')}, {name:'settings-advanced-collapsed',pass:!document.querySelector('.browser-advanced').open}];})()`,
          )),
        );
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(()=>{const indicator=document.querySelector('#status');const dot=indicator.querySelector('.status-dot');const original=indicator.dataset.level;const colors=['ready','warning','error','checking'].map(level=>{indicator.dataset.level=level;return getComputedStyle(dot).backgroundColor});indicator.dataset.level=original;indicator.click();return [{name:'status-indicator-no-text',pass:indicator.textContent.trim()===''}, {name:'status-indicator-distinct-colors',pass:new Set(colors).size===4}, {name:'status-indicator-tooltip-accessible',pass:!!indicator.title&&indicator.getAttribute('aria-label')===indicator.title}, {name:'status-indicator-opens-settings',pass:!document.querySelector('#settings-view').hidden}];})()`,
          )),
        );
        const resultChecks = await window!.webContents.executeJavaScript(
          `(async()=>{const checks=[];document.querySelector('[data-view="work"]').click();checks.push({name:'fixture-candidates',pass:document.querySelectorAll('.candidate').length===2});[...document.querySelectorAll('button')].find(b=>b.textContent==='≥90%').click();await new Promise(r=>setTimeout(r,200));checks.push({name:'threshold90',pass:document.querySelectorAll('.candidate').length===1});document.querySelector('.candidate').click();checks.push({name:'candidate-detail',pass:document.querySelector('#candidate-title').textContent.includes('Leopard')});checks.push({name:'inspector-not-modal',pass:!document.querySelector('.inspector').hidden&&document.querySelectorAll('dialog[open]').length===0});checks.push({name:'compact-list-row',pass:document.querySelector('.candidate').getBoundingClientRect().height<=88});document.querySelector('#candidate-close').click();const search=document.querySelector('input[type="search"]');search.value='no-match';search.dispatchEvent(new InputEvent('input',{bubbles:true}));checks.push({name:'no-results',pass:document.querySelectorAll('.candidate').length===0});document.querySelector('button[aria-label="清空搜索"]').click();checks.push({name:'search-clear',pass:document.querySelectorAll('.candidate').length===1});checks.push({name:'replay-removed',pass:![...document.querySelectorAll('button')].some(b=>['回放','播放','重放'].includes(b.textContent))});document.querySelector('[data-view="settings"]').click();return checks;})()`,
        );
        evidence.push(...resultChecks);
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(async()=>{const img=document.querySelector('.candidate-image');img.dataset.available='true';img.dispatchEvent(new MouseEvent('mouseenter'));await new Promise(r=>setTimeout(r,250));const pop=document.querySelector('#image-preview'),r=pop.getBoundingClientRect();const checks=[{name:'hover-large-image',pass:!pop.hidden&&r.width>=300},{name:'hover-preview-within-window',pass:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}];img.dispatchEvent(new MouseEvent('mouseleave'));checks.push({name:'hover-preview-dismissed',pass:pop.hidden});delete img.dataset.available;img.dispatchEvent(new MouseEvent('mouseenter'));await new Promise(r=>setTimeout(r,250));checks.push({name:'missing-image-not-enlarged',pass:pop.hidden});return checks;})()`,
          )),
        );
        await window!.webContents.executeJavaScript(
          `(async()=>{document.querySelector('[data-view="work"]').click();[...document.querySelectorAll('button')].find(b=>b.textContent==='≥80%').click();await new Promise(r=>setTimeout(r,200));document.querySelector('.candidate').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`,
        );
        await writeFile(
          join(root, "workbench-preview.png"),
          (await window!.webContents.capturePage()).toPNG(),
        );
        await window!.webContents.executeJavaScript(
          `document.querySelector('#candidate-close').click();document.querySelector('[data-view="settings"]').click();`,
        );
        await secrets.set("fixture-only-not-a-real-typesafe-key");
        evidence.push({
          name: "encrypted-key-roundtrip",
          pass:
            (await secrets.get()) === "fixture-only-not-a-real-typesafe-key" &&
            !(await readFile(join(root, "typesafe.enc"), "utf8")).includes(
              "fixture-only",
            ),
        });
        const axeFile = process.env.PRODUCT_RESEARCH_AXE_FILE;
        let accessibility: unknown = { status: "not-run" };
        if (axeFile) {
          await window!.webContents.executeJavaScript(
            await readFile(axeFile, "utf8"),
          );
          accessibility = await window!.webContents.executeJavaScript(
            '(async()=>{const inspect=async()=>{const r=await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))};const settings=await inspect();document.querySelector("[data-view=work]").click();[...document.querySelectorAll("button")].find(b=>b.textContent==="候选名单").click();return {settingsViolations:settings,listViolations:await inspect()};})()',
          );
        }
        const unjudgedFixture = await seedDesktopFixture(service.store, false);
        await new Promise<void>((resolve) => {
          window!.webContents.once("did-finish-load", () => resolve());
          window!.reload();
        });
        evidence.push(
          ...(await window!.webContents.executeJavaScript(`(async()=>{
          for(let i=0;i<100&&document.querySelectorAll('.candidate').length!==3;i++)await new Promise(r=>setTimeout(r,50));
          const checks=[{name:'raw-records-visible',pass:document.querySelectorAll('.candidate').length===3}, {name:'raw-records-unscored',pass:[...document.querySelectorAll('.candidate')].every(n=>n.textContent.includes('未判断'))}, {name:'export-hidden',pass:![...document.querySelectorAll('button')].some(b=>b.textContent.includes('导出'))}, {name:'raw-threshold-hidden',pass:[...document.querySelectorAll('button')].filter(b=>b.textContent==='≥80%'||b.textContent==='≥90%').every(b=>!b.getClientRects().length)}, {name:'platform-logos-loaded',pass:[...document.querySelectorAll('img.platform-logo')].length>0&&[...document.querySelectorAll('img.platform-logo')].every(n=>n.complete&&n.naturalWidth>0)}];
          [...document.querySelectorAll('button')].find(b=>b.textContent==='判断这批数据').click();checks.push({name:'rejudge-dialog',pass:!!document.querySelector('#existing-rule')&&document.querySelector('#existing-rule').closest('dialog').open});document.querySelector('#existing-rule').closest('dialog').close();
          document.querySelector('[data-view="settings"]').click();await new Promise(r=>setTimeout(r,200));const toggle=document.querySelector('#auto-judgment');toggle.checked=false;toggle.dispatchEvent(new Event('change'));checks.push({name:'engine-disabled-when-off',pass:document.querySelector('#judgment-engine').disabled});document.querySelector('#settings-view form').requestSubmit();await new Promise(r=>setTimeout(r,300));document.querySelector('#new-task').click();checks.push({name:'rule-hidden-when-off',pass:!document.querySelector('#judgment-rule').getClientRects().length});document.querySelector('#composer-close').click();return checks;
        })()`)),
        );
        evidence.push({
          name: "judgment-setting-persisted",
          pass:
            (await readJson<Settings>(join(root, "settings.json"), {}))
              .judgmentEnabled === false,
        });
        const failedFixture = await service.store.get(unjudgedFixture);
        failedFixture.config.judgment = { enabled: true, engine: "jev" };
        failedFixture.status = "failed";
        failedFixture.issue = issueFor(new Error("Jev HTTP 401"), "judging");
        failedFixture.message = `${failedFixture.issue.message} ${failedFixture.issue.action}`;
        await service.store.save(failedFixture);
        await new Promise<void>((resolve) => {
          window!.webContents.once("did-finish-load", () => resolve());
          window!.reload();
        });
        evidence.push(
          ...(await window!.webContents.executeJavaScript(
            `(async()=>{for(let i=0;i<100&&document.querySelectorAll('.candidate').length!==3;i++)await new Promise(r=>setTimeout(r,50));return [{name:'failed-judgment-raw-visible',pass:document.querySelectorAll('.candidate').length===3&&[...document.querySelectorAll('.candidate')].every(n=>n.textContent.includes('未判断'))},{name:'failed-judgment-recovery-message',pass:document.querySelector('.notice:not([hidden])')?.textContent.includes('API Key')},{name:'personal-data-panel-removed',pass:!document.querySelector('#settings-view').textContent.includes('本地数据')&&!document.querySelector('#settings-view').textContent.includes('/Users/')}];})()`,
          )),
        );
        window!.setSize(780, 640);
        const layout = await window!.webContents.executeJavaScript(
          "({width:innerWidth,scroll:document.documentElement.scrollWidth,scrollbar:getComputedStyle(document.documentElement).scrollbarColor})",
        );
        await atomicJson(join(root, "desktop-smoke.json"), {
          packaged: app.isPackaged,
          evidence,
          layout,
          accessibility,
        });
        app.quit();
      }
    })
    .catch((error) => {
      const issue = issueFor(error, "startup");
      dialog.showErrorBox(
        "商品研究无法启动",
        `${issue.message} ${issue.action}`,
      );
      app.quit();
    });
}
app.on("activate", () => {
  if (service) showWindow();
});
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  void service
    .shutdown()
    .then(() => bridge?.close())
    .finally(() => app.quit());
});
