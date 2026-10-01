import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runGit } from "../src/git/spawnGit";
import { makeRepo, rmWithRetry } from "./helpers/gitFixtures";

let repo: string;

beforeEach(() => { repo = makeRepo("gitbatch-"); });
afterEach(() => { rmWithRetry(repo); });

describe("runGit", () => {
  it("成功命令返回 stdout", async () => {
    const r = await runGit(repo, ["status", "--porcelain", "-b"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("## main");
  });

  it("非零退出码返回 stderr", async () => {
    const r = await runGit(repo, ["show", "nonexistent-ref"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("含空格与中文的 cwd 可用", async () => {
    const spaced = makeRepo("空格 repo-");
    const r = await runGit(spaced, ["status", "--porcelain", "-b"]);
    expect(r.code).toBe(0);
    rmWithRetry(spaced);
  });

  it("git 不存在 → code -1 + GIT_NOT_FOUND", async () => {
    const r = await runGit(repo, ["status"], 5000, "git-not-exist-xxx.exe");
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("GIT_NOT_FOUND");
  });

  it("超时 kill → code -2 + GIT_TIMEOUT", async () => {
    // rev-list 强制扫整个历史，相对慢；1ms 超时必触发
    const r = await runGit(repo, ["rev-list", "--all", "--pretty=oneline"], 1);
    expect(r.code).toBe(-2);
    expect(r.stderr).toBe("GIT_TIMEOUT");
  });
});