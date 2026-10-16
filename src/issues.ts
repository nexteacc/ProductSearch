export interface Issue {
  code: string;
  message: string;
  action: string;
  stage?: string;
}
export function issueFor(error: unknown, stage?: string): Issue {
  const text = error instanceof Error ? error.message : "";
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  const issue = (code: string, message: string, action: string): Issue => ({
    code,
    message,
    action,
    ...(stage ? { stage } : {}),
  });
  if (/每日.*上限|每日判断额度|待执行任务.*上限|额度记录|系统日期/.test(text))
    return issue(
      "safety_limit",
      "安全额度限制或额度记录异常，操作已停止。",
      "查看任务日志；已有数据保留，等待额度恢复或人工检查，不自动重试。",
    );
  if (["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(String(errno)))
    return issue(
      "storage_unavailable",
      "本地数据无法保存。",
      "检查磁盘空间和应用数据目录权限，再重新启动。",
    );
  if (/本地数据|事件记录损坏|事件无法保存/.test(text))
    return issue(
      "data_unreadable",
      "部分本地数据无法读取。",
      "原文件已保留，请检查该任务；不要删除数据目录。",
    );
  if (/未找到 (ego-browser|Ego Lite)/.test(text))
    return issue(
      "browser_missing",
      "未找到 Ego Lite。",
      "安装 Ego Lite，完成首次启动引导后点击检查连接。",
    );
  if (/Ego Lite|采集命令无法启动/.test(text))
    return issue(
      "browser_unavailable",
      "浏览器未连接或操作已中断。",
      "打开 Ego Lite，在设置中检查连接；已有数据保留，不自动重试。",
    );
  if (/401|403/.test(text))
    return issue(
      "api_auth",
      "判断服务拒绝了 API Key。",
      "在设置中重新保存有效密钥，再判断已采集数据。",
    );
  if (/429/.test(text))
    return issue(
      "api_limit",
      "判断服务暂时限流。",
      "查看服务额度，稍后手动判断已采集数据；不会自动重试。",
    );
  if (/API Key|安全存储/.test(text))
    return issue(
      "key_unavailable",
      "判断密钥未配置或无法读取。",
      "在设置中保存密钥，或关闭自动判断后仅采集。",
    );
  if (/Jev|Noul|模型|answers|概率|判断结果/.test(text))
    return issue(
      "judgment_failed",
      "自动判断未完成。",
      "已采集数据保留，可查看原始名单或稍后补做判断。",
    );
  if (/取消|Abort/.test(text))
    return issue("cancelled", "任务已取消。", "已采集数据和已完成判断保留。");
  if (/采集/.test(text))
    return issue(
      "collection_failed",
      "采集未完成。",
      "查看执行过程和浏览器状态；已保存部分保留，不自动重试。",
    );
  return issue(
    "unexpected",
    "操作未完成。",
    "查看任务状态，检查运行环境后手动重试。",
  );
}
export function safeMessage(error: unknown) {
  const text = error instanceof Error ? error.message : "操作未完成。";
  return text
    .replace(/apikey_[a-zA-Z0-9_-]+/g, "[密钥已隐藏]")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/\/(?:Users|Volumes)\/[^\s，；。]+/g, "[本地路径]");
}
