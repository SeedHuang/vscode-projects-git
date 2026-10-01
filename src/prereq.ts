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
  fileExists: (p: string) => Promise<boolean>,
  trace?: (msg: string) => void
): Promise<PrereqReport> {
  const gitR = await runGit(process.cwd(), ["--version"], 5000);
  trace?.(`prereq: git --version code=${gitR.code} stderr=${gitR.stderr.slice(0, 80)}`);
  let ollama = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const url = `${cfg.ollamaUrl.replace(/\/$/, "")}/api/tags`;
    trace?.(`prereq: GET ${url}`);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    trace?.(`prereq: ollama /api/tags status=${res.status}`);
    ollama = res.ok;
  } catch (e) {
    trace?.(`prereq: ollama fetch threw ${String(e instanceof Error ? e.message : e)}`);
    ollama = false;
  }
  const db = dbPath !== null && (await fileExists(dbPath));
  trace?.(`prereq: db path=${dbPath ?? "<null>"} exists=${db}`);
  return { git: gitR.code === 0, ollama, db };
}