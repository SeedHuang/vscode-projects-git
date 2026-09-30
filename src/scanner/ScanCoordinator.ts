// 扫描协调器（spec §5.1）：AbortController 管新旧代；message 单一真相源
import type { DiscoveredProject, GitStatus, Project, WebviewMessage, ProjectStatus } from "../messages";
import type { OllamaWorker } from "./OllamaWorker";

export class MessageStore {
  private map = new Map<string, string>();
  set(path: string, message: string): void { this.map.set(path, message); }
  get(path: string): string | undefined { return this.map.get(path); }
  clear(): void { this.map.clear(); }
}

export interface DiffInfo { statusLine: string; diff: string; fileList: string; }

export interface ScanDeps {
  discover(): Promise<DiscoveredProject[]>;
  getStatuses(paths: string[]): Promise<Map<string, GitStatus>>;
  ollama: OllamaWorker;
  emit(m: WebviewMessage): void;
  store: MessageStore;
  diffFor(path: string): Promise<DiffInfo>;
}

export class ScanCoordinator {
  private generation = 0;

  constructor(private deps: ScanDeps) {}

  abort(): void {
    this.generation++;
    this.deps.ollama.abortAll();
  }

  async scan(): Promise<void> {
    this.abort(); // 作废旧代（spec §5.1 步骤 1）
    const gen = ++this.generation;
    const alive = () => gen === this.generation;

    const discovered = await this.deps.discover();
    if (!alive()) return;
    const paths = discovered.map((d) => d.path);
    const statuses = await this.deps.getStatuses(paths);
    if (!alive()) return;

    const items: Project[] = discovered.map((d) => {
      const status = statuses.get(d.path) ?? null;
      const phase: ProjectStatus =
        status === null ? "scanning" :
        status.dirtiness === "clean" ? "ready" :
        "statused";
      return {
        path: d.path,
        name: d.path.split(/[\\/]/).filter(Boolean).pop() ?? d.path,
        rank: d.rank,
        lastUsed: d.lastUsed,
        status,
        phase,
        message: this.deps.store.get(d.path) ?? "",
      };
    });
    this.deps.emit({ type: "projectList", items });

    // 脏项目进生成队列（spec §5.1 步骤 4；Ollama 挂了不影响上面）
    for (const item of items) {
      if (!alive()) return;
      const st = item.status;
      if (!st || st.dirtiness === "clean") continue;
      const d = await this.deps.diffFor(item.path);
      if (!alive()) return;
      this.deps.ollama.enqueue({
        path: item.path,
        ...d,
      });
    }
  }
}