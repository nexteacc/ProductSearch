export interface EnvironmentHealth {
  egoReady: boolean;
  keyAvailable: boolean;
  judgmentEnabled?: boolean;
  dataReady?: boolean;
  issues?: string[];
}
export function environmentStatus(env: EnvironmentHealth) {
  if (env.dataReady === false)
    return { level: "error", label: "本地存储不可用，点击检查设置" };
  if (!env.egoReady)
    return { level: "error", label: "浏览器未连接，点击检查设置" };
  if (env.judgmentEnabled !== false && !env.keyAvailable)
    return {
      level: "warning",
      label: "自动判断需要配置 API Key，点击打开设置",
    };
  if (env.issues?.length)
    return { level: "warning", label: "部分本地记录异常，点击检查设置" };
  return { level: "ready", label: "运行环境就绪，点击打开设置" };
}
