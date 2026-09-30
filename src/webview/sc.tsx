// styled 定义集中在 sc.tsx（用户规则：styled 必须独立文件）
import styled, { css } from "styled-components";

const easeOut = css`cubic-bezier(0.23, 1, 0.32, 1)`;

export const Shell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
`;

export const ease = easeOut;

export const HeaderWrap = styled.div`
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; gap: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
`;
export const HeaderStats = styled.div`
  display: flex; align-items: center; gap: 8px; min-width: 0;
`;
export const StatPill = styled.span<{ $tone: "warn" | "info" }>`
  padding: 1px 8px; border-radius: 10px; font-size: 11px;
  ${({ $tone }) => $tone === "warn"
    ? "background: rgba(204,120,50,0.18); color: var(--vscode-editorWarning-foreground);"
    : "background: rgba(54,140,204,0.18); color: var(--vscode-editorInfo-foreground);"}
`;
export const Dot = styled.span<{ $ok: boolean }>`
  width: 8px; height: 8px; border-radius: 50%;
  background: ${({ $ok }) => ($ok ? "var(--vscode-testing-iconPassed, #73c991)" : "var(--vscode-errorForeground)")};
  transition: background 200ms ${easeOut};
`;
export const HBtn = styled.button`
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none; padding: 4px 12px; margin-left: 8px; cursor: pointer; border-radius: 2px;
  transition: transform 160ms ${easeOut}, background 120ms ease;
  &:hover { background: var(--vscode-button-secondaryHoverBackground); }
  &:active { transform: scale(0.97); }
  @media (prefers-reduced-motion: reduce) { transition: background 120ms ease; }
`;
export const HBtnPrimary = styled(HBtn)<{ $danger?: boolean }>`
  background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-background)")};
  color: ${({ $danger }) => ($danger ? "#fff" : "var(--vscode-button-foreground)")};
  &:hover { background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-hoverBackground)")}; }
  &:disabled { opacity: 0.5; cursor: default; transform: none; }
`;
export const ToolWrap = styled.div`
  display: flex; gap: 4px; padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
`;
export const TBtn = styled.button<{ $active?: boolean }>`
  background: transparent; color: ${({ $active }) => ($active ? "var(--vscode-focusBorder)" : "var(--vscode-foreground)")};
  border: none; border-bottom: 2px solid ${({ $active }) => ($active ? "var(--vscode-focusBorder)" : "transparent")};
  padding: 4px 10px; cursor: pointer;
  transition: color 150ms ease, border-color 150ms ${easeOut};
`;

/* ---- List + Card ---- */
export const List = styled.div`
  flex: 1; overflow: auto; padding: 8px 12px;
  > div { opacity: 0; transform: translateY(8px); animation: cardIn 200ms ${easeOut} forwards; }
  @keyframes cardIn { to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { > div { animation: none; opacity: 1; transform: none; } }
`;
export const EmptyState = styled.div`
  margin: auto; text-align: center; padding: 32px; opacity: 0.7;
`;
export const Card = styled.div<{ $conflict?: boolean; $flash?: boolean }>`
  position: relative; padding: 8px 10px; margin-bottom: 6px;
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  background: ${({ $conflict }) => ($conflict ? "rgba(255, 80, 80, 0.06)" : "var(--vscode-editor-background)")};
  transition: background 120ms ease;
`;
export const CardBorder = styled.div<{ $selected: boolean }>`
  position: absolute; left: 0; top: 0; bottom: 0;
  width: ${({ $selected }) => ($selected ? "4px" : "0")};
  background: var(--vscode-focusBorder);
  transition: width 200ms ${easeOut};
  pointer-events: none;
`;
export const CardHead = styled.div`
  display: flex; align-items: center; gap: 8px; min-width: 0;
`;
export const Checkbox = styled.input`
  flex: 0 0 auto;
`;
export const StatusBadges = styled.div`
  display: flex; gap: 4px; flex: 0 0 auto;
`;
export const Badge = styled.span<{ $tone: string }>`
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
`;
export const Name = styled.span`
  font-weight: 600; min-width: 0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
`;
export const Path = styled.span`
  font-size: 11px; opacity: 0.7; min-width: 0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; direction: rtl; margin-left: auto;
`;
export const MsgArea = styled.div`
  margin: 6px 0 4px 24px; min-height: 22px;
  position: relative;
`;
export const MsgText = styled.div`
  cursor: text; white-space: pre-wrap; word-break: break-word;
  padding: 2px 4px; border-radius: 2px;
  &:hover { background: rgba(127,127,127,0.08); }
  transition: background 100ms ${easeOut};
`;
export const MsgEditor = styled.textarea`
  width: 100%; min-height: 60px; resize: vertical;
  font-family: inherit; font-size: 12px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 2px; padding: 4px;
  transition: height 180ms ${easeOut};
`;
export const ActionRow = styled.div`
  display: flex; gap: 6px; align-items: center; margin-left: 24px;
`;
export const SmallBtn = styled.button`
  background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border); padding: 2px 8px; cursor: pointer; border-radius: 2px;
  font-size: 11px;
  transition: transform 160ms ${easeOut}, background 120ms ease;
  &:hover { background: var(--vscode-list-hoverBackground); }
  &:active { transform: scale(0.97); }
  &:disabled { opacity: 0.5; cursor: default; transform: none; }
`;
export const Conflict = styled.span`
  color: var(--vscode-errorForeground); font-size: 11px; margin-left: 8px;
`;

/* ---- Footer ---- */
export const FooterWrap = styled.div`
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-top: 1px solid var(--vscode-panel-border);
  font-size: 11px;
`;
export const FooterText = styled.span`
  opacity: 0.85;
`;