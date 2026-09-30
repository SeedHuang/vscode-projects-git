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
import { detectHost, resolveStateDbPath } from "./scanner/hostDetector";
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
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body{padding:0;margin:0;height:100%}</style>
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

  // ---- 前置检查（spec §11.4），一次性提醒 ----
  void checkPrerequisites(cfg, dbPath, (p) => fsp.access(p).then(() => true, () => false)).then(
    (r) => {
      log.push(`prereq: git=${r.git} ollama=${r.ollama} db=${r.db} host=${host}`);
      const missing: string[] = [];
      if (!r.git) missing.push("未检测到 git 命令，请安装 git");
      if (!r.ollama) missing.push("Ollama 未连接，AI 生成不可用（可手动填写 message 提交）");
      if (!r.db) missing.push("未找到宿主的最近项目数据库，项目列表可能为空");
      if (missing.length > 0) void vscode.window.showWarningMessage(missing.join("；"));
      panel.post({ type: "ollamaState", connected: r.ollama });
    }
  );

  // ---- 创建 webview provider 与协调器 ----
  const panel = new PanelProvider(context, log);

  // ---- Ollama worker：hooks 落 store（spec §5.1 streamDone 走 messageStore） ----
  const ollama = new OllamaWorker(
    {
      url: cfg.ollamaUrl,
      model: cfg.ollamaModel,
      maxDiffChars: cfg.maxDiffChars,
      timeoutMs: cfg.ollamaTimeoutMs,
    },
    {
    onStream: (p, chunk) => panel.post({ type: "stream", path: p, chunk }),
    onDone: (p, message) => {
      store.set(p, message);
      panel.post({ type: "streamDone", path: p, message });
    },
    onFailed: (p, reason) => {
      log.push(`ollama failed ${p}: ${reason}`);
      panel.post({ type: "status", path: p, phase: "ready_failed", error: reason });
    },
    onFatal: (reason) => {
      log.push(`ollama fatal: ${reason}`);
      void vscode.window.showErrorMessage(reason);
    },
  });

  // ---- Discovery 注入 ----
  const discover = async (): Promise<DiscoveredProject[]> => {
    if (!dbPath) return [];
    const sqlFactory = (): Promise<SqlJsStatic> =>
      initSqlJs({
        locateFile: (f: string) => path.join(context.extensionPath, "dist", f),
      });
    const tmpCopy = async (_file: string): Promise<string> => {
      const t = path.join(os.tmpdir(), `vscode-recent-${randomUUID()}.db`);
      await fsp.copyFile(dbPath, t);
      return t;
    };
    return discoverRecentProjects({
      readFile: (p) => fsp.readFile(p),
      exists: (p) => fsp.access(p).then(() => true, () => false),
      isGitRepo: async (p) => {
        try { await fsp.access(path.join(p, ".git")); return true; } catch { return false; }
      },
      realpath: (p) => fsp.realpath(p).catch(() => p),
      createSql: sqlFactory,
      tmpCopy,
      unlink: (p) => fsp.unlink(p).catch(() => {}),
    });
  };

  // ---- diff 取材（喂给模型的原料） ----
  const diffFor = async (p: string) => {
    const s = await runGit(p, ["status", "--porcelain", "-b"], 10000);
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
          void scanCoordinator.scan();
          break;
        case "regenerate":
          void (async () => {
            const d = await diffFor(m.path);
            ollama.enqueue({ path: m.path, ...d });
          })();
          break;
        case "setMessage":
          store.set(m.path, m.message);
          emit({ type: "ack", ackId: m.ackId });
          break;
        case "commit":
          void commitCoordinator.commit(m.paths).then((s) =>
            emit({ type: "batchDone", ...s })
          );
          break;
        case "push":
          void commitCoordinator.pushOne(m.path);
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
      webviewOptions: { retainContextWhenHidden: false },
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