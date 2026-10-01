// 插件激活入口：装配 ScanCoordinator / CommitCoordinator / OllamaWorker / Webview
import * as vscode from "vscode";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  DiscoveredProject,
  HostMessage,
  WebviewMessage,
} from "./messages";
import { detectHost, resolveStateDbPath, resolveStorageJsonPath } from "./scanner/hostDetector";
import { discoverRecentProjects } from "./scanner/DiscoveryWorker";
import { getGitStatuses } from "./scanner/GitStatusWorker";
import { OllamaWorker } from "./scanner/OllamaWorker";
import { MessageStore, ScanCoordinator } from "./scanner/ScanCoordinator";
import { CommitCoordinator } from "./committer/CommitCoordinator";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { checkPrerequisites, LogBuffer } from "./prereq";
import { runGit } from "./git/spawnGit";

class PanelProvider implements vscode.WebviewViewProvider {
  public static viewId = "gitBatch.panel";
  private panel?: vscode.WebviewView;
  private listeners: Array<(m: HostMessage) => void> = [];

  constructor(
    private ctx: vscode.ExtensionContext,
    private log: LogBuffer
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.panel = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => {
      const msg = m as HostMessage;
      this.log.push(`msg: ${msg.type}`);
      for (const l of this.listeners) l(msg);
    });
    view.onDidDispose(() => {
      this.log.push("webview disposed");
      for (const l of this.listeners) l({ type: "dispose" });
      this.panel = undefined;
    });
  }

  post(m: WebviewMessage): void {
    void this.panel?.webview.postMessage(m);
  }

  onMessage(handler: (m: HostMessage) => void): vscode.Disposable {
    this.listeners.push(handler);
    return new vscode.Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== handler);
    });
  }

  private html(webview: vscode.Webview): string {
    const script = vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview.js");
    const nonce = randomUUID();
    // WebviewView 模式下：sidebar 给容器一个固定高度，body 用 100% 撑满父容器
    // script-src 必须含 cspSource 才能让 src= 加载（nonce 仅覆盖 inline script）
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>
html,body{margin:0;padding:0;height:100%;overflow:hidden;}
#root{height:100%;display:flex;flex-direction:column;}
</style>
</head>
<body><div id="root"></div>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body></html>`;
  }
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration("gitBatch");
  return {
    ollamaUrl: cfg.get<string>("ollamaUrl", "http://localhost:11434"),
    ollamaModel: cfg.get<string>("ollamaModel", "qwen3-4b-instruct-2507"),
    commitConcurrency: cfg.get<number>("commitConcurrency", 3),
    maxDiffChars: cfg.get<number>("maxDiffChars", 8000),
    ollamaTimeoutMs: cfg.get<number>("ollamaTimeoutMs", 30000),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const log = new LogBuffer();
  const cfg = readConfig();
  const store = new MessageStore();
  const host = detectHost(process.argv[0]);
  const dbPath = resolveStateDbPath(host, process.env);
  const storageJsonPath = resolveStorageJsonPath(host, process.env);

  // 专用 OutputChannel：调试时选 "Git Batch" 即可看到 discovery / scan / ollama 全链路日志
  const out = vscode.window.createOutputChannel("Git Batch", { log: true });
  const logLine = (s: string) => { log.push(s); out.info(s); };
  out.info(`activated host=${host} dbPath=${dbPath ?? "<null>"} storageJson=${storageJsonPath ?? "<null>"} argv0=${process.argv[0] ?? ""}`);

  // ---- 创建 webview provider 与协调器 ----（必须先于 prereq.post，否则触发 TDZ ReferenceError）
  const panel = new PanelProvider(context, log);

  // prereq 结果缓存 + webview ready 时重发（activate 完成时 webview 还没挂，
  // prereq.then 里 panel.post 是空打——重发机制让面板真正打开时再补一条 ollamaState）
  let prereqResult: { git: boolean; ollama: boolean; db: boolean } | null = null;

  // ---- 前置检查（spec §11.4），一次性提醒 ----
  void checkPrerequisites(cfg, dbPath, (p) => fsp.access(p).then(() => true, () => false), logLine)
    .then((r) => {
      prereqResult = r;
      logLine(`prereq: git=${r.git} ollama=${r.ollama} db=${r.db} host=${host}`);
      const missing: string[] = [];
      if (!r.git) missing.push("未检测到 git 命令，请安装 git");
      if (!r.ollama) missing.push("Ollama 未连接，AI 生成不可用（可手动填写 message 提交）");
      if (!r.db) missing.push("未找到宿主的最近项目数据库，项目列表可能为空");
      if (missing.length > 0) void vscode.window.showWarningMessage(missing.join("；"));
      panel.post({ type: "ollamaState", connected: r.ollama });
    })
    .catch((e) => {
      logLine(`prereq crashed: ${String(e instanceof Error ? e.message : e)}`);
      prereqResult = { git: false, ollama: false, db: false };
      panel.post({ type: "ollamaState", connected: false });
    });

  // ---- Ollama worker：hooks 落 store（spec §5.1 streamDone 走 messageStore） ----
  const ollama = new OllamaWorker(
    {
      url: cfg.ollamaUrl,
      model: cfg.ollamaModel,
      maxDiffChars: cfg.maxDiffChars,
      timeoutMs: cfg.ollamaTimeoutMs,
    },
    {
    onStream: (p, chunk) => {
      logLine(`ollama stream ${p} +${chunk.length} chars`);
      panel.post({ type: "stream", path: p, chunk });
    },
    onDone: (p, message) => {
      logLine(`ollama done ${p} (${message.length} chars): ${message.split(/\r?\n/)[0]}`);
      store.set(p, message);
      panel.post({ type: "streamDone", path: p, message });
    },
    onFailed: (p, reason) => {
      logLine(`ollama failed ${p}: ${reason}`);
      panel.post({ type: "status", path: p, phase: "ready_failed", error: reason });
    },
    onFatal: (reason) => {
      logLine(`ollama fatal: ${reason}`);
      void vscode.window.showErrorMessage(reason);
    },
    _log: (msg) => logLine(`[ollama] ${msg}`),
  });

  // ---- Discovery 注入 ----
  const discover = async (): Promise<DiscoveredProject[]> => {
    if (!dbPath) { logLine("discover: dbPath is null — hostDetector 没拿到路径"); return []; }
    logLine(`discover: 读 ${dbPath}`);
    const sqlFactory = (): Promise<SqlJsStatic> =>
      initSqlJs({
        locateFile: (f: string) => path.join(context.extensionPath, "dist", f),
      });
    const tmpCopy = async (_file: string): Promise<string> => {
      const t = path.join(os.tmpdir(), `vscode-recent-${randomUUID()}.db`);
      await fsp.copyFile(dbPath, t);
      return t;
    };
    try {
       const list = await discoverRecentProjects({
         readFile: (p) => fsp.readFile(p),
         exists: (p) => fsp.access(p).then(() => true, () => false),
         isGitRepo: async (p) => {
           try { await fsp.access(path.join(p, ".git")); return true; } catch { return false; }
         },
         realpath: (p) => fsp.realpath(p).catch(() => p),
         createSql: sqlFactory,
         tmpCopy,
         unlink: (p) => fsp.unlink(p).catch(() => {}),
         readStorageJson: async (p) => JSON.parse(await fsp.readFile(p, "utf8")),
         stateDbPath: dbPath,
         storageJsonPath,
       });
       logLine(`discover: 发现 ${list.length} 个 git 项目`);
       for (const p of list.slice(0, 10)) logLine(`  · ${p.path}`);
       return list;
     } catch (e) {
       logLine(`discover: 失败 ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
       return [];
     }
  };

  // ---- diff 取材（喂给模型的原料） ----
  const diffFor = async (p: string) => {
    const s = await runGit(p, ["status", "--porcelain", "-b"], 10000);
    if (s.code !== 0) logLine(`diffFor: ${p} git status code=${s.code} stderr=${s.stderr.slice(0,200)}`);
    const fileList = s.stdout
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("## "))
      .map((l) => `${l.slice(3)} | ${l.slice(0, 2).trim()}`)
      .join("\n");
    const d = await runGit(p, ["diff", "HEAD"], 15000);
    const diff = d.code === 0 ? d.stdout : "";
    return { statusLine: s.stdout.split(/\r?\n/)[0] ?? "", diff, fileList };
  };

  const emit = (m: WebviewMessage) => panel.post(m);
  const scanCoordinator = new ScanCoordinator({
    discover,
    getStatuses: (paths) => getGitStatuses(paths),
    ollama,
    emit,
    store,
    diffFor,
  });
  const commitCoordinator = new CommitCoordinator({
    emit,
    store,
    concurrency: cfg.commitConcurrency,
  });

  // ---- 消息路由（spec §8.1） ----
  context.subscriptions.push(
    panel.onMessage((m) => {
      switch (m.type) {
        case "scan":
          logLine(`recv scan from webview`);
          void scanCoordinator.scan();
          break;
        case "ready":
          // webview 刚挂载，主动把 prereq 结果补给它（之前空打的 ollamaState 不会被收到）
          if (prereqResult) {
            logLine(`webview ready, replay ollamaState=${prereqResult.ollama}`);
            emit({ type: "ollamaState", connected: prereqResult.ollama });
          } else {
            logLine("webview ready, prereq not done yet — defer");
            setTimeout(() => {
              if (prereqResult) {
                logLine(`prereq late-done, replay ollamaState=${prereqResult.ollama}`);
                emit({ type: "ollamaState", connected: prereqResult.ollama });
              }
            }, 1500);
          }
          break;
        case "regenerate":
          logLine(`recv regenerate for ${m.path}`);
          void (async () => {
            try {
              const d = await diffFor(m.path);
              logLine(`regenerate: ${m.path} statusLine="${d.statusLine.split(/\r?\n/)[0]}" diffLen=${d.diff.length} files=${d.fileList.split(/\r?\n/).length}`);
              ollama.enqueue({ path: m.path, ...d });
            } catch (e) {
              logLine(`regenerate: ${m.path} threw ${String(e instanceof Error ? e.message : e)}`);
              emit({ type: "status", path: m.path, phase: "ready_failed", error: String(e instanceof Error ? e.message : e) });
            }
          })();
          break;
        case "regenMany":
          logLine(`recv regenMany for ${m.paths.length} paths`);
          void (async () => {
            for (const p of m.paths) {
              try {
                const d = await diffFor(p);
                ollama.enqueue({ path: p, ...d });
              } catch (e) {
                logLine(`regenMany: ${p} threw ${String(e instanceof Error ? e.message : e)}`);
                emit({ type: "status", path: p, phase: "ready_failed", error: String(e instanceof Error ? e.message : e) });
              }
            }
          })();
          break;
        case "setMessage":
          store.set(m.path, m.message);
          emit({ type: "ack", ackId: m.ackId, path: m.path });
          break;
        case "commit":
          logLine(`recv commit for ${m.paths.length} paths`);
          void commitCoordinator.commit(m.paths).then(async (s) => {
            logLine(`commit done: ok=${s.ok} commitFailed=${s.commitFailed} pushFailed=${s.pushFailed}`);
            emit({ type: "batchDone", ...s });
            // commit/push 真正改了 git 状态 → 追加一次 scan 重算 Tab 计数（commitCoordinator 内部已经 commit + push 全做了）
            await scanCoordinator.scan();
            logLine(`post-commit scan done`);
          });
          break;
        case "push":
          logLine(`recv push for ${m.path}`);
          void commitCoordinator.pushOne(m.path).then(async () => {
            await scanCoordinator.scan();
          });
          break;
        case "pushMany":
          logLine(`recv pushMany for ${m.paths.length} paths`);
          void commitCoordinator.pushMany(m.paths).then(async (s) => {
            emit({ type: "batchDone", ...s });
            await scanCoordinator.scan();
          });
          break;
        case "dispose":
          ollama.abortAll();
          commitCoordinator.dispose();
          break;
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("gitBatch.exportLogs", async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) { void vscode.window.showErrorMessage("无工作区目录，日志写入插件存储"); return; }
      const out = path.join(ws, ".vscode", "gitBatch-logs.txt");
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, log.dump(), "utf8");
      void vscode.window.showInformationMessage(`日志已写入 ${out}`);
    })
  );
}

export function deactivate(): void {}