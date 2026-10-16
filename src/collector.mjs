import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";
const { config, dir, budget } = globalThis.COLLECTION_INPUT;
const task = await taskSpace(`选品 · ${config.theme}`);
const page = task.page("p1");
const raw = new Map();
const results = [];
let eventWrites = Promise.resolve();
const emit = (event) => {
  const entry = { ...event, observedAt: new Date().toISOString() };
  eventWrites = eventWrites.then(() =>
    appendFile(join(dir, "capture.jsonl"), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    }),
  );
};
const persist = async () => {
  for (const [file, value] of [
    ["raw.json", [...raw.values()]],
    ["platforms.json", results],
  ]) {
    const temp = join(dir, `${file}.capture.tmp`);
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, join(dir, file));
  }
};
const cancelled = async () => {
  try {
    await readFile(join(dir, "cancel.json"));
    return true;
  } catch {
    return false;
  }
};
const check = async () => {
  if (await cancelled()) throw new Error("cancelled");
};
const inspect = async (platform) => {
  const state = await page.evaluate(() => {
    const selectors = [
      'iframe[src*="captcha"]',
      "#captchacharacters",
      'input[name="captcha"]',
    ];
    const signals = selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((node) => {
        let visible = true;
        for (let current = node; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number(style.opacity) === 0 ||
            current.hidden
          )
            visible = false;
        }
        const rect = node.getBoundingClientRect();
        visible &&=
          rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
        return {
          selector,
          visible,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          inViewport:
            visible &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < innerHeight &&
            rect.left < innerWidth,
        };
      }),
    );
    return {
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 900),
      url: location.href,
      challenge: signals.length > 0,
      visibleChallenge: signals.some((s) => s.visible),
      signals,
    };
  });
  const host = new URL(state.url).hostname;
  const expected = {
    amazon: "www.amazon.com",
    etsy: "www.etsy.com",
    pinterest: "www.pinterest.com",
  }[platform];
  const matched = (state.title + " " + state.text).match(
    /verify (you are|that you are) human|robot check|unusual traffic|access denied|security check|captcha|enable javascript and cookies/i,
  );
  const reason =
    host !== expected
      ? "unexpected_host"
      : state.visibleChallenge
        ? "visible_challenge"
        : matched
          ? "security_text"
          : state.challenge &&
              !(
                platform === "pinterest" &&
                state.signals.every(
                  (s) => s.selector === 'iframe[src*="captcha"]' && !s.visible,
                )
              )
            ? "hidden_challenge_unconfirmed"
            : null;
  if (reason) {
    emit({
      type: "environment_stop_evidence",
      platform,
      reason,
      host,
      expectedHost: expected,
      challengeElement: state.challenge,
      visibleChallenge: state.visibleChallenge,
      signals: state.signals,
      spaceId: task.spaceId,
      matchedSignal: matched?.[0] ?? null,
      message: `环境检查停止：${reason}；请在 Ego 空间 ${task.spaceId} 检查页面。`,
    });
    userActionRequired = true;
    throw new Error("blocked");
  }
  if (/\/login|\/signin|\/ap\/signin/.test(new URL(state.url).pathname)) {
    emit({
      type: "environment_stop_evidence",
      platform,
      reason: "login_redirect",
      host,
      message: "环境检查停止：需要登录。",
    });
    userActionRequired = true;
    throw new Error("login");
  }
};
const navigate = async (url, platform, selector) => {
  try {
    await page.goto(url);
  } catch (error) {
    if (error.name !== "PageNavigationTimeoutError") throw error;
  }
  await inspect(platform);
  try {
    await page.waitForSelector(selector, { timeout: 15000 });
  } catch {
    await inspect(platform);
    throw new Error("empty_or_changed");
  }
  await inspect(platform);
};
const capture = (platform, items, sourceUrl, pageNumber) => {
  const capturedAt = new Date().toISOString();
  for (const item of items) {
    if (!item.id || !item.title) continue;
    const key = `${platform}:${item.id}`;
    if (
      !raw.has(key) &&
      [...raw.values()].filter((x) => x.platform === platform).length <
        config.targets[platform]
    )
      raw.set(key, { ...item, platform, sourceUrl, pageNumber, capturedAt });
  }
  return [...raw.values()].filter((x) => x.platform === platform).length;
};
const countFor = (p) =>
  [...raw.values()].filter((x) => x.platform === p).length;
const readRegion = async (platform) =>
  page.evaluate(
    (platform) =>
      platform === "amazon"
        ? (document.querySelector("#glow-ingress-line2")?.textContent?.trim() ??
          null)
        : (document
            .querySelector('a[aria-label^="Update your settings"]')
            ?.getAttribute("aria-label") ?? null),
    platform,
  );
const matchesRegion = (platform, value) =>
  platform === "amazon"
    ? !!value &&
      new RegExp(`\\b${config.amazonPostalCode ?? "11201"}\\b`).test(value)
    : !!value &&
      value.includes("United States") &&
      value.includes("USD") &&
      value.includes("English (US)");
const ensureRegion = async (platform, searchUrl, result) => {
  result.observedRegion = await readRegion(platform);
  emit({
    type: "region_checked",
    platform,
    observedRegion: result.observedRegion,
    message: `目标美国站；当前设置：${result.observedRegion ?? "未能读取"}`,
  });
  if (matchesRegion(platform, result.observedRegion)) return;
  await check();
  emit({
    type: "region_adjusting",
    platform,
    message:
      platform === "amazon"
        ? `设置美国配送邮编 ${config.amazonPostalCode ?? "11201"}`
        : "设置 Etsy United States／English (US)／USD",
  });
  try {
    if (platform === "amazon") {
      await page.click("#nav-global-location-popover-link");
      await page.waitForSelector("#GLUXZipUpdateInput", { timeout: 10000 });
      await inspect(platform);
      await check();
      await page.fill(
        "#GLUXZipUpdateInput",
        config.amazonPostalCode ?? "11201",
      );
      await page.click("#GLUXZipUpdate");
      await page.waitForFunction(
        () =>
          !document.querySelector("#GLUXZipUpdateInput")?.getClientRects()
            .length,
        undefined,
        { timeout: 10000 },
      );
      await page.waitForSelector('button[name="glowDoneButton"]', {
        timeout: 10000,
      });
      await inspect(platform);
      await check();
      await page.click('button[name="glowDoneButton"]');
    } else {
      await page.click('a[aria-label^="Update your settings"]');
      await page.waitForSelector("#locale-overlay-select-region_code", {
        timeout: 10000,
      });
      await inspect(platform);
      await check();
      await page.selectOption("#locale-overlay-select-region_code", "US");
      await page.selectOption("#locale-overlay-select-language_code", "en-US");
      await page.selectOption("#locale-overlay-select-currency_code", "USD");
      await page.click('button[name="save"]');
      await page.waitForFunction(
        () =>
          !document.querySelector("#locale-overlay-select-region_code") &&
          document
            .querySelector('a[aria-label^="Update your settings"]')
            ?.getAttribute("aria-label")
            ?.includes("USD"),
        undefined,
        { timeout: 10000 },
      );
    }
    await check();
    await page.waitForLoadState("load", { timeout: 10000 });
    await navigate(
      searchUrl,
      platform,
      platform === "amazon"
        ? '[data-component-type="s-search-result"][data-asin]'
        : "[data-listing-card-v2][data-listing-id]",
    );
    result.observedRegion = await readRegion(platform);
    if (!matchesRegion(platform, result.observedRegion))
      throw new Error("region_unconfirmed");
    emit({
      type: "region_adjusted",
      platform,
      observedRegion: result.observedRegion,
      message: `已调整并验证：${result.observedRegion}`,
    });
  } catch (error) {
    if (
      ["blocked", "login", "cancelled"].includes(error.message) ||
      /ownership|control|inactive|unassigned/i.test(error.message)
    )
      throw error;
    emit({
      type: "region_adjustment_failed",
      platform,
      observedRegion: result.observedRegion,
      message: `无法确认美国地区设置（${result.observedRegion ?? "未读取"}）；本平台停止，继续其他平台。`,
    });
    throw new Error("region_adjustment_failed");
  }
};
emit({
  type: "browser_space",
  spaceId: task.spaceId,
  message: "本次浏览器任务空间已创建。",
});
let abortAll = false;
let controlLost = false;
let userActionRequired = false;
try {
  for (const platform of config.platforms) {
    if (abortAll || (await cancelled())) break;
    const start = performance.now();
    const allowance = budget.platforms[platform];
    emit({ type: "platform_budget", platform, ...allowance });
    const result = {
      platform,
      status: "pending",
      target: config.targets[platform],
      count: 0,
      stopReason: "",
      observedRegion: null,
    };
    results.push(result);
    emit({ type: "platform_started", platform, count: 0 });
    try {
      if (platform === "amazon" || platform === "etsy") {
        let next =
          platform === "amazon"
            ? `https://www.amazon.com/s?k=${encodeURIComponent(config.keyword)}`
            : `https://www.etsy.com/search?q=${encodeURIComponent(config.keyword)}&instant_download=false`;
        let pageNumber = 0;
        const visited = new Set();
        while (
          next &&
          pageNumber < allowance.units &&
          result.count < result.target
        ) {
          if (performance.now() - start >= allowance.timeoutMs) {
            result.stopReason = "platform_time_budget";
            break;
          }
          await check();
          const allowed = new URL(next);
          if (
            allowed.protocol !== "https:" ||
            allowed.hostname !==
              (platform === "amazon" ? "www.amazon.com" : "www.etsy.com")
          )
            throw new Error("blocked");
          if (visited.has(next)) {
            result.stopReason = "pagination_loop";
            break;
          }
          visited.add(next);
          pageNumber++;
          await navigate(
            next,
            platform,
            platform === "amazon"
              ? '[data-component-type="s-search-result"][data-asin]'
              : "[data-listing-card-v2][data-listing-id]",
          );
          if (pageNumber === 1) await ensureRegion(platform, next, result);
          const output = await page.evaluate(
            ({ platform, pageNumber }) => {
              if (platform === "amazon") {
                const items = [
                  ...document.querySelectorAll(
                    '[data-component-type="s-search-result"][data-asin]',
                  ),
                ].map((card, i) => ({
                  id: card.getAttribute("data-asin"),
                  title: card.querySelector("h2")?.textContent?.trim(),
                  subtitle:
                    card
                      .querySelector(".title-differentiators")
                      ?.getAttribute("aria-label") ?? null,
                  url:
                    card.querySelector('[data-cy="title-recipe"] a')?.href ??
                    card.querySelector("h2")?.closest("a")?.href ??
                    null,
                  imageUrl: card.querySelector("img.s-image")?.src ?? null,
                  priceText:
                    card
                      .querySelector(".a-price .a-offscreen")
                      ?.textContent?.trim() ?? null,
                  ratingText:
                    card
                      .querySelector('[aria-label*="out of 5 stars"]')
                      ?.getAttribute("aria-label") ?? null,
                  boughtText:
                    card.innerText
                      .match(/[^\n]*bought in past month/i)?.[0]
                      ?.trim() ?? null,
                  badgeText:
                    card.querySelector(".a-badge-text")?.textContent?.trim() ??
                    null,
                  reviewCountText:
                    card
                      .querySelector('a[href*="#customerReviews"]')
                      ?.textContent?.trim() ?? null,
                  sponsored: /\bSponsored\b/.test(card.innerText),
                  positionOnPage: i + 1,
                }));
                return {
                  items,
                  next:
                    document.querySelector(".s-pagination-next")?.href ?? null,
                  region:
                    document
                      .querySelector("#glow-ingress-line2")
                      ?.textContent?.trim() ?? null,
                  sort:
                    document.querySelector('select[name="s"]')
                      ?.selectedOptions?.[0]?.textContent ?? null,
                };
              }
              const items = [
                ...document.querySelectorAll(
                  "[data-listing-card-v2][data-listing-id]",
                ),
              ].map((card, i) => {
                const anchor =
                  card
                    .querySelector(
                      'a[href*="/listing/"] h3,a[href*="/listing/"] h2',
                    )
                    ?.closest("a") ??
                  card.querySelector('a[href*="/listing/"]');
                const text = card.innerText.trim();
                return {
                  id: card.getAttribute("data-listing-id"),
                  title:
                    card.querySelector("h3,h2")?.textContent?.trim() ??
                    anchor?.getAttribute("aria-label") ??
                    null,
                  url: anchor
                    ? new URL(anchor.href).origin +
                      new URL(anchor.href).pathname
                    : null,
                  imageUrl: card.querySelector("img")?.src ?? null,
                  priceText:
                    text.match(/(?:Sale Price\s+)?\$\s?[\d,.]+/)?.[0] ?? null,
                  shop: text.match(/From shop\s+([^\n]+)/)?.[1]?.trim() ?? null,
                  ratingText: text.match(/\b[1-5]\.\d\b/)?.[0] ?? null,
                  reviewCountText: text.match(/\(([\d,.]+k?)\)/i)?.[1] ?? null,
                  sponsored: /Ad from shop|Ad・By/.test(text),
                  visibleCardText: text.slice(0, 900),
                  positionOnPage: i + 1,
                };
              });
              const next = [
                ...document.querySelectorAll('a[href*="page="]'),
              ].find(
                (a) =>
                  a.textContent.trim() === "Next" &&
                  new URL(a.href).searchParams.get("page") ===
                    String(pageNumber + 1),
              );
              return {
                items,
                next: next?.href ?? null,
                region:
                  document
                    .querySelector('a[aria-label^="Update your settings"]')
                    ?.getAttribute("aria-label") ?? null,
                sort: null,
              };
            },
            { platform, pageNumber },
          );
          result.observedRegion = output.region;
          if (!matchesRegion(platform, output.region))
            throw new Error("region_unconfirmed");
          result.count = capture(
            platform,
            output.items,
            await page.url(),
            pageNumber,
          );
          await persist();
          emit({
            type: "platform_progress",
            platform,
            count: result.count,
            pageNumber,
            observedRegion: output.region,
            sort: output.sort,
          });
          next = output.next;
          if (!output.items.length) {
            result.stopReason = "no_cards";
            break;
          }
        }
        result.stopReason ||=
          result.count >= result.target
            ? "target_reached"
            : !next
              ? "end_of_results"
              : "page_budget";
      } else {
        const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(config.keyword)}`;
        await navigate(url, platform, 'a[href*="/pin/"]');
        result.observedRegion = "www.pinterest.com";
        emit({
          type: "region_scope",
          platform,
          message:
            "Pinterest 全球站：使用任务关键词，不自动修改账号国家，不保证搜索结果仅来自美国。",
        });
        let stagnant = 0;
        for (
          let step = 0;
          step < allowance.units &&
          result.count < result.target &&
          stagnant < allowance.noGrowthLimit;
          step++
        ) {
          if (performance.now() - start >= allowance.timeoutMs) {
            result.stopReason = "platform_time_budget";
            break;
          }
          await check();
          await inspect(platform);
          const before = result.count;
          const pins = await page.evaluate(() =>
            [...document.querySelectorAll('a[href*="/pin/"]')].map((a) => ({
              id: a.href.match(/\/pin\/(\d+)/)?.[1] ?? null,
              title:
                a
                  .getAttribute("aria-label")
                  ?.replace(/ pin page$/, "")
                  .trim() ||
                a.querySelector("img")?.alt?.trim() ||
                null,
              url: a.href,
              imageUrl: a.querySelector("img")?.src ?? null,
              externalProductUrl: null,
              destinationStatus: "not_checked",
            })),
          );
          result.count = capture(platform, pins, url, 1);
          await persist();
          emit({
            type: "platform_progress",
            platform,
            count: result.count,
            scroll: step,
          });
          if (result.count >= result.target) break;
          stagnant = result.count <= before ? stagnant + 1 : 0;
          const knownIds = [...raw.values()]
            .filter((item) => item.platform === platform)
            .map((item) => item.id);
          const position = await page.evaluate(() => {
            const beforeY = scrollY;
            window.scrollBy(0, Math.max(200, Math.min(900, innerHeight * 0.8)));
            return {
              beforeY,
              afterY: scrollY,
              height: document.documentElement.scrollHeight,
            };
          });
          const waitStarted = performance.now();
          try {
            await page.waitForFunction(
              ({ known }) =>
                [...document.querySelectorAll('a[href*="/pin/"]')].some((a) => {
                  const id = a.href.match(/\/pin\/(\d+)/)?.[1];
                  const title =
                    a
                      .getAttribute("aria-label")
                      ?.replace(/ pin page$/, "")
                      .trim() || a.querySelector("img")?.alt?.trim();
                  return id && title && !known.includes(id);
                }),
              { known: knownIds },
              { timeout: 6000 },
            );
            emit({
              type: "pinterest_wait",
              platform,
              scroll: step,
              outcome: "new_usable_pin",
              durationMs: Math.round(performance.now() - waitStarted),
              ...position,
            });
          } catch (error) {
            const timeout = /timeout|timed out/i.test(
              error.name + " " + error.message,
            );
            emit({
              type: "pinterest_wait",
              platform,
              scroll: step,
              outcome: timeout ? "no_new_usable_pin" : "wait_failed",
              durationMs: Math.round(performance.now() - waitStarted),
              errorName: error.name,
              ...position,
            });
            await inspect(platform);
            if (!timeout) throw error;
          }
        }
        result.stopReason ||=
          result.count >= result.target
            ? "target_reached"
            : stagnant >= allowance.noGrowthLimit
              ? "no_new_records"
              : "scroll_budget";
      }
      result.status = result.count >= result.target ? "completed" : "partial";
    } catch (error) {
      const reason = error.message;
      const controlled = [
        "cancelled",
        "blocked",
        "login",
        "region_unconfirmed",
        "region_adjustment_failed",
        "empty_or_changed",
      ];
      result.stopReason = controlled.includes(reason)
        ? reason
        : "navigation_or_extraction_failed";
      result.status = [
        "blocked",
        "login",
        "region_unconfirmed",
        "region_adjustment_failed",
      ].includes(reason)
        ? "blocked"
        : "failed";
      controlLost ||= /ownership|control|inactive|unassigned/i.test(reason);
      if (["cancelled", "blocked", "login"].includes(reason) || controlLost) {
        abortAll = true;
        emit({
          type: "browser_stopped",
          platform,
          message: "浏览器控制或环境检查停止；不重试、不绕过。",
        });
      }
    }
    result.durationMs = Math.round(performance.now() - start);
    result.count = countFor(platform);
    await persist();
    emit({ type: "platform_finished", ...result });
  }
  for (const platform of config.platforms.filter(
    (p) => !results.some((r) => r.platform === p),
  ))
    results.push({
      platform,
      status: "blocked",
      count: 0,
      target: config.targets[platform],
      stopReason: "previous_environment_stop",
    });
  await persist();
} finally {
  try {
    if (controlLost) throw new Error("control_lost");
    if (userActionRequired) {
      await task.handOff();
      emit({
        type: "browser_handed_off",
        spaceId: task.spaceId,
        message: `采集已停止，现场保留在 Ego 空间 ${task.spaceId}。请检查登录或验证提示；未自动重试。`,
      });
    } else {
      await task.finish({ keep: [] });
      emit({ type: "browser_closed", message: "本次浏览器任务空间已清理。" });
    }
  } catch {
    emit({
      type: "browser_cleanup_required",
      message: "无法确认任务空间清理，请在 Ego Lite 检查。",
    });
  }
  await eventWrites;
}
