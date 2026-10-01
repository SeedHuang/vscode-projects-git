// 按路径管理 setTimeout 句柄的轻量 hook。
//
// 用法：每条 "在某路径上做某事、超时兜底取消" 的逻辑都需要：
//   1. 起一个超时 timer（host 没在时限内 ack 时强制取消）
//   2. 在 host 真的 ack 时立刻把这个 timer 关掉
// 重复点：arm / disarm / clearAll 三件套都对同一个 Map 操作。
//
// 本 hook 把这些机械动作收敛在这里，调用方只关心语义（"我要在 5 秒内拿到 ack"）。
import { useCallback, useEffect, useMemo, useRef } from "react";

export interface PathTimersApi {
  /** 起一个按路径索引的兜底 timer；到时若未 disarm 就调用 onTimeout。
   *  同一路径已有 timer 时会先清掉再起（不会泄漏）。 */
  arm(path: string, ms: number, onTimeout: () => void): void;
  /** 立刻清除该路径的 timer（如 host 已 ack）。未起过 timer 是 no-op。 */
  disarm(path: string): void;
  /** 清除所有 timer —— 卸载时调用。 */
  clearAll(): void;
}

export function usePathTimers(): PathTimersApi {
  const timersRef = useRef<Map<string, number>>(new Map());

  // 各函数都包成 useCallback([])，闭包里的 timersRef 是稳定 ref；
  // 同时用 useMemo 一次性返回 API 对象，让引用跨 render 稳定 —— 这样调用方把
  // 它写进 useCallback 的 deps 时不会引起 handler 不必要地重建。
  const arm = useCallback((path: string, ms: number, onTimeout: () => void) => {
    const existing = timersRef.current.get(path);
    if (existing !== undefined) clearTimeout(existing);
    const handle = window.setTimeout(() => {
      timersRef.current.delete(path);
      onTimeout();
    }, ms);
    timersRef.current.set(path, handle);
  }, []);

  const disarm = useCallback((path: string) => {
    const handle = timersRef.current.get(path);
    if (handle === undefined) return;
    clearTimeout(handle);
    timersRef.current.delete(path);
  }, []);

  const clearAll = useCallback(() => {
    for (const handle of timersRef.current.values()) clearTimeout(handle);
    timersRef.current.clear();
  }, []);

  useEffect(() => clearAll, [clearAll]);

  return useMemo(() => ({ arm, disarm, clearAll }), [arm, disarm, clearAll]);
}