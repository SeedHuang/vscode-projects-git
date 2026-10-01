import { useEffect, useRef, useState } from "react";
import type { Project } from "../../messages";
import {
  Card,
  CardBorder,
  CardHead,
  Checkbox,
  Name,
  Path,
  StatusBadges,
  Badge,
  MsgArea,
  MsgText,
  MsgEditor,
  ActionRow,
  SmallBtn,
  Conflict,
} from "../sc";
import { Spinner } from "../sc";

interface Props {
  project: Project;
  streaming?: string;
  checked: boolean;
  ollamaConnected: boolean | null;
  /** 该卡片是否正在等 setMessage 的 ack（用于 disable textarea / 按钮） */
  saving?: boolean;
  onToggle(): void;
  onMessage(msg: string): void;
  onRegenerate(): void;
  onPush(): void;
}

export function ProjectCard(p: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.project.message);
  const [flash, setFlash] = useState(false);
  const last = useRef("");

  useEffect(() => {
    // 流式或新消息到达：闪一下提示
    if (p.project.message && p.project.message !== last.current) {
      setDraft(p.project.message);
      last.current = p.project.message;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 120);
      return () => clearTimeout(t);
    }
  }, [p.project.message]);

  const st = p.project.status;
  const isStreaming = p.streaming !== undefined;
  const shownMessage = isStreaming ? p.streaming : (p.project.message || (p.project.phase === "generating" ? "生成中…" : ""));
  // 可编辑 message 的阶段：ready（AI 已生成）/ ready_failed（AI 失败，可手填）/ committed（已 commit 但想改也得允许）
  const editable = p.project.phase === "ready" || p.project.phase === "ready_failed" || p.project.phase === "committed";
  // 是否已提交（不论 push 与否）：已提交就不再"重新生成 message"
  const isCommitted = p.project.phase === "committed" || p.project.phase === "pushing" || p.project.phase === "push_ok" || p.project.phase === "push_failed" || p.project.phase === "commit_failed";
  // 是否需要 push（已提交但还没 push）：仅这一阶段显示「重试 push」
  const needPush = p.project.phase === "committed";
  // 当前卡片是否有异步操作在进行中
  const isBusy =
    p.project.phase === "generating" ||
    p.project.phase === "committing" ||
    p.project.phase === "pushing" ||
    p.saving === true;
  // busy 时 textarea 一律不可编辑（避免与 host 状态错位）
  const canEditMessage = editable && !isBusy;

  return (
    <Card $conflict={st?.hasConflicts} $flash={flash}>
      <CardBorder $selected={p.checked} />
      <CardHead>
        <Checkbox type="checkbox" checked={p.checked} onChange={p.onToggle} />
        <StatusBadges>
          {st && <Badge $tone={st.dirtiness}>{st.dirtiness === "clean" ? "干净" : st.dirtiness === "staged" ? "已暂存" : st.dirtiness === "dirty" ? "脏" : "冲突"}</Badge>}
          {st && <Badge $tone={st.pushState}>{st.pushState === "ahead" ? `未推 ${st.ahead}` : st.pushState === "behind" ? `落后 ${st.behind}` : st.pushState === "synced" ? "已同步" : "无 remote"}</Badge>}
        </StatusBadges>
        <Name title={p.project.path}>{p.project.name}</Name>
        <Path>{p.project.path}</Path>
      </CardHead>
      <MsgArea>
        {editing ? (
          <MsgEditor
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (isBusy) return; // busy 时 textarea 已经 disabled；onBlur 也兜一道
              p.onMessage(draft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setEditing(false); return; }
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                if (isBusy) return;
                p.onMessage(draft);
                setEditing(false);
              }
            }}
            disabled={isBusy}
            placeholder={isBusy ? "操作进行中，message 暂时锁定" : undefined}
            autoFocus
          />
        ) : (
          <MsgText onClick={() => canEditMessage && setEditing(true)} title={canEditMessage ? "点击编辑 message" : isBusy ? "操作进行中，message 暂时锁定" : undefined}>
            {shownMessage || (p.ollamaConnected === false ? "（AI 未连接，手动填写 message 后提交）" : "（等待生成）")}
          </MsgText>
        )}
      </MsgArea>
      <ActionRow>
        <SmallBtn onClick={() => { if (canEditMessage) setEditing(true); }} disabled={!canEditMessage}>
          改 message
        </SmallBtn>
        {!isCommitted && (
          <SmallBtn
            onClick={p.onRegenerate}
            disabled={!p.ollamaConnected || isBusy}
            $loading={p.project.phase === "generating"}
          >
            {p.project.phase === "generating" && <Spinner />}
            {p.project.phase === "generating" ? "生成中…" : "重生成"}
          </SmallBtn>
        )}
        {needPush && (
          <SmallBtn
            onClick={p.onPush}
            disabled={isBusy}
            $loading={p.project.phase === "pushing"}
          >
            {p.project.phase === "pushing" && <Spinner />}
            {p.project.phase === "pushing" ? "推送中…" : "重试 push"}
          </SmallBtn>
        )}
        {p.project.phase === "committing" && (
          <SmallBtn disabled $loading>
            <Spinner /> 提交中…
          </SmallBtn>
        )}
        {p.saving && (
          <SmallBtn disabled $loading>
            <Spinner /> 保存中…
          </SmallBtn>
        )}
        {st?.hasConflicts && <Conflict>此项目存在冲突，请先在编辑器里解决</Conflict>}
      </ActionRow>
    </Card>
  );
}