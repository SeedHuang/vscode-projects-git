import { ProjectCard } from "./ProjectCard";
import type { Project } from "../../messages";
import { List, EmptyState } from "../sc";

interface Props {
  items: Project[];
  streaming: Record<string, string>;
  selected: Set<string>;
  ollamaConnected: boolean | null;
  /** 哪些卡片正在等 setMessage 的 ack */
  saving: Set<string>;
  onToggle(p: string): void;
  onMessage(p: string, msg: string): void;
  onRegenerate(p: string): void;
  onPush(p: string): void;
}

export function ProjectList(p: Props) {
  if (p.items.length === 0) {
    return <EmptyState>暂无项目（请先在编辑器打开一个 git 项目，或点击"全部重扫"）</EmptyState>;
  }
  return (
    <List>
      {p.items.map((x, i) => (
        <div key={x.path} style={{ animationDelay: `${i * 30}ms` }}>
          <ProjectCard
            project={x}
            streaming={p.streaming[x.path]}
            checked={p.selected.has(x.path)}
            ollamaConnected={p.ollamaConnected}
            saving={p.saving.has(x.path)}
            onToggle={() => p.onToggle(x.path)}
            onMessage={(msg) => p.onMessage(x.path, msg)}
            onRegenerate={() => p.onRegenerate(x.path)}
            onPush={() => p.onPush(x.path)}
          />
        </div>
      ))}
    </List>
  );
}