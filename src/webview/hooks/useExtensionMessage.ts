// 订阅 host 消息；handler 用 ref 避免重订阅
import { useEffect, useRef } from "react";
import type { WebviewMessage } from "../../messages";

export function useExtensionMessage(handler: (m: WebviewMessage) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const cb = (e: MessageEvent<WebviewMessage>) => ref.current(e.data);
    window.addEventListener("message", cb);
    return () => window.removeEventListener("message", cb);
  }, []);
}