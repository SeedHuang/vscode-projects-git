import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runGit } from "../src/git/spawnGit";

let repo: string;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitbatch-"));
  execSync("git init -b main", { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: dir });
  return dir;
}

function rmWithRetry(p: string): void {
  // Windows: 子进程被 SIGKILL 后文件锁可能仍残留；vitest 并发跑也会撞锁
  for (let i = 0; i < 20; i++) {
    try { rmSync(p, { recursive: true, force: true }); return; }
    catch { /* EBUSY 重试 */ }
  }
  // 最后再试一次，吞掉错误——测试结束时的 cleanup 不应该让 case 失败
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 仍被锁就放弃 */ }
}

beforeEach(() => { repo = initRepo(); });
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
    const spaced = mkdtempSync(join(tmpdir(), "空格 repo-"));
    execSync("git init -b main", { cwd: spaced });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: spaced });
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