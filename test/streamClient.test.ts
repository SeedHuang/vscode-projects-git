import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { streamGenerate, OllamaHttpError, OllamaTimeoutError, OllamaConnectError } from "../src/ollama/streamClient";

let server: http.Server;
let baseUrl: string;

function startServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
afterEach(() => new Promise<void>((r) => server ? server.close(() => r()) : r()));

describe("streamGenerate", () => {
  it("正常流：逐行解析 NDJSON，拼出全文", async () => {
    baseUrl = await startServer((_req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      res.write(JSON.stringify({ response: "feat: " }) + "\n");
      res.write(JSON.stringify({ response: "添加登录" }) + "\n");
      res.write(JSON.stringify({ response: "表单", done: true }) + "\n");
      res.end();
    });
    const chunks: string[] = [];
    const text = await streamGenerate(baseUrl, { model: "m", prompt: "p" }, { timeoutMs: 5000 }, (c) => chunks.push(c));
    expect(text).toBe("feat: 添加登录表单");
    expect(chunks).toEqual(["feat: ", "添加登录", "表单"]);
  });

  it("chunk 跨 TCP 包边界（半行缓冲）", async () => {
    baseUrl = await startServer((_req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      const line = JSON.stringify({ response: "hello", done: true }) + "\n";
      const mid = Math.floor(line.length / 2);
      res.write(line.slice(0, mid));
      setTimeout(() => { res.write(line.slice(mid)); res.end(); }, 10);
    });
    const text = await streamGenerate(baseUrl, {}, { timeoutMs: 5000 }, () => {});
    expect(text).toBe("hello");
  });

  it("HTTP 404 → OllamaHttpError", async () => {
    baseUrl = await startServer((_req, res) => { res.statusCode = 404; res.end("model not found"); });
    await expect(streamGenerate(baseUrl, {}, { timeoutMs: 5000 }, () => {})).rejects.toBeInstanceOf(OllamaHttpError);
  });

  it("连接拒绝 → OllamaConnectError", async () => {
    await expect(streamGenerate("http://127.0.0.1:1", {}, { timeoutMs: 2000 }, () => {})).rejects.toBeInstanceOf(OllamaConnectError);
  });

  it("超时 → OllamaTimeoutError", async () => {
    baseUrl = await startServer((_req, _res) => { /* 挂住不响应 */ });
    await expect(streamGenerate(baseUrl, {}, { timeoutMs: 100 }, () => {})).rejects.toBeInstanceOf(OllamaTimeoutError);
  });

  it("外部 signal abort 立即中断", async () => {
    baseUrl = await startServer((_req, _res) => { /* 挂住 */ });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(
      streamGenerate(baseUrl, {}, { timeoutMs: 10000, signal: ac.signal }, () => {})
    ).rejects.toThrow();
  });
});