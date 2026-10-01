import { Dot, FooterWrap, FooterText } from "../sc";

interface Props { ollamaConnected: boolean | null; lastBatch: string; }

export function Footer(p: Props) {
  const ollamaLabel =
    p.ollamaConnected === false ? "Ollama 未连接（可手动填写 message）" :
    p.ollamaConnected === null ? "Ollama 检测中…" :
    "Ollama 已连接";
  return (
    <FooterWrap>
      <Dot
        $state={p.ollamaConnected === null ? "checking" : p.ollamaConnected ? "ok" : "fail"}
      />
      <FooterText>{ollamaLabel}</FooterText>
      <FooterText style={{ marginLeft: "auto" }}>{p.lastBatch || "尚未批量提交"}</FooterText>
    </FooterWrap>
  );
}