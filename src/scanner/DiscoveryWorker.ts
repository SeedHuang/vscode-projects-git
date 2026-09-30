// 从宿主编辑器 state.vscdb 读最近打开的项目（spec §5.1 / §7.2）
// 机制：复制 db 到临时目录 → sql.js 打开副本 → 查 ItemTable 的
// history.recentlyOpenedPathsList → 解析 folderUri / workspace.configPath →
// 过滤（存在 + 是 git 仓库）→ realpath 归一 → 去重 → MRU 顺序（数组序即最近优先）
// 副本读完即删，不落地不缓存（spec §7.2）
import type { Database, SqlJsStatic } from "sql.js";
import type { DiscoveredProject } from "../messages";

export interface DiscoveryDeps {
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  isGitRepo(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  createSql(): Promise<SqlJsStatic>;
  tmpCopy(file: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const url = new URL(uri);
  let p = decodeURIComponent(url.pathname);
  // Windows: /d:/code/alpha → d:\code\alpha
  if (/^\/[a-zA-Z]:\//.test(p)) {
    p = p.slice(1).replace(/\//g, "\\");
  }
  // .code-workspace 是多文件夹工作区文件，用作项目入口时去掉扩展名
  if (p.toLowerCase().endsWith(".code-workspace")) {
    p = p.slice(0, -".code-workspace".length);
  }
  return p;
}

export async function discoverRecentProjects(deps: DiscoveryDeps): Promise<DiscoveredProject[]> {
  const tmpPath = await deps.tmpCopy("state.vscdb");
  try {
    const buf = await deps.readFile(tmpPath);
    const SQL = await deps.createSql();
    const db: Database = new SQL.Database(buf);
    let raw: string | null = null;
    try {
      const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
      stmt.bind(["history.recentlyOpenedPathsList"]);
      if (stmt.step()) raw = stmt.get()[0] as string;
      stmt.free();
    } finally {
      db.close();
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      entries?: Array<{
        folderUri?: string;
        fileUri?: string;
        workspace?: { configPath?: string };
        lastUsed?: number;
      }>;
    };
    const seen = new Set<string>();
    const out: DiscoveredProject[] = [];
    let rank = 0;
    for (const e of parsed.entries ?? []) {
      const candidate =
        uriToPath(e.folderUri ?? "") ??
        uriToPath(e.workspace?.configPath ?? "") ??
        null;
      if (!candidate) continue;
      if (!(await deps.exists(candidate))) continue;
      if (!(await deps.isGitRepo(candidate))) continue;
      const real = await deps.realpath(candidate);
      const key = real.toLowerCase(); // Windows 大小写不敏感
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: real, rank: rank++, lastUsed: e.lastUsed });
    }
    return out;
  } finally {
    await deps.unlink(tmpPath).catch(() => {});
  }
}