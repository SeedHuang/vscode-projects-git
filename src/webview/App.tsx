import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, ProjectStatus, WebviewMessage } from "../messages";
import { useExtensionMessage } from "./hooks/useExtensionMessage";
import { usePathTimers } from "./hooks/usePathTimers";
import { postHost } from "./postMessage";
import { Shell, GlobalStyles } from "./sc";
import { Header } from "./components/Header";
import { ProjectList } from "./components/ProjectList";
import { Footer } from "./components/Footer";

export type Filter = "all" | "uncommitted" | "unpushed" | "conflict";

/** "全部重扫" 收到结果后 spinner 至少停留这么久，避免一闪而过 */
const RESCAN_MIN_VISIBLE_MS = 800;
/** setMessage 后等 ack 的兜底超时 */
const SAVE_ACK_TIMEOUT_MS = 5000;
/** 批量 commit 后等 host status 的兜底超时 */
const COMMIT_STATUS_TIMEOUT_MS = 30000;

export default function App() {
  const [items, setItems] = useState<Project[]>([]);
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [lastBatch, setLastBatch] = useState<string>("");
  /** 哪些卡片正在等 setMessage 的 ack —— ack 回来或超时都移除 */
  const [saving, setSaving] = useState<Set<string>>(new Set());
  /** 哪些项目已被乐观标记为"提交中"——点了提交按钮立刻置入，等真实 status 回来后移除。
      这样 Header spinner 在 host 弹模态确认框时就开始转，避免"点了没反应"的错觉。 */
  const [committingLocally, setCommittingLocally] = useState<Set<string>>(new Set());
  /** "全部重扫" 进行中 —— 收到 projectList 后清零 + RESCAN_MIN_VISIBLE_MS 安全窗 */
  const [rescanBusy, setRescanBusy] = useState(false);
  const rescanTimerRef = useRef<number | null>(null);
  /** 点击重扫的时刻，用于计算「最小可见时间」避免 spinner 一闪而过 */
  const rescanStartedAtRef = useRef<number | null>(null);

  // 两个独立的"按路径 timer"集合：saveTimers 等 ack、commitTimers 等 host status。
  const saveTimers = usePathTimers();
  const commitTimers = usePathTimers();

  const handleMessage = useCallback((m: WebviewMessage) => {
    switch (m.type) {
      case "projectList":
        setItems(m.items);
        setStreaming({});
        // 重扫收到结果 → 关 spinner；再开 800ms 的「最小可见时间」避免闪一下
        if (rescanTimerRef.current !== null) {
          window.clearTimeout(rescanTimerRef.current);
          rescanTimerRef.current = null;
        }
        const startedAt = rescanStartedAtRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, RESCAN_MIN_VISIBLE_MS - elapsed);
        rescanTimerRef.current = window.setTimeout(() => {
          setRescanBusy(false);
          rescanTimerRef.current = null;
        }, remaining);
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
        // host 真实 status 到达 → 清除该路径的乐观"提交中"标记与兜底 timer
        commitTimers.disarm(m.path);
        setCommittingLocally((s) => {
          if (!s.has(m.path)) return s;
          const next = new Set(s);
          next.delete(m.path);
          return next;
        });
        break;
      case "ollamaState":
        setOllamaConnected(m.connected);
        break;
      case "batchDone":
        setLastBatch(`最近批量 ${m.ok} 成功 / ${m.commitFailed} 提交失败 / ${m.pushFailed} push 失败`);
        break;
      case "ack":
        // setMessage 的 ack：解除该卡片的 saving 锁定（按 path 精确移除）
        if (m.path) {
          saveTimers.disarm(m.path);
          setSaving((s) => {
            if (!s.has(m.path!)) return s;
            const next = new Set(s);
            next.delete(m.path!);
            return next;
          });
        }
        break;
    }
  }, [saveTimers, commitTimers]);
  useExtensionMessage(handleMessage);

  // 挂载即通知 host：让 host 重发 prereq 结果（避免 activate 时空打 ollamaState），
  // 同时启动一次自动 scan（用户不再需要手动点"全部重扫"）。
  useEffect(() => {
    postHost({ type: "ready" });
    postHost({ type: "scan" });
  }, []);

  // 用户手动改 message：标记 saving，等 host ack
  const handleSaveMessage = useCallback((path: string, msg: string) => {
    setSaving((s) => {
      if (s.has(path)) return s; // 已 saving 中 → 覆盖一次也直接走，不再加 timer
      const next = new Set(s);
      next.add(path);
      return next;
    });
    // 超时兜底：5 秒没收到 ack 就强制解除（防止 host 异常时按钮永远锁住）
    saveTimers.arm(path, SAVE_ACK_TIMEOUT_MS, () => {
      setSaving((s) => {
        if (!s.has(path)) return s;
        const next = new Set(s);
        next.delete(path);
        return next;
      });
    });
    postHost({ type: "setMessage", path, message: msg, ackId: crypto.randomUUID() });
  }, [saveTimers]);

  // "全部重扫" 包装：开 spinner → 发消息
  const handleRescan = useCallback(() => {
    setRescanBusy(true);
    rescanStartedAtRef.current = Date.now();
    postHost({ type: "scan" });
  }, []);

  const visible = useMemo(() => filterItems(items, filter), [items, filter]);

  /** 各 Tab 的命中数（任何项目状态变化都会重算） */
  const counts = useMemo(() => ({
    all: items.length,
    uncommitted: items.filter((x) => x.status && x.status.dirtiness !== "clean").length,
    unpushed: items.filter((x) => x.status?.pushState === "ahead").length,
    conflict: items.filter((x) => x.status?.hasConflicts).length,
  }), [items]);

  // Header checkbox 的三态：根据当前 filter 可见项中 selected 的占比
  const selectState = useMemo<"none" | "some" | "all">(() => {
    const n = visible.length;
    if (n === 0) return "none";
    let hit = 0;
    for (const x of visible) if (selected.has(x.path)) hit++;
    if (hit === 0) return "none";
    if (hit === n) return "all";
    return "some";
  }, [visible, selected]);

  // 切换全选（基于当前 filter 可见项）：
  //   当前 none/some → 全选；当前 all → 全不选
  const toggleSelectAll = useCallback(() => {
    setSelected((s) => {
      const n = new Set(s);
      if (selectState === "all") {
        for (const x of visible) n.delete(x.path);
      } else {
        for (const x of visible) n.add(x.path);
      }
      return n;
    });
  }, [selectState, visible]);

  // 三个批量按钮的"可执行"判定
  const batches = useMemo(() => {
    const selectedItems = items.filter((x) => selected.has(x.path));
    // phase 处于"已收尾"（commit/push 阶段完结，不应再被批量操作碰）
    const terminalPhases = new Set<ProjectStatus>(["committed", "committing", "pushing", "push_ok", "push_failed", "commit_failed"]);
    // 可生成：未提交且尚未有 message
    const canGenList = selectedItems.filter((x) =>
      x.status && x.status.dirtiness !== "clean" && !x.message.trim() && !terminalPhases.has(x.phase)
    );
    // 可提交：脏且已有 message、且不在任何已收尾阶段
    const canCommitList = selectedItems.filter((x) =>
      x.status && x.status.dirtiness !== "clean" && !!x.message.trim() && !terminalPhases.has(x.phase)
    );
    // 可 push：已提交且未 push（phase === "committed" 表示 commit 落了但 push 没成/没推）
    const canPushList = selectedItems.filter((x) => x.phase === "committed");
    // 全局 in-flight 计数（不仅限勾选）—— Header loading 用
    const inFlightGen = items.filter((x) => x.phase === "generating").length;
    // 真实 committing + 乐观 committing（点击到 host 弹模态框/开跑之间）都算 busy
    const inFlightCommit = items.filter((x) => x.phase === "committing").length + committingLocally.size;
    const inFlightPush = items.filter((x) => x.phase === "pushing").length;
    return {
      canGen: canGenList.length > 0,
      canCommit: canCommitList.length > 0,
      canPush: canPushList.length > 0,
      genPaths: canGenList.map((x) => x.path),
      commitPaths: canCommitList.map((x) => x.path),
      pushPaths: canPushList.map((x) => x.path),
      busyGen: inFlightGen > 0,
      busyCommit: inFlightCommit > 0,
      busyPush: inFlightPush > 0,
      inFlightGen,
      inFlightCommit,
      inFlightPush,
    };
  }, [items, selected, committingLocally]);

  return (
    <Shell>
      <GlobalStyles />
      <Header
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        selectState={selectState}
        onToggleSelectAll={toggleSelectAll}
        onRescan={handleRescan}
        onBatchGen={() => postHost({ type: "regenMany", paths: batches.genPaths })}
        onBatchCommit={() => {
          console.log(`[GitBatch] batch commit clicked, paths=${batches.commitPaths.length}:`, batches.commitPaths);
          // 乐观置入 spinning：host 还没回 status 时，Header 已经显示 spinner
          setCommittingLocally((s) => {
            const next = new Set(s);
            for (const p of batches.commitPaths) {
              next.add(p);
              // 兜底：30 秒没收到 host 的 status，强制清除（防 host 异常时永远转）
              commitTimers.arm(p, COMMIT_STATUS_TIMEOUT_MS, () => {
                setCommittingLocally((cur) => {
                  if (!cur.has(p)) return cur;
                  const n = new Set(cur);
                  n.delete(p);
                  return n;
                });
              });
            }
            return next;
          });
          postHost({ type: "commit", paths: batches.commitPaths });
        }}
        onBatchPush={() => postHost({ type: "pushMany", paths: batches.pushPaths })}
        canGen={batches.canGen && !batches.busyGen}
        canCommit={batches.canCommit && !batches.busyCommit}
        canPush={batches.canPush && !batches.busyPush}
        busyRescan={rescanBusy}
        busyGen={batches.busyGen}
        busyCommit={batches.busyCommit}
        busyPush={batches.busyPush}
        inFlightGen={batches.inFlightGen}
        inFlightCommit={batches.inFlightCommit}
        inFlightPush={batches.inFlightPush}
      />
      <ProjectList
        items={visible}
        streaming={streaming}
        selected={selected}
        ollamaConnected={ollamaConnected}
        saving={saving}
        onToggle={(p: string) =>
          setSelected((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })
        }
        onMessage={handleSaveMessage}
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