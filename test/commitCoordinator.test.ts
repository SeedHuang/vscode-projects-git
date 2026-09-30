import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CommitCoordinator } from "../src/committer/CommitCoordinator";
import { MessageStore } from "../src/scanner/ScanCoordinator";
import type { WebviewMessage } from "../src/messages";

const dirs: string[] = [];

function repo2(remoteBare?: string): string {
  const d = mkdtempSync(join(tmpdir(), "cc-"));
  execSync("git init -b main", { cwd: d });
  if (remoteBare) {
    // remoteBare 已经是裸仓库（abs 路径），用双引号避免空格问题
    execSync(`git remote add origin "${remoteBare}"`, { cwd: d });
  }
  writeFileSync(join(d, "a.txt"), "content");
  dirs.push(d);
  return d;
}

function bare(): string {
  const b = mkdtempSync(join(tmpdir(), "bare-"));
  execSync("git init --bare -b main", { cwd: b });
  dirs.push(b);
  return b;
}

beforeEach(() => { dirs.length = 0; });
afterEach(() => dirs.forEach((d) => {
  for (let i = 0; i < 20; i++) {
    try { rmSync(d, { recursive: true, force: true }); return; }
    catch { /* EBUSY 重试 */ }
  }
}));

function makeCoordinator() {
  const messages: WebviewMessage[] = [];
  const store = new MessageStore();
  const cc = new CommitCoordinator({
    emit: (m: WebviewMessage) => messages.push(m),
    store,
    concurrency: 3,
  });
  // 测试可见：拿 store 引用
  (cc as unknown as { deps: { store: MessageStore } }).deps.store = store;
  return { cc, messages, store };
}

describe("CommitCoordinator.commit", () => {
  it("成功路径：add → commit → push，最终 push_ok", async () => {
    const b = bare();
    const d = repo2(b);
    const { cc, messages, store } = makeCoordinator();
    store.set(d, "feat: 测试提交");
    const summary = await cc.commit([d, d]); // 重复路径去重
    expect(summary.commitFailed).toBe(0);
    expect(summary.pushFailed).toBe(0);
    const phases = messages.filter((m) => m.type === "status").map((m) => (m as { phase: string }).phase);
    expect(phases[phases.length - 1]).toBe("push_ok");
    // message 已落盘
    const log = execSync("git log -1 --pretty=%B", { cwd: d }).toString().trim();
    expect(log).toBe("feat: 测试提交");
  });

  it("空数组 → no-op", async () => {
    const { cc } = makeCoordinator();
    const s = await cc.commit([]);
    expect(s).toEqual({ ok: 0, commitFailed: 0, pushFailed: 0 });
  });

  it("非 git 目录 → commit_failed + not_git_repo，不阻塞其他", async () => {
    const good = repo2();
    const notGit = mkdtempSync(join(tmpdir(), "ng-"));
    dirs.push(notGit);
    const { cc, messages, store } = makeCoordinator();
    store.set(good, "chore: ok");
    await cc.commit([notGit, good]);
    const byPath = messages.filter((m) => m.type === "status") as Array<{ path: string; phase: string; error?: string }>;
    expect(byPath.find((m) => m.path === notGit)?.error).toBe("not_git_repo");
    // good 应该最终是 committed（无 remote）或 commit_failed（无 identity）
    const goodMsgs = byPath.filter((m) => m.path === good);
    const lastGood = goodMsgs[goodMsgs.length - 1];
    expect(["committed", "commit_failed"]).toContain(lastGood.phase);
  });

  it("多行含特殊字符 message 完整落盘", async () => {
    const d = repo2();
    const { cc, store } = makeCoordinator();
    const special = 'feat: 支持 "引号" 与 $变量 与\n\n多行 body；中文；`反引号`';
    store.set(d, special);
    await cc.commit([d]);
    const log = execSync("git log -1 --pretty=%B", { cwd: d }).toString();
    expect(log).toContain("支持 \"引号\" 与 $变量");
    expect(log).toContain("多行 body");
  });

  it("push 失败（remote 断链）→ push_failed，commit 已落盘", async () => {
    const b = bare();
    const d = repo2(b);
    const { cc, messages, store } = makeCoordinator();
    store.set(d, "feat: x");
    rmSync(b, { recursive: true, force: true }); // 断链
    await cc.commit([d]);
    const last = messages.filter((m) => m.type === "status").pop() as { phase: string };
    expect(last.phase).toBe("push_failed");
    const log = execSync("git log -1 --pretty=%B", { cwd: d }).toString();
    expect(log).toContain("feat: x"); // commit 保留
  });

  it("identity 未配置 → identity_not_configured", async () => {
    // 临时把全局 git identity 备份+清空
    const origEmail = execSync("git config --global user.email || echo NONE").toString().trim();
    const origName = execSync("git config --global user.name || echo NONE").toString().trim();
    execSync("git config --global --unset user.email", { stdio: "ignore" });
    execSync("git config --global --unset user.name", { stdio: "ignore" });
    try {
      const d = mkdtempSync(join(tmpdir(), "noid-"));
      execSync("git init -b main", { cwd: d });
      writeFileSync(join(d, "a.txt"), "1");
      // 不 add 也不 commit，让 commit 流程去 add
      dirs.push(d);
      const { cc, messages, store } = makeCoordinator();
      store.set(d, "feat: y");
      await cc.commit([d]);
      const last = messages.filter((m) => m.type === "status").pop() as { phase: string; error?: string };
      expect(last.phase).toBe("commit_failed");
      expect(last.error).toBe("identity_not_configured");
    } finally {
      // 恢复
      if (origEmail !== "NONE") execSync(`git config --global user.email "${origEmail}"`);
      if (origName !== "NONE") execSync(`git config --global user.name "${origName}"`);
    }
  });
});