// Ollama 串行生成队列（spec §5.1/§5.2）
// 一次只跑一个请求（显存限制），FIFO；404 视为配置错误 → fatal 清队列
import { streamGenerate, OllamaHttpError } from "../ollama/streamClient";
import { buildPrompt } from "../ollama/prompt";

export interface OllamaTask {
  path: string;
  statusLine: string;
  diff: string;
  fileList: string;
}

export interface OllamaHooks {
  onStream(path: string, chunk: string): void;
  onDone(path: string, message: string): void;
  onFailed(path: string, reason: string): void;
  onFatal(reason: string): void;
  /** 调试用日志回调（可选，不传则静默） */
  _log?(msg: string): void;
}

export interface OllamaConfig {
  url: string;
  model: string;
  maxDiffChars: number;
  timeoutMs: number;
}

export class OllamaWorker {
  private queue: OllamaTask[] = [];
  private running = false;
  private aborted = false;
  /** 测试可见性：hooks 可替换 */
  constructor(
    private cfg: OllamaConfig,
    public hooks: OllamaHooks
  ) {}

  enqueue(task: OllamaTask): void {
    if (this.aborted) {
      this.hooks.onFailed?.(task.path, "aborted_before_enqueue");
      return;
    }
    this.hooks._log?.(`enqueue ${task.path} queueLen=${this.queue.length + 1} aborted=${this.aborted} running=${this.running}`);
    this.queue.push(task);
    void this.pump();
  }

  removeQueued(path: string): void {
    this.queue = this.queue.filter((t) => t.path !== path);
  }

  abortAll(): void {
    // 彻底关停：标记 aborted 并清空队列。
    // 调用方负责 dispose / 不会再用此 worker。
    this.aborted = true;
    this.queue = [];
  }

  /** 仅清空队列，不改 aborted 状态（用于 dispose 路径之外的「取消当前批」场景） */
  clearQueue(): void {
    this.queue = [];
  }

  private async pump(): Promise<void> {
    this.hooks._log?.(`pump enter running=${this.running} qLen=${this.queue.length}`);
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        this.hooks._log?.(`pump pop ${task.path}`);
        try {
          const { prompt, truncated } = buildPrompt(
            { statusLine: task.statusLine, diff: task.diff, fileList: task.fileList },
            this.cfg.maxDiffChars
          );
          this.hooks._log?.(`pump buildPrompt url=${this.cfg.url} model=${this.cfg.model} promptLen=${prompt.length} truncated=${truncated}`);
          const text = await streamGenerate(
            this.cfg.url,
            { model: this.cfg.model, prompt, stream: true, options: { temperature: 0.2 } },
            { timeoutMs: this.cfg.timeoutMs },
            (chunk) => this.hooks.onStream(task.path, chunk)
          );
          if (text.trim().length === 0) {
            this.hooks.onFailed(task.path, "empty_response");
          } else {
            this.hooks.onDone(task.path, text.trim());
          }
        } catch (e) {
          this.hooks._log?.(`pump catch ${task.path}: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
          if (e instanceof OllamaHttpError && e.status === 404) {
            this.hooks.onFailed(task.path, "model_not_found");
            this.queue = [];
            this.hooks.onFatal(`模型 ${this.cfg.model} 不存在（HTTP 404），请检查 gitBatch.ollamaModel`);
            return;
          }
          this.hooks.onFailed(task.path, String(e instanceof Error ? e.message : e));
        }
      }
    } finally {
      this.running = false;
    }
  }
}