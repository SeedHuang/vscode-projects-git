// 宿主编译器识别与 state.vscdb 路径解析（spec §12）
// 真值校验 2026-09-30（Windows）：Trae 目录名是 "Trae CN"（带空格），"Trae" 不存在。
// 国际版 Trae 仍是 "Trae"，所以 Windows 上运行时两个候选都要试（exists 判定）。
// darwin/linux 走 POSIX 路径风格（即使在 Windows 上跑单测也按 POSIX 拼）。

import { join } from "node:path";

export type HostApp = "vscode" | "trae" | "unknown";

export function detectHost(argv0: string | undefined): HostApp {
  if (!argv0) return "unknown";
  const lower = argv0.toLowerCase();
  if (lower.includes("trae")) return "trae";
  if (lower.includes("code")) return "vscode";
  return "unknown";
}

type DirNameMap = Record<Exclude<HostApp, "unknown">, Partial<Record<NodeJS.Platform, string[]>>>;

const DIR_NAMES: DirNameMap = {
  vscode: {
    win32: ["Code"],
    darwin: ["Code"],
    linux: ["Code"],
  },
  trae: {
    win32: ["Trae CN", "Trae"], // 先 CN 后国际版
    darwin: ["Trae"],
    linux: ["Trae"],
  },
};

/**
 * 解析 state.vscdb 路径。
 * platform 入参优先于 process.platform；用于跨平台单测。
 */
export function resolveStateDbPath(
  host: HostApp,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (host === "unknown") return null;
  const dirs = DIR_NAMES[host][platform];
  if (!dirs || dirs.length === 0) return null;
  const name = dirs[0];
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (!appData) return null;
    return join(appData, name, "User", "globalStorage", "state.vscdb");
  }
  const home = env.HOME;
  if (!home) return null;
  // POSIX：darwin 与 linux 都用 / 拼接——避免 Windows 测试运行时 join() 强插 \
  if (platform === "darwin") {
    return [home, "Library", "Application Support", name, "User", "globalStorage", "state.vscdb"].join("/");
  }
  return [home, ".config", name, "User", "globalStorage", "state.vscdb"].join("/");
}

/**
 * 解析 storage.json 路径（VSCode 1.86+ 用来存最近项目的明文 JSON）。
 * 与 state.vscdb 同一目录下的同名文件。
 */
export function resolveStorageJsonPath(
  host: HostApp,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null {
  const dbPath = resolveStateDbPath(host, env, platform);
  if (!dbPath) return null;
  // state.vscdb 和 storage.json 都在 globalStorage/ 下
  const dir = dbPath.replace(/[\\/]state\.vscdb$/i, "");
  if (platform === "win32") return join(dir, "storage.json");
  return `${dir}/storage.json`;
}

/** 列出某 host+platform 的所有候选目录名（用于存在性回退） */
export function candidateDirNames(host: HostApp, platform: NodeJS.Platform = process.platform): string[] {
  if (host === "unknown") return [];
  return DIR_NAMES[host][platform] ?? [];
}