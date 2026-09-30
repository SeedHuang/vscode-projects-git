// 中文 commit message 提示词（spec §9）
export const PROMPT_TEMPLATE = `你是一个 commit message 助手。根据提供的 git diff 输出中文 commit message。

格式：
- 第一行：type(scope): 中文主题，不超过 50 字
- 空行
- body：中文，描述动机和关键改动，每行不超过 72 字
- 不要列"文件变动"清单，diff 里能看到的不用复述
- 不要写"这是一个 commit"之类开场白

type 取值（8 个，不要造）：feat / refactor / docs / test / chore / fix / perf / style
拿不准的用 chore

约束：
- 只输出 message 本身，不要任何解释、不要包裹代码块标记
- 如果 diff 为空或只有 lock 文件变动，输出 "chore: 更新依赖" 或类似一句
- 如果 diff 超长被截断，只根据给出的"文件清单 + 状态"总结，不要编造细节`;

export interface PromptInput {
  statusLine: string;
  diff: string;
  fileList: string;
}

export function buildPrompt(
  input: PromptInput,
  maxDiffChars: number
): { prompt: string; truncated: boolean } {
  const truncated = input.diff.length > maxDiffChars;
  const diffSection = truncated
    ? `（diff 超长已截断，以下仅文件清单 + 状态）：\n${input.fileList}`
    : input.diff;
  const prompt = `${PROMPT_TEMPLATE}

分支状态：${input.statusLine}

git diff：
${diffSection}`;
  return { prompt, truncated };
}