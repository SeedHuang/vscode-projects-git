import { ToolWrap, TBtn } from "../sc";
import type { Filter } from "../App";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "uncommitted", label: "未提交" },
  { key: "unpushed", label: "未 push" },
  { key: "conflict", label: "冲突" },
];

interface Props { filter: Filter; onFilter: (f: Filter) => void; }

export function Toolbar(p: Props) {
  return (
    <ToolWrap>
      {FILTERS.map((f) => (
        <TBtn key={f.key} $active={p.filter === f.key} onClick={() => p.onFilter(f.key)}>
          {f.label}
        </TBtn>
      ))}
    </ToolWrap>
  );
}