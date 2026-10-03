import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("research", {
  onError: (callback: (issue: unknown) => void) => {
    const listener = (_event: unknown, issue: unknown) => callback(issue);
    ipcRenderer.on("research:error", listener);
    return () => ipcRenderer.removeListener("research:error", listener);
  },
  call: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("research:call", method, args),
  onChange: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("research:change", listener);
    return () => ipcRenderer.removeListener("research:change", listener);
  },
  onCommand: (callback: (command: string) => void) => {
    const listener = (_event: unknown, command: string) => callback(command);
    ipcRenderer.on("research:command", listener);
    return () => ipcRenderer.removeListener("research:command", listener);
  },
});
