// 从宿主编辑器读最近打开的项目（spec §5.1 / §7.2）
// 两条数据源：
//   1. 新版（VSCode 1.86+ / Trae CN）：globalStorage/storage.json 里的
//      profileAssociations.workspaces（按 MRU，但 storage.json 不存 lastUsed）
//   2. 旧版（VSCode < 1.86）：globalStorage/state.vscdb 的
//      history.recentlyOpenedPathsList（带 lastUsed）
// 任一能读就用，路径 → 过滤（存在 + 是 git 仓库）→ realpath → 去重 → MRU 顺序
// state.vscdb 走 sql.js（复制到 tmp 再读，不锁文件）
// 副本读完即删，不落地不缓存（spec §7.2）
import type { Database, SqlJsStatic } from "sql.js";
import type { DiscoveredProject } from "../messages";

export interface DiscoveryDeps {
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  isGitRepo(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  createSql(): Promise<SqlJsStatic>;
  /** 复制一份宿主 db 到临时文件（仅 state.vscdb 需要） */
  tmpCopy(file: string): Promise<string>;
  unlink(path: string): Promise<void>;
  /** 读取宿主 storage.json 这类明文 JSON（新版 VSCode 用） */
  readStorageJson(path: string): Promise<unknown>;
  /** state.vscdb 完整路径（存在就读） */
  stateDbPath: string | null;
  /** storage.json 完整路径（存在就读） */
  storageJsonPath: string | null;
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

type RawEntry = {
  folderUri?: string;
  fileUri?: string;
  workspace?: { configPath?: string };
  lastUsed?: number;
};

/**
 * 从新版 storage.json 里取 projects。优先 profileAssociations.workspaces（MRU 顺序不明所以按 key 顺序保留）；
 * 退化用 backupWorkspaces.folders + windowsState.lastActiveWindow。
 * 注：storage.json 不存 lastUsed，用 0 占位。
 */
async function readFromStorageJson(
  deps: DiscoveryDeps
): Promise<RawEntry[] | null> {
  if (!deps.storageJsonPath) return null;
  if (!(await deps.exists(deps.storageJsonPath))) return null;
  let parsed: any;
  try {
    parsed = await deps.readStorageJson(deps.storageJsonPath);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const seen = new Set<string>();
  const out: RawEntry[] = [];

  // 1) profileAssociations.workspaces 是当前打开或曾经打开过的 workspaces
  const wsMap = parsed.profileAssociations?.workspaces;
  if (wsMap && typeof wsMap === "object") {
    for (const uri of Object.keys(wsMap)) {
      if (typeof uri !== "string") continue;
      if (!seen.has(uri)) { seen.add(uri); out.push({ folderUri: uri }); }
    }
  }
  // 2) backupWorkspaces.folders（最近一次关闭窗口时的文件夹）
  const bwFolders = parsed.backupWorkspaces?.folders;
  if (Array.isArray(bwFolders)) {
    for (const f of bwFolders) {
      if (typeof f?.folderUri === "string" && !seen.has(f.folderUri)) {
        seen.add(f.folderUri);
        out.push({ folderUri: f.folderUri });
      }
    }
  }
  // 3) windowsState.lastActiveWindow（最近活跃窗口）
  const lastActive = parsed.windowsState?.lastActiveWindow;
  if (lastActive?.folder && typeof lastActive.folder === "string" && !seen.has(lastActive.folder)) {
    seen.add(lastActive.folder);
    out.push({ folderUri: lastActive.folder });
  }
  return out.length > 0 ? out : null;
}

/**
 * 从旧版 state.vscdb 里取 history.recentlyOpenedPathsList。
 */
async function readFromStateDb(
  deps: DiscoveryDeps
): Promise<RawEntry[] | null> {
  if (!deps.stateDbPath) return null;
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
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { entries?: RawEntry[] };
    return parsed.entries ?? null;
  } finally {
    await deps.unlink(tmpPath).catch(() => {});
  }
}

export async function discoverRecentProjects(deps: DiscoveryDeps): Promise<DiscoveredProject[]> {
  // 优先 storage.json（新版本）；回退 state.vscdb（旧版本）
  const raw =
    (await readFromStorageJson(deps)) ??
    (await readFromStateDb(deps)) ??
    [];
  const seen = new Set<string>();
  const out: DiscoveredProject[] = [];
  let rank = 0;
  for (const e of raw) {
    const candidate =
      uriToPath(e.folderUri ?? "") ??
      uriToPath(e.fileUri ?? "") ??
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
}