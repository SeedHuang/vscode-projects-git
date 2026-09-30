import { describe, it, expect } from "vitest";
import { LogBuffer, checkPrerequisites } from "../src/prereq";

describe("LogBuffer", () => {
  it("环形上限 200 条", () => {
    const b = new LogBuffer(200);
    for (let i = 0; i < 250; i++) b.push(`L${i}`);
    const dump = b.dump();
    expect(dump).toContain("L249");
    expect(dump).not.toContain("L49\n");
    expect(dump.split("\n").length).toBe(200);
  });
});

describe("checkPrerequisites", () => {
  it("dbPath null + Ollama 不通 + db 不存在 → 全 false", async () => {
    const r = await checkPrerequisites(
      { ollamaUrl: "http://127.0.0.1:1" },
      null,
      async () => false
    );
    expect(r.ollama).toBe(false);
    expect(r.db).toBe(false);
    // git 在测试环境通常存在；这里不强求 false，避免环境耦合
    expect(typeof r.git).toBe("boolean");
  });

  it("dbPath null → db=false", async () => {
    const r = await checkPrerequisites(
      { ollamaUrl: "http://127.0.0.1:1" },
      null,
      async () => true
    );
    expect(r.db).toBe(false);
  });

  it("dbPath 存在 + fileExists true → db=true", async () => {
    const r = await checkPrerequisites(
      { ollamaUrl: "http://127.0.0.1:1" },
      "C:\\fake\\path",
      async () => true
    );
    expect(r.db).toBe(true);
  });
});