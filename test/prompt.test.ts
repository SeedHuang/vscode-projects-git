import { describe, it, expect } from "vitest";
import { buildPrompt, PROMPT_TEMPLATE } from "../src/ollama/prompt";

describe("buildPrompt", () => {
  it("短 diff 直接进 prompt", () => {
    const r = buildPrompt({ statusLine: "## main", diff: "- a\n+ b", fileList: "a.txt" }, 8000);
    expect(r.truncated).toBe(false);
    expect(r.prompt).toContain("- a\n+ b");
    expect(r.prompt).toContain("## main");
  });

  it("超长 diff 切换文件清单模式", () => {
    const r = buildPrompt({ statusLine: "## main", diff: "x".repeat(9000), fileList: "a.txt | 修改\nb.ts | 新增" }, 8000);
    expect(r.truncated).toBe(true);
    expect(r.prompt).not.toContain("xxxxxxxxxx");
    expect(r.prompt).toContain("b.ts | 新增");
    expect(r.prompt).toContain("文件清单");
  });

  it("模板含 8 个 type 与中文约束", () => {
    expect(PROMPT_TEMPLATE).toContain("feat / refactor / docs / test / chore / fix / perf / style");
    expect(PROMPT_TEMPLATE).toContain("只输出 message 本身");
    expect(PROMPT_TEMPLATE).toContain("不超过 50 字");
  });

  it("模板不含英文开场白指令（防模型输出英文）", () => {
    expect(PROMPT_TEMPLATE).not.toContain("Write a commit message");
  });
});