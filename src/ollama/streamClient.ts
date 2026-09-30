// Ollama /api/generate 流式客户端（spec §5.2）
// NDJSON：每行一个 JSON，取 response 字段累计；done=true 结束
// 错误分类：HTTP 非 2xx → OllamaHttpError；超时 → OllamaTimeoutError；连不上 → OllamaConnectError
export class OllamaHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`Ollama HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "OllamaHttpError";
  }
}
export class OllamaTimeoutError extends Error {
  constructor() { super("Ollama 生成超时"); this.name = "OllamaTimeoutError"; }
}
export class OllamaConnectError extends Error {
  constructor(detail: string) { super(`Ollama 未连接（${detail}）。请先运行 ollama serve`); this.name = "OllamaConnectError"; }
}

export interface StreamOpts {
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function streamGenerate(
  baseUrl: string,
  body: Record<string, unknown>,
  opts: StreamOpts,
  onChunk: (text: string) => void
): Promise<string> {
  // 组合超时与外部信号：Node 18 无 AbortSignal.any，手动桥接
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OllamaTimeoutError()), opts.timeoutMs);
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (opts.signal?.aborted) throw opts.signal.reason ?? e;
    if (e instanceof OllamaTimeoutError) throw e;
    throw new OllamaConnectError(String(e));
  }

  if (!res.ok) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    throw new OllamaHttpError(res.status, await res.text().catch(() => ""));
  }

  let full = "";
  try {
    if (!res.body) throw new OllamaConnectError("response body is null");
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 半行留缓冲
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        const obj = JSON.parse(t) as { response?: string; done?: boolean };
        if (obj.response) {
          full += obj.response;
          onChunk(obj.response);
        }
        if (obj.done) break outer;
      }
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
  return full;
}