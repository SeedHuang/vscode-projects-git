import { describe, it, expect } from "vitest";
import { parseStatus } from "../src/git/statusParser";

describe("parseStatus", () => {
  it("干净仓库（同步）", () => {
    const s = parseStatus("## main...origin/main");
    expect(s.branch).toBe("main");
    expect(s.dirtiness).toBe("clean");
    expect(s.pushState).toBe("synced");
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });

  it("ahead / behind 解析", () => {
    const s = parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.txt");
    expect(s.pushState).toBe("ahead");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.dirtiness).toBe("dirty");
  });

  it("无上游分支 → no-remote", () => {
    const s = parseStatus("## feature-x");
    expect(s.pushState).toBe("no-remote");
  });

  it("未出生分支（No commits yet）→ no-remote", () => {
    const s = parseStatus("## No commits yet on master");
    expect(s.branch).toBe("master");
    expect(s.pushState).toBe("no-remote");
    expect(s.dirtiness).toBe("clean");
  });

  it("upstream [gone] → no-remote", () => {
    const s = parseStatus("## main...origin/main [gone]");
    expect(s.pushState).toBe("no-remote");
  });

  it("未跟踪文件 → dirty", () => {
    const s = parseStatus("## main\n?? new.txt");
    expect(s.dirtiness).toBe("dirty");
  });

  it("纯暂存（已 add 未改）→ staged", () => {
    const s = parseStatus("## main\nM  added.txt");
    expect(s.dirtiness).toBe("staged");
  });

  it("暂存 + 工作区同时有改动 → dirty", () => {
    const s = parseStatus("## main\nMM both.txt");
    expect(s.dirtiness).toBe("dirty");
  });

  it("冲突标记 → conflict", () => {
    const s = parseStatus("## main\nUU conflicted.txt\nAA both-added.txt");
    expect(s.hasConflicts).toBe(true);
    expect(s.dirtiness).toBe("conflict");
  });

  it("detached HEAD 保留原样", () => {
    const s = parseStatus("## HEAD (no branch)");
    expect(s.branch).toBe("HEAD (no branch)");
    expect(s.pushState).toBe("no-remote");
  });

  it("空输出 → clean 空分支", () => {
    const s = parseStatus("");
    expect(s.dirtiness).toBe("clean");
    expect(s.branch).toBe("");
  });
});