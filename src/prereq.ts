// 前置检查与诊断日志（spec §11.4）
import { runGit } from "./git/spawnGit";
import type { PrereqReport } from "./messages";

export class LogBuffer {
  private lines: string[] = [];
  constructor(private cap = 200) {}
  push(line: string): void {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > this.cap) this.lines.shift();
  }
  dump(): string { return this.lines.join("\n"); }
}

export async function checkPrerequisites(
  cfg: { ollamaUrl: string },
  dbPath: string | null,
  fileExists: (p: string) => Promise<boolean>
): Promise<PrereqReport> {
  const gitR = await runGit(process.cwd(), ["--version"], 5000);
  let ollama = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, "")}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    ollama = res.ok;
  } catch { ollama = false; }
  const db = dbPath !== null && (await fileExists(dbPath));
  return { git: gitR.code === 0, ollama, db };
}