import { describe, it, expect } from "vitest";
import { detectHost, resolveStateDbPath } from "../src/scanner/hostDetector";

describe("detectHost", () => {
  it("argv0 含 trae（不区分大小写）", () => {
    expect(detectHost("C:\\apps\\Trae CN\\Trae.exe")).toBe("trae");
  });
  it("argv0 含 code", () => {
    expect(detectHost("C:\\apps\\Microsoft VS Code\\Code.exe")).toBe("vscode");
  });
  it("未知宿主", () => {
    expect(detectHost(undefined)).toBe("unknown");
    expect(detectHost("C:\\apps\\SomethingElse.exe")).toBe("unknown");
  });
});

describe("resolveStateDbPath", () => {
  const env = { APPDATA: "C:\\Users\\t\\AppData\\Roaming" } as NodeJS.ProcessEnv;

  it("Windows: vscode → Code", () => {
    expect(resolveStateDbPath("vscode", env)).toBe(
      "C:\\Users\\t\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb"
    );
  });
  it("Windows: trae → 先试 Trae CN（2026-09-30 实测真值）", () => {
    expect(resolveStateDbPath("trae", env)).toBe(
      "C:\\Users\\t\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\state.vscdb"
    );
  });
  it("darwin 路径", () => {
    const e = { HOME: "/Users/t" } as NodeJS.ProcessEnv;
    expect(resolveStateDbPath("vscode", e, "darwin")).toBe(
      "/Users/t/Library/Application Support/Code/User/globalStorage/state.vscdb"
    );
  });
  it("linux 路径", () => {
    const e = { HOME: "/home/t" } as NodeJS.ProcessEnv;
    expect(resolveStateDbPath("trae", e, "linux")).toBe(
      "/home/t/.config/Trae/User/globalStorage/state.vscdb"
    );
  });
  it("缺环境变量 → null", () => {
    expect(resolveStateDbPath("vscode", {} as NodeJS.ProcessEnv)).toBeNull();
  });
});