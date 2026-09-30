// Host ↔ Webview 消息协议 + 领域类型（spec §8）
// 单一真相源约定：phase/message 只有 host 可写（spec §5.3）

export type ProjectStatus =
  | "scanning"
  | "statused"
  | "generating"
  | "ready"
  | "ready_failed"
  | "committing"
  | "committed"
  | "push_failed"
  | "push_ok"
  | "commit_failed";

export type Dirtiness = "clean" | "staged" | "dirty" | "conflict";
export type PushState = "ahead" | "behind" | "synced" | "no-remote";

/** git status 解析结果（statusParser 产出） */
export interface GitStatus {
  branch: string;
  dirtiness: Dirtiness;
  pushState: PushState;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
}

/** DiscoveryWorker 产出（rank 为 MRU 序号，0 = 最近） */
export interface DiscoveredProject {
  path: string;
  rank: number;
  lastUsed?: number;
}

/** webview 卡片数据 */
export interface Project {
  path: string;
  name: string;
  rank: number;
  lastUsed?: number;
  status: GitStatus | null;
  phase: ProjectStatus;
  message: string;
  error?: string;
}

/** Webview → Host */
export type HostMessage =
  | { type: "scan" }
  | { type: "regenerate"; path: string }
  | { type: "setMessage"; path: string; message: string; ackId: string }
  | { type: "commit"; paths: string[] }
  | { type: "push"; path: string };

/** Host → Webview */
export type WebviewMessage =
  | { type: "projectList"; items: Project[] }
  | { type: "stream"; path: string; chunk: string }
  | { type: "streamDone"; path: string; message: string }
  | { type: "status"; path: string; phase: ProjectStatus; error?: string }
  | { type: "ack"; ackId: string }
  | { type: "ollamaState"; connected: boolean };

/** 前置检查结果（spec §11.4） */
export interface PrereqReport {
  git: boolean;
  ollama: boolean;
  db: boolean;
}