// 测试 fixture helpers（jscpd 人工审计抽取）
// 三个测试文件都需要：建 git 仓库 + 清理临时目录
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * 创建一个临时 git 仓库（自动 init + 第一次 empty commit），返回路径。
 * 配合 `rmWithRetry` 在 afterEach 中清理。
 */
export function makeRepo(prefix: string, branch = "main", bare = false): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const initCmd = bare ? "git init --bare -b main" : `git init -b ${branch}`;
  execSync(initCmd, { cwd: dir });
  if (!bare) {
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: dir });
  }
  return dir;
}

/**
 * Windows 友好清理：子进程被 SIGKILL 后 .git 锁可能残留 50-200ms；
 * vitest 并发跑测试也会撞锁。重试 20 次，最后吞错避免让 case 失败。
 */
export function rmWithRetry(p: string): void {
  for (let i = 0; i < 20; i++) {
    try { rmSync(p, { recursive: true, force: true }); return; }
    catch { /* EBUSY 重试 */ }
  }
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 仍被锁就放弃 */ }
}