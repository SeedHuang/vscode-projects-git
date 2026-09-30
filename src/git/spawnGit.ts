// git 子进程包装：数组参数 + shell:false（spec §12），错误归一化
import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30000,
  command = "git"
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -2, stdout, stderr: stderr || "GIT_TIMEOUT" });
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        finish({ code: -1, stdout, stderr: "GIT_NOT_FOUND: git 命令不存在" });
      } else {
        finish({ code: -3, stdout, stderr: e.message });
      }
    });
    child.on("close", (code) => finish({ code: code ?? -4, stdout, stderr }));
  });
}