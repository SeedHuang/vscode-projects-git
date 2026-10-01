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
export const Dot = styled.span<{ $state: "checking" | "ok" | "fail" }>`
  width: 8px; height: 8px; border-radius: 50%;
  background: ${({ $state }) =>
    $state === "ok" ? "var(--vscode-testing-iconPassed, #73c991)" :
    $state === "fail" ? "var(--vscode-errorForeground, #f48771)" :
    "#888"};
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

/* icon-only 按钮（toolbar 用）。SVG 子元素接管尺寸，颜色继承 currentColor */
export const IconBtn = styled.button<{ $tone?: "primary" | "danger" | "neutral" }>`
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px;
  margin-left: 6px;
  padding: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: ${({ $tone }) =>
    $tone === "primary" ? "var(--vscode-button-background)" :
    $tone === "danger"  ? "var(--vscode-button-secondaryBackground)" :
    "var(--vscode-button-secondaryBackground)"};
  color: ${({ $tone }) =>
    $tone === "primary" ? "var(--vscode-button-foreground)" :
    $tone === "danger"  ? "var(--vscode-button-secondaryForeground)" :
    "var(--vscode-button-secondaryForeground)"};
  cursor: pointer;
  transition: transform 160ms ${easeOut}, background 120ms ease, border-color 120ms ease;
  &:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
    border-color: var(--vscode-focusBorder);
  }
  &:active:not(:disabled) { transform: scale(0.94); }
  &:disabled { opacity: 0.4; cursor: default; transform: none; }
  &:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }

  > svg { width: 16px; height: 16px; flex: 0 0 auto; pointer-events: none; }

  /* hover tooltip：用 ::after 渲染中文提示，零依赖 */
  &:hover:not(:disabled)::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    white-space: nowrap;
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-editorWidget-foreground, #cccccc);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 3px;
    padding: 3px 8px;
    font-size: 11px;
    line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    z-index: 10;
    pointer-events: none;
    animation: iconTipIn 120ms ${easeOut} forwards;
  }
  @keyframes iconTipIn {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) { transition: background 120ms ease; }
`;
export const HBtnPrimary = styled(HBtn)<{ $danger?: boolean }>`
  background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-background)")};
  color: ${({ $danger }) => ($danger ? "#fff" : "var(--vscode-button-foreground)")};
  &:hover { background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-hoverBackground)")}; }
  &:disabled { opacity: 0.5; cursor: default; transform: none; }
`;
/** 与 HBtnPrimary 视觉一致，但默认偏中性（用于 push 这种有破坏性的批量动作） */
export const HBtnDanger = styled(HBtn)<{ $danger?: boolean }>`
  background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-secondaryBackground)")};
  color: ${({ $danger }) => ($danger ? "#fff" : "var(--vscode-button-secondaryForeground)")};
  &:hover { background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-secondaryHoverBackground)")}; }
`;
/* ---- Tab 行（Header 中间） ---- */
export const TabRow = styled.div`
  display: flex; align-items: center; gap: 6px; min-width: 0;
`;
export const TabBtn = styled.button<{ $active?: boolean }>`
  background: transparent;
  color: ${({ $active }) => ($active ? "var(--vscode-foreground)" : "var(--vscode-foreground)")};
  opacity: ${({ $active }) => ($active ? 1 : 0.65)};
  border: none;
  padding: 4px 4px;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px;
  border-bottom: 2px solid ${({ $active }) => ($active ? "var(--vscode-focusBorder)" : "transparent")};
  transition: opacity 150ms ease, border-color 150ms ${easeOut};
  &:hover { opacity: 1; }
`;

/** Tab 文字后面的小数字包。tone 决定颜色；active 时加深描边 */
export const TabNum = styled.span<{ $tone: "neutral" | "warn" | "info" | "danger"; $active?: boolean }>`
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  ${({ $tone, $active }) => {
    const base = (() => {
      switch ($tone) {
        case "warn":
          return "background: rgba(204,120,50,0.20); color: #d79961; border-color: rgba(204,120,50,0.55);";
        case "info":
          return "background: rgba(54,140,204,0.20); color: #5fa3d6; border-color: rgba(54,140,204,0.55);";
        case "danger":
          return "background: rgba(244,135,113,0.20); color: #f48771; border-color: rgba(244,135,113,0.55);";
        default:
          return "background: rgba(127,127,127,0.18); color: var(--vscode-foreground); border-color: rgba(127,127,127,0.40);";
      }
    })();
    const activeBorder = $active && $tone !== "neutral"
      ? `border-width: 1.5px;`
      : `border: 1px solid transparent;`;
    return `${base} ${activeBorder}`;
  }}
  transition: border-width 150ms ${easeOut};
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
  cursor: pointer;
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
export const SmallBtn = styled.button<{ $loading?: boolean }>`
  background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border); padding: 2px 8px; cursor: pointer; border-radius: 2px;
  font-size: 11px;
  display: inline-flex; align-items: center; gap: 4px;
  transition: transform 160ms ${easeOut}, background 120ms ease;
  &:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
  &:active:not(:disabled) { transform: scale(0.97); }
  &:disabled { opacity: 0.5; cursor: default; transform: none; }
  ${({ $loading }) => $loading && `
    color: var(--vscode-editorWarning-foreground);
    border-color: var(--vscode-editorWarning-foreground);
  `}
`;

/* 全局 spinner：纯 CSS div 旋转，被 SmallBtn / IconBtn 引用。
   用 styled.span + 全局 keyframes 是为了避开 styled-components 给 keyframe 加唯一 hash
   后导致不同 styled 之间动画名对不上的问题。 */
export const Spinner = styled.span`
  display: inline-block;
  width: 10px; height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  flex: 0 0 auto;
  box-sizing: border-box;
  animation: gitBatchSpinner 0.8s linear infinite;
  @media (prefers-reduced-motion: reduce) {
    animation-duration: 2.4s;
  }
`;

/* 顶层 style（注入到 Shell 里）—— spinner 用的全局 keyframes */
export const GlobalStyles = styled.div`
  @keyframes gitBatchSpinner {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
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