import { useState } from "react";
import { HeaderWrap, HeaderStats, HBtn, HBtnPrimary, Dot, StatPill } from "../sc";

interface Props {
  total: number;
  uncommitted: number;
  unpushed: number;
  ollamaConnected: boolean | null;
  onRescan: () => void;
  onBatchCommit: () => void;
  batchDisabled: boolean;
}

export function Header(p: Props) {
  // 两击确认：第一击进入待确认态，3 秒内第二击才真正提交（spec §13 不可逆保护）
  const [armed, setArmed] = useState(false);
  const armAndFire = () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    p.onBatchCommit();
  };
  return (
    <HeaderWrap>
      <HeaderStats>
        <span>{p.total} 个项目</span>
        <StatPill $tone="warn">未提交 {p.uncommitted}</StatPill>
        <StatPill $tone="info">未 push {p.unpushed}</StatPill>
        <Dot $ok={p.ollamaConnected !== false} title={p.ollamaConnected === false ? "Ollama 未连接" : "Ollama 已连接"} />
      </HeaderStats>
      <div>
        <HBtn onClick={p.onRescan}>全部重扫</HBtn>
        <HBtnPrimary
          onClick={armAndFire}
          disabled={p.batchDisabled}
          $danger={armed}
        >
          {armed ? "再点一次确认提交并 push" : "批量提交并 push"}
        </HBtnPrimary>
      </div>
    </HeaderWrap>
  );
}