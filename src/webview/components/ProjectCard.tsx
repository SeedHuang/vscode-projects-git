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

interface Props {
  project: Project;
  streaming?: string;
  checked: boolean;
  ollamaConnected: boolean | null;
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
  const editable = p.project.phase === "ready" || p.project.phase === "ready_failed" || p.project.phase === "committed";

  return (
    <Card $conflict={st?.hasConflicts} $flash={flash}>
      <CardBorder $selected={p.checked} />
      <CardHead>
        <Checkbox type="checkbox" checked={p.checked} onChange={p.onToggle} />
        <StatusBadges>
          {st && <Badge $tone={st.dirtiness}>{badge(st.dirtiness, st.dirtiness === "clean" ? "干净" : st.dirtiness === "staged" ? "已暂存" : st.dirtiness === "dirty" ? "脏" : "冲突")}</Badge>}
          {st && <Badge $tone={st.pushState}>{badge(st.pushState, st.pushState === "ahead" ? `未推 ${st.ahead}` : st.pushState === "behind" ? `落后 ${st.behind}` : st.pushState === "synced" ? "已同步" : "无 remote")}</Badge>}
        </StatusBadges>
        <Name title={p.project.path}>{p.project.name}</Name>
        <Path>{p.project.path}</Path>
      </CardHead>
      <MsgArea>
        {editing ? (
          <MsgEditor
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { p.onMessage(draft); setEditing(false); }}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
            autoFocus
          />
        ) : (
          <MsgText onClick={() => editable && setEditing(true)} title={editable ? "点击编辑 message" : undefined}>
            {shownMessage || (p.ollamaConnected === false ? "（AI 未连接，手动填写 message 后提交）" : "（等待生成）")}
          </MsgText>
        )}
      </MsgArea>
      <ActionRow>
        <SmallBtn onClick={() => { setEditing(true); }} disabled={!editable}>改 message</SmallBtn>
        <SmallBtn onClick={p.onRegenerate} disabled={!p.ollamaConnected || p.project.phase === "generating"}>
          {p.project.phase === "generating" ? "生成中…" : "重生成"}
        </SmallBtn>
        {p.project.phase === "push_failed" && <SmallBtn onClick={p.onPush}>重试 push</SmallBtn>}
        {st?.hasConflicts && <Conflict>此项目存在冲突，请先在编辑器里解决</Conflict>}
      </ActionRow>
    </Card>
  );
}

function badge(key: string, label: string): string {
  return label; // key 备用，目前直接显示 label
}