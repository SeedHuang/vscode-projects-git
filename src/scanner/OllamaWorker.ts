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
    if (this.aborted) return;
    this.queue.push(task);
    void this.pump();
  }

  removeQueued(path: string): void {
    this.queue = this.queue.filter((t) => t.path !== path);
  }

  abortAll(): void {
    this.aborted = true;
    this.queue = [];
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          const { prompt } = buildPrompt(
            { statusLine: task.statusLine, diff: task.diff, fileList: task.fileList },
            this.cfg.maxDiffChars
          );
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