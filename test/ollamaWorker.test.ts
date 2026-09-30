import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { OllamaWorker } from "../src/scanner/OllamaWorker";

let server: http.Server;
let baseUrl: string;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function startOllama(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

const cfg = (url: string) => ({ url, model: "m", maxDiffChars: 100, timeoutMs: 5000 });

describe("OllamaWorker", () => {
  it("串行 FIFO：任务按入队顺序完成", async () => {
    baseUrl = await startOllama((_req, res) => {
      res.end(JSON.stringify({ response: "msg", done: true }) + "\n");
    });
    const order: string[] = [];
    const done = new Promise<void>((resolve) => {
      const w = new OllamaWorker(cfg(baseUrl), {
        onStream: () => {},
        onDone: (p) => { order.push(p); if (order.length === 3) resolve(); },
        onFailed: () => {},
        onFatal: () => {},
      });
      w.enqueue({ path: "a", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "b", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "c", statusLine: "", diff: "d", fileList: "" });
    });
    await done;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("流式 chunk 转发 onStream，onDone 收全文", async () => {
    baseUrl = await startOllama((_req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      res.write(JSON.stringify({ response: "feat: " }) + "\n");
      res.write(JSON.stringify({ response: "改动", done: true }) + "\n");
      res.end();
    });
    const chunks: string[] = [];
    const doneP = new Promise<string>((resolve) => {
      const w = new OllamaWorker(cfg(baseUrl), {
        onStream: (_p, c) => chunks.push(c),
        onDone: (_p, m) => resolve(m),
        onFailed: () => {},
        onFatal: () => {},
      });
      w.enqueue({ path: "x", statusLine: "", diff: "d", fileList: "" });
    });
    const msg = await doneP;
    expect(msg).toBe("feat: 改动");
    expect(chunks).toEqual(["feat: ", "改动"]);
  });

  it("404 → onFatal 清空队列", async () => {
    baseUrl = await startOllama((_req, res) => { res.statusCode = 404; res.end("nf"); });
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const w = new OllamaWorker(cfg(baseUrl), {
        onStream: () => {},
        onDone: () => {},
        onFailed: (p) => { events.push(`failed:${p}`); },
        onFatal: () => { events.push("fatal"); resolve(); },
      });
      w.enqueue({ path: "a", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "b", statusLine: "", diff: "d", fileList: "" });
    });
    // 404 是 fatal：a 失败触发 fatal，b 从队列移除（不再产生新事件）
    expect(events).toEqual(["failed:a", "fatal"]);
  });

  it("超时 → onFailed 不影响后续", async () => {
    let hits = 0;
    baseUrl = await startOllama((_req, res) => {
      hits++;
      if (hits === 1) return; // 第一个挂住超时
      res.end(JSON.stringify({ response: "ok", done: true }) + "\n");
    });
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const w = new OllamaWorker({ ...cfg(baseUrl), timeoutMs: 80 }, {
        onStream: () => {},
        onDone: (p, m) => { events.push(`done:${p}:${m}`); if (events.length === 2) resolve(); },
        onFailed: (p, r) => events.push(`failed:${p}:${r}`),
        onFatal: () => events.push("fatal"),
      });
      w.enqueue({ path: "slow", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "fast", statusLine: "", diff: "d", fileList: "" });
    });
    expect(events[0]).toMatch(/^failed:slow:/);
    expect(events[1]).toBe("done:fast:ok");
  });
});