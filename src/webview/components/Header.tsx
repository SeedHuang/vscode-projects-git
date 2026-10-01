import {
  HeaderWrap,
  HeaderStats,
  TabRow,
  TabBtn,
  TabNum,
  IconBtn,
  Checkbox,
} from "../sc";
import { IconRefresh, IconGenMsg, IconCommit, IconPush } from "./Icons";
import { Spinner } from "../sc";
import type { Filter } from "../App";

interface Props {
  /** 各 Tab 的命中数 */
  counts: { all: number; uncommitted: number; unpushed: number; conflict: number };
  filter: Filter;
  onFilter(f: Filter): void;
  /** 当前 filter 可见项里的勾选状态：'none' | 'some' | 'all' */
  selectState: "none" | "some" | "all";
  onToggleSelectAll(): void;
  onRescan(): void;
  onBatchGen(): void;
  onBatchCommit(): void;
  onBatchPush(): void;
  canGen: boolean;
  canCommit: boolean;
  canPush: boolean;
  busyRescan?: boolean;
  busyGen?: boolean;
  busyCommit?: boolean;
  busyPush?: boolean;
  inFlightGen?: number;
  inFlightCommit?: number;
  inFlightPush?: number;
}

export function Header(p: Props) {
  const selectTip =
    p.selectState === "all" ? "取消全选可见项" : "全选当前可见项";

  return (
    <HeaderWrap>
      <HeaderStats>
        <Checkbox
          type="checkbox"
          checked={p.selectState === "all"}
          ref={(el) => {
            if (el) el.indeterminate = p.selectState === "some";
          }}
          onChange={p.onToggleSelectAll}
          title={selectTip}
        />
      </HeaderStats>
      <TabRow>
        <TabBtn $active={p.filter === "all"} onClick={() => p.onFilter("all")}>
          全部
          <TabNum $tone="neutral" $active={p.filter === "all"}>{p.counts.all}</TabNum>
        </TabBtn>
        <TabBtn $active={p.filter === "uncommitted"} onClick={() => p.onFilter("uncommitted")}>
          未提交
          <TabNum $tone="warn" $active={p.filter === "uncommitted"}>{p.counts.uncommitted}</TabNum>
        </TabBtn>
        <TabBtn $active={p.filter === "unpushed"} onClick={() => p.onFilter("unpushed")}>
          未 push
          <TabNum $tone="info" $active={p.filter === "unpushed"}>{p.counts.unpushed}</TabNum>
        </TabBtn>
        <TabBtn $active={p.filter === "conflict"} onClick={() => p.onFilter("conflict")}>
          冲突
          <TabNum $tone="danger" $active={p.filter === "conflict"}>{p.counts.conflict}</TabNum>
        </TabBtn>
      </TabRow>
      <div style={{ display: "inline-flex", marginLeft: "auto" }}>
        <IconBtn
          $tone="neutral"
          onClick={p.onRescan}
          disabled={p.busyRescan}
          data-tip={p.busyRescan ? "正在重扫项目…" : "全部重扫：重新发现项目并刷新状态"}
          aria-label="全部重扫"
          style={p.busyRescan ? { color: "var(--vscode-editorWarning-foreground)", borderColor: "var(--vscode-editorWarning-foreground)" } : undefined}
        >
          {p.busyRescan ? <Spinner /> : <IconRefresh />}
        </IconBtn>
        <IconBtn
          $tone="neutral"
          onClick={p.onBatchGen}
          disabled={!p.canGen}
          data-tip={
            p.busyGen ? `正在生成 ${p.inFlightGen ?? "?"} 个项目的 message…` :
            p.canGen ? "批量生成提交信息：用 Ollama 为勾选项目生成 message" :
            "没有可生成的项目（先勾选未提交的项目）"
          }
          aria-label="批量生成提交信息"
          style={p.busyGen ? { color: "var(--vscode-editorWarning-foreground)", borderColor: "var(--vscode-editorWarning-foreground)" } : undefined}
        >
          {p.busyGen ? <Spinner /> : <IconGenMsg />}
        </IconBtn>
        <IconBtn
          $tone="primary"
          onClick={p.onBatchCommit}
          disabled={!p.canCommit}
          data-tip={
            p.busyCommit ? `正在提交 ${p.inFlightCommit ?? "?"} 个项目…` :
            !p.canCommit ? "没有可提交的项目（先勾选已有 message 的未提交项目）" :
            "批量提交：把勾选项目的临时改动落盘到本地仓库"
          }
          aria-label="批量提交"
          style={p.busyCommit
            ? { color: "var(--vscode-editorWarning-foreground)", borderColor: "var(--vscode-editorWarning-foreground)" }
            : undefined}
        >
          {p.busyCommit ? <Spinner /> : <IconCommit />}
        </IconBtn>
        <IconBtn
          $tone="danger"
          onClick={p.onBatchPush}
          disabled={!p.canPush}
          data-tip={
            p.busyPush ? `正在推送 ${p.inFlightPush ?? "?"} 个项目…` :
            !p.canPush ? "没有可推送的项目（先勾选已提交但未 push 的项目）" :
            "批量推送：把勾选项目的本地提交推到远端"
          }
          aria-label="批量推送"
          style={p.busyPush
            ? { color: "var(--vscode-editorWarning-foreground)", borderColor: "var(--vscode-editorWarning-foreground)" }
            : undefined}
        >
          {p.busyPush ? <Spinner /> : <IconPush />}
        </IconBtn>
      </div>
    </HeaderWrap>
  );
}