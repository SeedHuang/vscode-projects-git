import type { HostMessage } from "../messages";

// webview 内 acquireVsCodeApi 全局唯一
declare global {
  interface Window { acquireVsCodeApi?: () => { postMessage(msg: unknown): void }; }
}
const api = window.acquireVsCodeApi?.();
export function postHost(m: HostMessage): void {
  api?.postMessage(m);
}