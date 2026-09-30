// 批量提交协调器（spec §5.3）：并发限流；message 走 -F 临时文件；
// push 失败不影响 commit 已落盘；webview dispose → dispose() 停发新任务
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProjectStatus, WebviewMessage } from "../messages";
import type { MessageStore } from "../scanner/ScanCoordinator";
import { runGit } from "../git/spawnGit";
import { createLimiter } from "../util/createLimiter";

export interface CommitDeps {
  emit(m: WebviewMessage): void;
  store: MessageStore;
  concurrency: number;
  writeFile?: (p: string, c: string) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
  tmpdir?: () => string;
}

export interface CommitSummary { ok: number; commitFailed: number; pushFailed: number; }

export class CommitCoordinator {
  private disposed = false;
  private write: (p: string, c: string) => Promise<void>;
  private remove: (p: string) => Promise<void>;
  private tmp: () => string;
  private limit: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(public deps: CommitDeps) {
    this.write = deps.writeFile ?? writeFile;
    this.remove = deps.unlink ?? unlink;
    this.tmp = deps.tmpdir ?? tmpdir;
    this.limit = createLimiter(deps.concurrency);
  }

  dispose(): void { this.disposed = true; }

  private emitStatus(path: string, phase: ProjectStatus, error?: string): void {
    this.deps.emit({ type: "status", path, phase, error });
  }

  private async isGitRepo(path: string): Promise<boolean> {
    const r = await runGit(path, ["rev-parse", "--is-inside-work-tree"], 10000);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async commit(paths: string[]): Promise<CommitSummary> {
    const summary: CommitSummary = { ok: 0, commitFailed: 0, pushFailed: 0 };
    // 输入校验（spec §5.3）
    const unique = [...new Set(paths)];
    const valid: string[] = [];
    for (const p of unique) {
      if (!(await this.isGitRepo(p))) {
        this.emitStatus(p, "commit_failed", "not_git_repo");
        summary.commitFailed++;
      } else if (!this.deps.store.get(p)?.trim()) {
        this.emitStatus(p, "commit_failed", "empty_message");
        summary.commitFailed++;
      } else {
        valid.push(p);
      }
    }
    if (valid.length === 0) return summary;
    await Promise.all(valid.map((p) => this.limit(() => this.commitOne(p, summary))));
    return summary;
  }

  private async commitOne(path: string, summary: CommitSummary): Promise<void> {
    if (this.disposed) return;
    const message = this.deps.store.get(path)!;
    this.emitStatus(path, "committing");

    const add = await runGit(path, ["add", "-A"], 30000);
    if (add.code !== 0) {
      this.emitStatus(path, "commit_failed", `add_failed: ${tail(add.stderr)}`);
      summary.commitFailed++;
      return;
    }

    // message 写临时文件 → commit -F（spec §5.3，规避 -m 转义）
    const tmpFile = join(this.tmp(), `gitbatch-msg-${randomUUID()}.txt`);
    await this.write(tmpFile, message);
    const commit = await runGit(path, ["commit", "-F", tmpFile], 60000);
    await this.remove(tmpFile).catch(() => {});
    if (commit.code !== 0) {
      const err = isIdentityError(commit) ? "identity_not_configured" : `commit_failed: ${tail(commit.stderr)}`;
      this.emitStatus(path, "commit_failed", err);
      summary.commitFailed++;
      return;
    }

    // commit 已落盘，先推 committed 状态；后续 push 失败也能区分
    this.emitStatus(path, "committed");

    // push 条件：有 remote（spec §5.3）。没 remote 不推；已有 upstream 就 plain push，否则 -u 建立 upstream
    const remote = await runGit(path, ["remote"], 10000);
    if (remote.code !== 0 || remote.stdout.trim().length === 0) {
      summary.ok++; // 无 remote 不推，phase 停在 committed
      return;
    }
    await this.doPush(path, summary);
  }

  async pushOne(path: string): Promise<void> {
    const summary: CommitSummary = { ok: 0, commitFailed: 0, pushFailed: 0 };
    await this.doPush(path, summary);
  }

  private async doPush(path: string, summary: CommitSummary): Promise<void> {
    if (this.disposed) return;
    // 优先 plain push；有 upstream 时这样最稳；没有就 -u origin HEAD 建立
    const up = await runGit(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 10000);
    const args = up.code === 0 ? ["push"] : ["push", "-u", "origin", "HEAD"];
    const push = await runGit(path, args, 120000);
    if (push.code === 0) {
      this.emitStatus(path, "push_ok");
      summary.ok++;
    } else {
      this.emitStatus(path, "push_failed", `push_failed: ${tail(push.stderr)}`);
      summary.pushFailed++;
    }
  }
}

function tail(s: string, n = 200): string {
  return s.trim().slice(-n);
}

function isIdentityError(r: { stdout: string; stderr: string }): boolean {
  const s = (r.stderr + r.stdout).toLowerCase();
  return (
    s.includes("please tell me who you are") ||
    s.includes("unable to auto-detect email") ||
    s.includes("author identity unknown")
  );
}