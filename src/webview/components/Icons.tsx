// 集中放置 toolbar 用到的内联 SVG icon。所有图标使用 currentColor 继承按钮颜色。
// Spinner 不在这里导出，由 sc.tsx 提供 styled.span 版本（避免 SVG + CSS transform 在 webview 里失效）
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** 重新扫描 / 刷新循环箭头 */
export function IconRefresh(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.39-3.89" />
      <path d="M12 1.5v3h-3" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.39 3.89" />
      <path d="M4 14.5v-3h3" />
    </svg>
  );
}

/** 批量生成 message — 魔法棒 / 闪光笔 */
export function IconGenMsg(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M9.5 2.5l4 4-7 7-4 1 1-4 6-8z" />
      <path d="M12 5l-1.5-1.5" />
      <path d="M3 13l-1 1" />
      <path d="M2 9.5c.5-1 1.5-1.5 2.5-1" />
    </svg>
  );
}

/** 批量提交 — 勾选 + 文档 */
export function IconCommit(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M3 2.5h7l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M10 2.5v3h3" />
      <path d="M5 9.5l1.8 1.8L10.5 7.5" />
    </svg>
  );
}

/** 批量 push — 上传箭头 / 上升 */
export function IconPush(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M8 12V3" />
      <path d="M4.5 6.5L8 3l3.5 3.5" />
      <path d="M3 13.5h10" />
    </svg>
  );
}