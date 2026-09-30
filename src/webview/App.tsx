import { useCallback, useMemo, useState } from "react";
import type { Project, WebviewMessage } from "../messages";
import { useExtensionMessage } from "./hooks/useExtensionMessage";
import { postHost } from "./postMessage";
import { Shell } from "./sc";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import { ProjectList } from "./components/ProjectList";
import { Footer } from "./components/Footer";

export type Filter = "all" | "uncommitted" | "unpushed" | "conflict";

export default function App() {
  const [items, setItems] = useState<Project[]>([]);
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [lastBatch, setLastBatch] = useState<string>("");

  const handleMessage = useCallback((m: WebviewMessage) => {
    switch (m.type) {
      case "projectList":
        setItems(m.items);
        setStreaming({});
        break;
      case "stream":
        setStreaming((s) => ({ ...s, [m.path]: (s[m.path] ?? "") + m.chunk }));
        break;
      case "streamDone":
        setItems((xs) => xs.map((x) => (x.path === m.path ? { ...x, message: m.message, phase: "ready" } : x)));
        setStreaming((s) => { const { [m.path]: _drop, ...rest } = s; return rest; });
        break;
      case "status":
        setItems((xs) => xs.map((x) => (x.path === m.path ? { ...x, phase: m.phase, error: m.error } : x)));
        break;
      case "ollamaState":
        setOllamaConnected(m.connected);
        break;
      case "batchDone":
        setLastBatch(`最近批量 ${m.ok} 成功 / ${m.commitFailed} 提交失败 / ${m.pushFailed} push 失败`);
        break;
      case "ack":
        break;
    }
  }, []);
  useExtensionMessage(handleMessage);

  const visible = useMemo(() => filterItems(items, filter), [items, filter]);

  return (
    <Shell>
      <Header
        total={items.length}
        uncommitted={items.filter((x) => x.status && x.status.dirtiness !== "clean").length}
        unpushed={items.filter((x) => x.status?.pushState === "ahead").length}
        ollamaConnected={ollamaConnected}
        onRescan={() => postHost({ type: "scan" })}
        onBatchCommit={() => postHost({ type: "commit", paths: [...selected] })}
        batchDisabled={selected.size === 0}
      />
      <Toolbar filter={filter} onFilter={setFilter} />
      <ProjectList
        items={visible}
        streaming={streaming}
        selected={selected}
        ollamaConnected={ollamaConnected}
        onToggle={(p: string) =>
          setSelected((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })
        }
        onMessage={(p: string, msg: string) => postHost({ type: "setMessage", path: p, message: msg, ackId: crypto.randomUUID() })}
        onRegenerate={(p: string) => postHost({ type: "regenerate", path: p })}
        onPush={(p: string) => postHost({ type: "push", path: p })}
      />
      <Footer ollamaConnected={ollamaConnected} lastBatch={lastBatch} />
    </Shell>
  );
}

function filterItems(items: Project[], f: Filter): Project[] {
  switch (f) {
    case "uncommitted": return items.filter((x) => x.status && x.status.dirtiness !== "clean");
    case "unpushed": return items.filter((x) => x.status?.pushState === "ahead");
    case "conflict": return items.filter((x) => x.status?.hasConflicts);
    default: return items;
  }
}