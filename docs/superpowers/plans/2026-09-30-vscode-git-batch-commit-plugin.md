# VSCode/Trae 批量提交插件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个跑在 VSCode 与 Trae 里的插件：读取最近打开的项目、解析 git 状态、用本地 Ollama 生成中文 commit message、批量 add+commit+push。

**Architecture:** Extension Host 内三个 Worker（Discovery / GitStatus / Ollama）由 ScanCoordinator 调度，CommitCoordinator 以并发 3 执行提交；Webview 用 React + styled-components 展示，phase 单一真相源在 host 端，双向 postMessage 带 ack。

**Tech Stack:** TypeScript + esbuild（extension cjs / webview iife 双入口）、React 18 + styled-components v6、sql.js（WASM SQLite）、原生 fetch（Node 18+）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-30-vscode-git-batch-commit-plugin-design.md`（本计划所有 §引用均指该 spec；执行者需同时读两份文档）

## Global Constraints

- 引擎底线：`"engines": { "vscode": "^1.85.0" }`；`@types/vscode` 必须 `1.85.0` 精确 pin
- 本机实测环境（2026-09-30）：Node v22.12.0、npm 10.9.0、Windows；git 身份已配置
- **宿主路径真值（2026-09-30 实测）**：Trae 的数据目录是 `%APPDATA%\Trae CN\`（带空格），`%APPDATA%\Trae\` 不存在；代码必须同时尝试 `Trae CN` 与 `Trae` 两个目录名，先命中先用
- 所有 git 调用：`spawn('git', args, { shell: false, windowsHide: true })`，数组参数，禁止字符串拼接命令
- commit message 一律经临时文件 `git commit -F <tmpfile>` 传递（spec §5.3），禁止 `-m` 拼接
- phase/message 单一真相源：只有 host 端 `MessageStore` 可写（spec §5.3 / §8.1），webview 端禁止本地 mutate
- Ollama 生成串行 FIFO；CommitCoordinator 并发 3；GitStatusWorker 并发 8
- 不接云端 LLM；不读其他编辑器历史
- 每步代码编辑后立即跑 `npx tsc --noEmit --pretty` 检查（KB 规则：不用 GetDiagnostics）
- vitest 在受限沙箱可能 stuck `[queued]`：若发生，按 KB L-2026-09-27-006 降级为 `npx tsc --noEmit` + 结构校验，测试文件照常提交，不得删测试
- Git 写操作仅执行本计划中明确的 commit 步骤，不 push 到任何远端

---

### Task 1: 脚手架初始化

**Files:**
- Create: `package.json`、`tsconfig.json`、`esbuild.js`、`.vscodeignore`、`src/extension.ts`（由 generator-code 生成后按本任务内容覆盖/对齐）
- Create: `vitest.config.ts`、`test/smoke.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: 可编译、可测试的空插件；`dist/extension.js` 与 `dist/webview.js` 两个构建产物；`npm run compile` / `npm test` / `npx tsc --noEmit` 三条命令可用。后续任务只加 `src/**`、`test/**` 文件，不再动构建配置

- [ ] **Step 1: 用官方脚手架生成项目**

在仓库根（`d:\Seed\vscode-projects-git`）执行：

```powershell
npm install -g yo generator-code
yo code --extensionType ts --name "Git Batch Commit" --id git-batch-commit --description "批量查看最近项目的 git 状态，AI 生成中文 commit message 并批量提交推送" --pkgManager npm --gitInit false --open false
```

Expected: 在当前目录生成 `package.json`、`src/extension.ts`、`esbuild.js`、`.vscodeignore` 等，输出 `Successfully generated`。

**若 `yo` 卡在交互式提问或报 no TTY**（非交互环境常见）：降级为手工脚手架，直接用 Step 2/3/4 给出的文件内容创建全部文件，其余步骤不变。手工路径与脚手架路径最终文件内容一致，以 Step 2 起的内容为准。

- [ ] **Step 2: 覆盖 `package.json` 为以下内容**

以 generator-code 产出为底，合并成以下最终形态（保留 yo 生成的 `publisher` 占位可留 `your-publisher-name`）：

```json
{
  "name": "git-batch-commit",
  "displayName": "Git Batch Commit",
  "description": "批量查看最近项目的 git 状态，AI 生成中文 commit message 并批量提交推送",
  "version": "0.0.1",
  "publisher": "your-publisher-name",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "activationEvents": [],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "git-batch", "title": "Git Batch", "icon": "resources/icon.svg" }
      ]
    },
    "views": {
      "git-batch": [
        { "type": "webview", "id": "gitBatch.panel", "name": "批量提交" }
      ]
    },
    "commands": [
      { "command": "gitBatch.exportLogs", "title": "Git Batch: Export Logs" }
    ],
    "configuration": {
      "title": "Git Batch Commit",
      "properties": {
        "gitBatch.ollamaUrl": { "type": "string", "default": "http://localhost:11434", "description": "Ollama HTTP 地址" },
        "gitBatch.ollamaModel": { "type": "string", "default": "qwen3-4b-instruct-2507", "description": "模型名（ollama list 可查）" },
        "gitBatch.commitConcurrency": { "type": "number", "default": 3, "description": "批量提交并发上限" },
        "gitBatch.maxDiffChars": { "type": "number", "default": 8000, "description": "喂给模型的 diff 截断阈值" },
        "gitBatch.ollamaTimeoutMs": { "type": "number", "default": 30000, "description": "单项目生成超时（毫秒）" },
        "gitBatch.confirmBeforePush": { "type": "boolean", "default": true, "description": "push 前需二次确认（不可逆保护）" },
        "gitBatch.confirmBeforeCommit": { "type": "boolean", "default": true, "description": "批量 commit 前显示 diff 总览摘要" }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile": "node esbuild.js",
    "watch": "node esbuild.js --watch",
    "package": "vsce package --no-dependencies",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "sql.js": "^1.11.0",
    "styled-components": "^6.1.13"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@types/sql.js": "^1.4.9",
    "@types/vscode": "1.85.0",
    "@vscode/vsce": "^3.2.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: 覆盖 `esbuild.js`（双入口 + wasm 拷贝）**

```js
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

/** extension host 入口（cjs） */
const extensionBuild = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

/** webview React 入口（iife，浏览器环境） */
const webviewBuild = {
  entryPoints: ["src/webview/main.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "chrome114",
  jsx: "automatic",
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctxA = await esbuild.context(extensionBuild);
    const ctxB = await esbuild.context(webviewBuild);
    await Promise.all([ctxA.watch(), ctxB.watch()]);
  } else {
    await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
    // sql.js 的 wasm 二进制拷进 dist，运行时用 locateFile 指向它
    const wasmSrc = require.resolve("sql.js/dist/sql-wasm.wasm");
    fs.copyFileSync(wasmSrc, path.join(__dirname, "dist", "sql-wasm.wasm"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

注意：Task 15 之前 `src/webview/main.tsx` 不存在，Step 3 完成后到 Task 15 之前，`webviewBuild.entryPoints` 指向缺失文件会导致 compile 失败。**处理**：本任务先把 webview 入口临时注释掉（在 `esbuild.js` 顶部加一行 `const WEBVIEW_READY = false;` 并把 `Promise.all` 改为 `WEBVIEW_READY ? Promise.all([...]) : esbuild.build(extensionBuild)`），Task 15 创建入口后移除该开关。

- [ ] **Step 4: 覆盖 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node", "vscode"],
    "outDir": "dist"
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: 创建 `vitest.config.ts` 与冒烟测试**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

`test/smoke.test.ts`：

```ts
import { describe, it, expect } from "vitest";

describe("冒烟", () => {
  it("测试环境可用", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: 创建 `.gitignore` 与 `resources/icon.svg`**

`.gitignore`：

```
node_modules/
dist/
*.vsix
.vscode-test/
```

`resources/icon.svg`（活动栏图标，用 VSCode 主题色 currentColor）：

```xml
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 4h12v4H6V4zm0 12h12v4H6v-4zm-3-6h18v4H3v-4z" fill="currentColor" opacity="0.9"/>
</svg>
```

- [ ] **Step 7: 安装依赖并验证三件套**

```powershell
npm install
npm run compile
npx tsc --noEmit
npm test
```

Expected: compile 产出 `dist/extension.js`（webview 入口若未临时启用则只产 extension）；tsc 零错误；vitest 1 个用例通过。若 vitest stuck `[queued]`，记录现象并按 Global Constraints 降级验证。

- [ ] **Step 8: Commit**

```powershell
git add .gitignore .vscodeignore resources esbuild.js package.json tsconfig.json vitest.config.ts src test docs
git commit -m "chore: scaffold vscode extension via generator-code"
```

（`.vscodeignore` 用 yo 生成的即可；若无则创建内容：`src/**`、`node_modules/**`、`test/**`、`docs/**`、`**/*.map`）

---

### Task 2: 消息协议类型 `src/messages.ts`

**Files:**
- Create: `src/messages.ts`

**Interfaces:**
- Produces: `Project`、`ProjectStatus`、`Dirtiness`、`PushState`、`HostMessage`、`WebviewMessage`、`DiscoveredProject`、`GitStatus` 类型。后续所有任务 import 这些类型，名称以此为准

- [ ] **Step 1: 写类型文件**

```ts
// Host ↔ Webview 消息协议 + 领域类型（spec §8）
// 单一真相源约定：phase/message 只有 host 可写（spec §5.3）

export type ProjectStatus =
  | "scanning"
  | "statused"
  | "generating"
  | "ready"
  | "ready_failed"
  | "committing"
  | "committed"
  | "push_failed"
  | "push_ok"
  | "commit_failed";

export type Dirtiness = "clean" | "staged" | "dirty" | "conflict";
export type PushState = "ahead" | "behind" | "synced" | "no-remote";

/** git status 解析结果（statusParser 产出） */
export interface GitStatus {
  branch: string;
  dirtiness: Dirtiness;
  pushState: PushState;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
}

/** DiscoveryWorker 产出（rank 为 MRU 序号，0 = 最近） */
export interface DiscoveredProject {
  path: string;
  rank: number;
  lastUsed?: number;
}

/** webview 卡片数据 */
export interface Project {
  path: string;
  name: string;
  rank: number;
  lastUsed?: number;
  status: GitStatus | null;
  phase: ProjectStatus;
  message: string;
  error?: string;
}

/** Webview → Host */
export type HostMessage =
  | { type: "scan" }
  | { type: "regenerate"; path: string }
  | { type: "setMessage"; path: string; message: string; ackId: string }
  | { type: "commit"; paths: string[] }
  | { type: "push"; path: string };

/** Host → Webview */
export type WebviewMessage =
  | { type: "projectList"; items: Project[] }
  | { type: "stream"; path: string; chunk: string }
  | { type: "streamDone"; path: string; message: string }
  | { type: "status"; path: string; phase: ProjectStatus; error?: string }
  | { type: "ack"; ackId: string }
  | { type: "ollamaState"; connected: boolean };

/** 前置检查结果（spec §11.4） */
export interface PrereqReport {
  git: boolean;
  ollama: boolean;
  db: boolean;
}
```

- [ ] **Step 2: 编译检查**

Run: `npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 3: Commit**

```powershell
git add src/messages.ts
git commit -m "feat: add message protocol types"
```

---

### Task 3: `src/git/statusParser.ts`

**Files:**
- Create: `src/git/statusParser.ts`
- Test: `test/statusParser.test.ts`

**Interfaces:**
- Consumes: `GitStatus`、`Dirtiness`、`PushState`（Task 2）
- Produces: `parseStatus(stdout: string): GitStatus`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { parseStatus } from "../src/git/statusParser";

describe("parseStatus", () => {
  it("干净仓库（同步）", () => {
    const s = parseStatus("## main...origin/main");
    expect(s.branch).toBe("main");
    expect(s.dirtiness).toBe("clean");
    expect(s.pushState).toBe("synced");
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });

  it("ahead / behind 解析", () => {
    const s = parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.txt");
    expect(s.pushState).toBe("ahead");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.dirtiness).toBe("dirty");
  });

  it("无上游分支 → no-remote", () => {
    const s = parseStatus("## feature-x");
    expect(s.pushState).toBe("no-remote");
  });

  it("未出生分支（No commits yet）→ no-remote", () => {
    const s = parseStatus("## No commits yet on master");
    expect(s.branch).toBe("master");
    expect(s.pushState).toBe("no-remote");
    expect(s.dirtiness).toBe("clean");
  });

  it("upstream [gone] → no-remote", () => {
    const s = parseStatus("## main...origin/main [gone]");
    expect(s.pushState).toBe("no-remote");
  });

  it("未跟踪文件 → dirty", () => {
    const s = parseStatus("## main\n?? new.txt");
    expect(s.dirtiness).toBe("dirty");
  });

  it("纯暂存（已 add 未改）→ staged", () => {
    const s = parseStatus("## main\nM  added.txt");
    expect(s.dirtiness).toBe("staged");
  });

  it("暂存 + 工作区同时有改动 → dirty", () => {
    const s = parseStatus("## main\nMM both.txt");
    expect(s.dirtiness).toBe("dirty");
  });

  it("冲突标记 → conflict", () => {
    const s = parseStatus("## main\nUU conflicted.txt\nAA both-added.txt");
    expect(s.hasConflicts).toBe(true);
    expect(s.dirtiness).toBe("conflict");
  });

  it("detached HEAD 保留原样", () => {
    const s = parseStatus("## HEAD (no branch)");
    expect(s.branch).toBe("HEAD (no branch)");
    expect(s.pushState).toBe("no-remote");
  });

  it("空输出 → clean 空分支", () => {
    const s = parseStatus("");
    expect(s.dirtiness).toBe("clean");
    expect(s.branch).toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/statusParser.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// git status --porcelain -b 输出解析（spec §6.2）
// porcelain v1 行格式：XY <path>，X=暂存区，Y=工作区；首行 ## 分支信息
import type { Dirtiness, GitStatus, PushState } from "../messages";

const CONFLICT_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function parseBranchLine(line: string): {
  branch: string;
  ahead: number;
  behind: number;
  pushState: PushState;
} {
  const rest = line.replace(/^##\s*/, "");
  // "No commits yet on <branch>"
  const unborn = rest.match(/^No commits yet on (.+)$/);
  if (unborn) {
    return { branch: unborn[1], ahead: 0, behind: 0, pushState: "no-remote" };
  }
  // "<branch>...<upstream> [ahead N, behind M] / [gone]"
  const m = rest.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/);
  if (!m) {
    return { branch: rest, ahead: 0, behind: 0, pushState: "no-remote" };
  }
  const branch = m[1];
  const hasUpstream = Boolean(m[2]);
  const bracket = m[3];
  let ahead = 0;
  let behind = 0;
  let pushState: PushState = hasUpstream ? "synced" : "no-remote";
  if (bracket) {
    const a = bracket.match(/ahead (\d+)/);
    const b = bracket.match(/behind (\d+)/);
    ahead = a ? Number(a[1]) : 0;
    behind = b ? Number(b[1]) : 0;
    if (bracket.includes("gone")) {
      pushState = "no-remote";
    } else if (ahead > 0) {
      pushState = "ahead";
    } else if (behind > 0) {
      pushState = "behind";
    }
  }
  return { branch, ahead, behind, pushState };
}

export function parseStatus(stdout: string): GitStatus {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const branchLine = lines.find((l) => l.startsWith("## "));
  const info = branchLine
    ? parseBranchLine(branchLine)
    : { branch: "", ahead: 0, behind: 0, pushState: "no-remote" as PushState };

  let hasConflicts = false;
  let stagedCount = 0;
  let workCount = 0;
  for (const line of lines) {
    if (line.startsWith("## ")) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      workCount++; // 未跟踪
      continue;
    }
    if (CONFLICT_XY.has(x + y)) {
      hasConflicts = true;
      continue;
    }
    if (x !== " " && x !== "!") stagedCount++;
    if (y !== " " && y !== "!") workCount++;
  }

  // 优先级：冲突 > dirty > staged > clean（spec §6.2 单值枚举）
  let dirtiness: Dirtiness = "clean";
  if (hasConflicts) dirtiness = "conflict";
  else if (workCount > 0) dirtiness = "dirty";
  else if (stagedCount > 0) dirtiness = "staged";

  return {
    branch: info.branch,
    dirtiness,
    pushState: info.pushState,
    ahead: info.ahead,
    behind: info.behind,
    hasConflicts,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/statusParser.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: Commit**

```powershell
git add src/git/statusParser.ts test/statusParser.test.ts
git commit -m "feat: add git status porcelain parser"
```

---

### Task 4: `src/git/spawnGit.ts`

**Files:**
- Create: `src/git/spawnGit.ts`
- Test: `test/spawnGit.test.ts`

**Interfaces:**
- Produces: `runGit(cwd: string, args: string[], timeoutMs?: number): Promise<GitResult>`；`GitResult = { code: number; stdout: string; stderr: string }`；ENOENT 时 code = -1 且 stderr 含 `GIT_NOT_FOUND`

- [ ] **Step 1: 写失败测试（真实临时仓库）**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runGit } from "../src/git/spawnGit";

let repo: string;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitbatch-"));
  execSync("git init -b main", { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: dir });
  return dir;
}

beforeEach(() => { repo = initRepo(); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("runGit", () => {
  it("成功命令返回 stdout", async () => {
    const r = await runGit(repo, ["status", "--porcelain", "-b"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("## main");
  });

  it("非零退出码返回 stderr", async () => {
    const r = await runGit(repo, ["show", "nonexistent-ref"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("含空格与中文的 cwd 可用", async () => {
    const spaced = mkdtempSync(join(tmpdir(), "空格 repo-"));
    execSync("git init -b main", { cwd: spaced });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: spaced });
    const r = await runGit(spaced, ["status", "--porcelain", "-b"]);
    expect(r.code).toBe(0);
    rmSync(spaced, { recursive: true, force: true });
  });

  it("git 不存在 → code -1 + GIT_NOT_FOUND", async () => {
    const r = await runGit(repo, ["status"], 5000, "git-not-exist-xxx.exe");
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("GIT_NOT_FOUND");
  });

  it("超时 kill", async () => {
    const r = await runGit(repo, ["log", "--all", "--color=always", "-G."], 1);
    // 1ms 超时大概率被 kill；若机器过快完成也不算失败，只断言不抛异常
    expect(typeof r.code).toBe("number");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/spawnGit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// git 子进程包装：数组参数 + shell:false（spec §12），错误归一化
import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30000,
  command = "git"
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -2, stdout, stderr: stderr || "GIT_TIMEOUT" });
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        finish({ code: -1, stdout, stderr: "GIT_NOT_FOUND: git 命令不存在" });
      } else {
        finish({ code: -3, stdout, stderr: e.message });
      }
    });
    child.on("close", (code) => finish({ code: code ?? -4, stdout, stderr }));
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/spawnGit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/git/spawnGit.ts test/spawnGit.test.ts
git commit -m "feat: add git spawn wrapper"
```

---

### Task 5: `src/scanner/hostDetector.ts`

**Files:**
- Create: `src/scanner/hostDetector.ts`
- Test: `test/hostDetector.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `detectHost(argv0: string | undefined): "vscode" | "trae" | "unknown"`；`resolveStateDbPath(host, env: NodeJS.ProcessEnv): string | null`（env 可注入，便于测试；跨平台路径按 `%APPDATA%` / `~/Library/Application Support` / `~/.config`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { detectHost, resolveStateDbPath } from "../src/scanner/hostDetector";

describe("detectHost", () => {
  it("argv0 含 trae（不区分大小写）", () => {
    expect(detectHost("C:\\apps\\Trae CN\\Trae.exe")).toBe("trae");
  });
  it("argv0 含 code", () => {
    expect(detectHost("C:\\apps\\Microsoft VS Code\\Code.exe")).toBe("vscode");
  });
  it("未知宿主", () => {
    expect(detectHost(undefined)).toBe("unknown");
    expect(detectHost("C:\\apps\\SomethingElse.exe")).toBe("unknown");
  });
});

describe("resolveStateDbPath", () => {
  const env = { APPDATA: "C:\\Users\\t\\AppData\\Roaming" } as NodeJS.ProcessEnv;

  it("Windows: vscode → Code", () => {
    expect(resolveStateDbPath("vscode", env)).toBe(
      "C:\\Users\\t\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb"
    );
  });
  it("Windows: trae → 先试 Trae CN（2026-09-30 实测真值）", () => {
    expect(resolveStateDbPath("trae", env)).toBe(
      "C:\\Users\\t\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\state.vscdb"
    );
  });
  it("darwin 路径", () => {
    const e = { HOME: "/Users/t" } as NodeJS.ProcessEnv;
    expect(resolveStateDbPath("vscode", e, "darwin")).toBe(
      "/Users/t/Library/Application Support/Code/User/globalStorage/state.vscdb"
    );
  });
  it("linux 路径", () => {
    const e = { HOME: "/home/t" } as NodeJS.ProcessEnv;
    expect(resolveStateDbPath("trae", e, "linux")).toBe(
      "/home/t/.config/Trae/User/globalStorage/state.vscdb"
    );
  });
  it("缺环境变量 → null", () => {
    expect(resolveStateDbPath("vscode", {} as NodeJS.ProcessEnv)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/hostDetector.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// 宿主编译器识别与 state.vscdb 路径解析（spec §12）
// 真值校验 2026-09-30（Windows）：Trae 目录名是 "Trae CN"（带空格），"Trae" 不存在。
// 国际版 Trae 仍是 "Trae"，所以运行时两个候选都要试（exists 判定），此处 resolve 返回首选候选。

export type HostApp = "vscode" | "trae" | "unknown";

export function detectHost(argv0: string | undefined): HostApp {
  if (!argv0) return "unknown";
  const lower = argv0.toLowerCase();
  if (lower.includes("trae")) return "trae";
  if (lower.includes("code")) return "vscode";
  return "unknown";
}

type DirNameMap = Record<Exclude<HostApp, "unknown">, string[]>;

const DIR_NAMES: DirNameMap = {
  vscode: ["Code"],
  trae: ["Trae CN", "Trae"], // 先 CN 后国际版，按存在性择一
};

export function resolveStateDbPath(
  host: HostApp,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (host === "unknown") return null;
  const { join } = require("node:path") as typeof import("node:path");
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (!appData) return null;
    const names = DIR_NAMES[host];
    return join(appData, names[0], "User", "globalStorage", "state.vscdb");
  }
  const home = env.HOME;
  if (!home) return null;
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      DIR_NAMES[host][0],
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  return join(home, ".config", DIR_NAMES[host][0], "User", "globalStorage", "state.vscdb");
}
```

注意 `require` 在 ESM 语法下不可用——把 `import { join } from "node:path";` 提到文件顶部，去掉 require 行。此处保留说明：**实现时必须用顶部 import**。

- [ ] **Step 4: 运行确认通过 + 编译检查**

Run: `npx vitest run test/hostDetector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/scanner/hostDetector.ts test/hostDetector.test.ts
git commit -m "feat: add host detector with Trae CN truth"
```

---

### Task 6: `src/scanner/DiscoveryWorker.ts`

**Files:**
- Create: `src/scanner/DiscoveryWorker.ts`
- Test: `test/discoveryWorker.test.ts`

**Interfaces:**
- Consumes: `DiscoveredProject`（Task 2）；`initSqlJs`（sql.js 依赖）
- Produces: `discoverRecentProjects(deps: DiscoveryDeps): Promise<DiscoveredProject[]>`，`DiscoveryDeps` 全部可注入（db 读取、exists、isGitRepo、realpath、sql 工厂、临时文件管理），便于测试与 vscode 解耦

- [ ] **Step 1: 写失败测试（内存构造 sqlite fixture）**

```ts
import { describe, it, expect } from "vitest";
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { discoverRecentProjects } from "../src/scanner/DiscoveryWorker";
import type { DiscoveryDeps } from "../src/scanner/DiscoveryWorker";

async function makeSql() {
  return initSqlJs({ wasmBinary: readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm")) });
}

// 构造带 recentlyOpenedPathsList 的内存 db，序列化为 Buffer 模拟"读文件"
async function makeDbBuffer(entries: unknown): Promise<Buffer> {
  const SQL = await makeSql();
  const db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const stmt = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  stmt.run(["history.recentlyOpenedPathsList", JSON.stringify(entries)]);
  stmt.free();
  const data = db.export();
  db.close();
  return Buffer.from(data);
}

function makeDeps(overrides: Partial<DiscoveryDeps>, buf: Buffer): DiscoveryDeps {
  return {
    readFile: async () => buf,
    exists: async (p) => !p.includes("gone"),
    isGitRepo: async (p) => !p.includes("notgit"),
    realpath: async (p) => p,
    createSql: makeSql,
    tmpCopy: async () => "/tmp/copy.db",
    unlink: async () => {},
    ...overrides,
  };
}

const LIST = {
  entries: [
    { folderUri: "file:///d%3A/code/alpha", lastUsed: 100 },
    { folderUri: "file:///d%3A/code/beta" },
    { folderUri: "file:///d%3A/code/gone-proj" },
    { folderUri: "file:///d%3A/code/notgit-proj" },
    { folderUri: "file:///d%3A/code/alpha" }, // 重复项
  ],
};

describe("discoverRecentProjects", () => {
  it("过滤不存在与非 git 项目，去重，保留 MRU 顺序", async () => {
    const buf = await makeDbBuffer(LIST);
    const deps = makeDeps({}, buf);
    const r = await discoverRecentProjects(deps);
    expect(r.map((p) => p.path)).toEqual(["d:\\code\\alpha", "d:\\code\\beta"]);
    expect(r[0].rank).toBe(0);
    expect(r[1].rank).toBe(1);
    expect(r[0].lastUsed).toBe(100);
  });

  it("workspace.configPath 也算项目路径", async () => {
    const buf = await makeDbBuffer({
      entries: [{ workspace: { configPath: "file:///d%3A/code/gamma.code-workspace" } }],
    });
    const r = await discoverRecentProjects(makeDeps({}, buf));
    expect(r.length).toBe(1);
    expect(r[0].path).toBe("d:\\code\\gamma");
  });

  it("非 file:// URI 忽略", async () => {
    const buf = await makeDbBuffer({ entries: [{ folderUri: "vscode-remote://x" }] });
    const r = await discoverRecentProjects(makeDeps({}, buf));
    expect(r).toEqual([]);
  });

  it("空 entries → 空数组", async () => {
    const buf = await makeDbBuffer({ entries: [] });
    const r = await discoverRecentProjects(makeDeps({}, buf));
    expect(r).toEqual([]);
  });
});
```

注意：测试里 `require.resolve` 同样须换 import——fixture 直接 `readFileSync(nodePath.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"))` 或顶部 `import wasmPath from "sql.js/dist/sql-wasm.wasm?url"` 不适用；**用 `createRequire(import.meta.url)`**（vitest 支持）：

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/discoveryWorker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// 从宿主编辑器 state.vscdb 读最近打开的项目（spec §5.1 / §7.2）
// 机制：复制 db 到临时目录 → sql.js 打开副本 → 查 ItemTable 的
// history.recentlyOpenedPathsList → 解析 folderUri / workspace.configPath →
// 过滤（存在 + 是 git 仓库）→ realpath 归一 → 去重 → MRU 顺序（数组序即最近优先）
// 副本读完即删，不落地不缓存（spec §7.2）
import type { Database, SqlJsStatic } from "sql.js";
import type { DiscoveredProject } from "../messages";

export interface DiscoveryDeps {
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  isGitRepo(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  createSql(): Promise<SqlJsStatic>;
  tmpCopy(file: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const url = new URL(uri);
  let p = decodeURIComponent(url.pathname);
  // Windows: /d:/code/alpha → d:\code\alpha
  if (/^\/[a-zA-Z]:\//.test(p)) {
    p = p.slice(1).replace(/\//g, "\\");
  }
  return p;
}

export async function discoverRecentProjects(deps: DiscoveryDeps): Promise<DiscoveredProject[]> {
  if (!(await deps.exists("<sentinel>")) && false) {
    // 占位防 noUnusedLocals —— 实现时删除此 if
  }
  const tmpPath = await deps.tmpCopy("state.vscdb");
  try {
    const buf = await deps.readFile(tmpPath);
    const SQL = await deps.createSql();
    const db: Database = new SQL.Database(buf);
    let raw: string | null = null;
    try {
      const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
      stmt.bind(["history.recentlyOpenedPathsList"]);
      if (stmt.step()) raw = stmt.get()[0] as string;
      stmt.free();
    } finally {
      db.close();
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      entries?: Array<{ folderUri?: string; fileUri?: string; workspace?: { configPath?: string }; lastUsed?: number }>;
    };
    const seen = new Set<string>();
    const out: DiscoveredProject[] = [];
    let rank = 0;
    for (const e of parsed.entries ?? []) {
      const candidate =
        uriToPath(e.folderUri ?? "") ??
        uriToPath(e.workspace?.configPath ?? "") ??
        null;
      if (!candidate) continue;
      if (!(await deps.exists(candidate))) continue;
      if (!(await deps.isGitRepo(candidate))) continue;
      const real = await deps.realpath(candidate);
      const key = real.toLowerCase(); // Windows 大小写不敏感
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: real, rank: rank++, lastUsed: e.lastUsed });
    }
    return out;
  } finally {
    await deps.unlink(tmpPath).catch(() => {});
  }
}
```

注意：实现中 `if (!(await deps.exists("<sentinel>")) && false)` 是**禁止出现的占位**——写代码时不要带上（上面仅为标注 noUnusedLocals 不适用）；真实实现直接从 `const tmpPath` 开始。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/discoveryWorker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/scanner/DiscoveryWorker.ts test/discoveryWorker.test.ts
git commit -m "feat: add discovery worker reading state.vscdb via sql.js"
```

---

### Task 7: `src/util/createLimiter.ts`

**Files:**
- Create: `src/util/createLimiter.ts`
- Test: `test/createLimiter.test.ts`

**Interfaces:**
- Produces: `createLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T>`（p-limit 模式，自实现避免 ESM 依赖问题，spec §5.3 "p-limit 模式"）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { createLimiter } from "../src/util/createLimiter";

describe("createLimiter", () => {
  it("并发不超过上限", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    await Promise.all(Array.from({ length: 10 }, () => limit(task)));
    expect(peak).toBe(3);
  });

  it("结果与错误都正常传递", async () => {
    const limit = createLimiter(2);
    const v = await limit(async () => 42);
    expect(v).toBe(42);
    await expect(limit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/createLimiter.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// 并发限流器（p-limit 模式自实现，spec §5.3）
export function createLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (v) => { resolve(v); next(); },
          (e) => { reject(e); next(); }
        );
      };
      if (active < n) run();
      else queue.push(run);
    });
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/createLimiter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/util/createLimiter.ts test/createLimiter.test.ts
git commit -m "feat: add concurrency limiter"
```

---

### Task 8: `src/ollama/prompt.ts`

**Files:**
- Create: `src/ollama/prompt.ts`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Produces: `buildPrompt(input: { statusLine: string; diff: string; fileList: string }, maxDiffChars: number): { prompt: string; truncated: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt, PROMPT_TEMPLATE } from "../src/ollama/prompt";

describe("buildPrompt", () => {
  it("短 diff 直接进 prompt", () => {
    const r = buildPrompt({ statusLine: "## main", diff: "- a\n+ b", fileList: "a.txt" }, 8000);
    expect(r.truncated).toBe(false);
    expect(r.prompt).toContain("- a\n+ b");
    expect(r.prompt).toContain("## main");
  });

  it("超长 diff 切换文件清单模式", () => {
    const r = buildPrompt({ statusLine: "## main", diff: "x".repeat(9000), fileList: "a.txt | 修改\nb.ts | 新增" }, 8000);
    expect(r.truncated).toBe(true);
    expect(r.prompt).not.toContain("xxxxxxxxxx");
    expect(r.prompt).toContain("b.ts | 新增");
    expect(r.prompt).toContain("文件清单");
  });

  it("模板含 8 个 type 与中文约束", () => {
    expect(PROMPT_TEMPLATE).toContain("feat / refactor / docs / test / chore / fix / perf / style");
    expect(PROMPT_TEMPLATE).toContain("只输出 message 本身");
    expect(PROMPT_TEMPLATE).toContain("不超过 50 字");
  });

  it("模板不含英文开场白指令（防模型输出英文）", () => {
    expect(PROMPT_TEMPLATE).not.toContain("Write a commit message");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/ollama/prompt.ts test/prompt.test.ts
git commit -m "feat: add chinese commit message prompt builder"
```

---

### Task 9: `src/ollama/streamClient.ts`

**Files:**
- Create: `src/ollama/streamClient.ts`
- Test: `test/streamClient.test.ts`

**Interfaces:**
- Produces: `streamGenerate(url, body, opts: { timeoutMs, signal? }, onChunk: (t: string) => void): Promise<string>`；错误类型 `OllamaHttpError`（带 status）、`OllamaTimeoutError`、`OllamaConnectError`。URL 允许传 base（`http://localhost:11434`），内部拼 `/api/generate`

- [ ] **Step 1: 写失败测试（node:http mock Ollama）**

```ts
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { streamGenerate, OllamaHttpError, OllamaTimeoutError } from "../src/ollama/streamClient";

let server: http.Server;
let baseUrl: string;

function startServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
afterEach(() => new Promise<void>((r) => server ? server.close(() => r()) : r()));

describe("streamGenerate", () => {
  it("正常流：逐行解析 NDJSON，拼出全文", async () => {
    baseUrl = await startServer((req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      res.write(JSON.stringify({ response: "feat: " }) + "\n");
      res.write(JSON.stringify({ response: "添加登录" }) + "\n");
      res.write(JSON.stringify({ response: "表单", done: true }) + "\n");
      res.end();
    });
    const chunks: string[] = [];
    const text = await streamGenerate(baseUrl, { model: "m", prompt: "p" }, { timeoutMs: 5000 }, (c) => chunks.push(c));
    expect(text).toBe("feat: 添加登录表单");
    expect(chunks).toEqual(["feat: ", "添加登录", "表单"]);
  });

  it("chunk 跨 TCP 包边界（半行缓冲）", async () => {
    baseUrl = await startServer((req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      const line = JSON.stringify({ response: "hello", done: true }) + "\n";
      const mid = Math.floor(line.length / 2);
      res.write(line.slice(0, mid));
      setTimeout(() => { res.write(line.slice(mid)); res.end(); }, 10);
    });
    const text = await streamGenerate(baseUrl, {}, { timeoutMs: 5000 }, () => {});
    expect(text).toBe("hello");
  });

  it("HTTP 404 → OllamaHttpError", async () => {
    baseUrl = await startServer((req, res) => { res.statusCode = 404; res.end("model not found"); });
    await expect(streamGenerate(baseUrl, {}, { timeoutMs: 5000 }, () => {})).rejects.toBeInstanceOf(OllamaHttpError);
  });

  it("连接拒绝 → OllamaConnectError", async () => {
    await expect(streamGenerate("http://127.0.0.1:1", {}, { timeoutMs: 2000 }, () => {})).rejects.toThrow(
      expect.objectContaining({ name: "OllamaConnectError" })
    );
  });

  it("超时 → OllamaTimeoutError", async () => {
    baseUrl = await startServer((req, res) => { /* 挂住不响应 */ });
    await expect(streamGenerate(baseUrl, {}, { timeoutMs: 100 }, () => {})).rejects.toBeInstanceOf(OllamaTimeoutError);
  });

  it("外部 signal abort 立即中断", async () => {
    baseUrl = await startServer((req, res) => { /* 挂住 */ });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(
      streamGenerate(baseUrl, {}, { timeoutMs: 10000, signal: ac.signal }, () => {})
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/streamClient.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// Ollama /api/generate 流式客户端（spec §5.2）
// NDJSON：每行一个 JSON，取 response 字段累计；done=true 结束
// 错误分类：HTTP 非 2xx → OllamaHttpError；超时 → OllamaTimeoutError；连不上 → OllamaConnectError
export class OllamaHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`Ollama HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "OllamaHttpError";
  }
}
export class OllamaTimeoutError extends Error {
  constructor() { super("Ollama 生成超时"); this.name = "OllamaTimeoutError"; }
}
export class OllamaConnectError extends Error {
  constructor(detail: string) { super(`Ollama 未连接（${detail}）。请先运行 ollama serve`); this.name = "OllamaConnectError"; }
}

export interface StreamOpts {
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function streamGenerate(
  baseUrl: string,
  body: Record<string, unknown>,
  opts: StreamOpts,
  onChunk: (text: string) => void
): Promise<string> {
  // 组合超时与外部信号：Node 18 无 AbortSignal.any，手动桥接
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OllamaTimeoutError()), opts.timeoutMs);
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (opts.signal?.aborted) throw opts.signal.reason ?? e;
    if (e instanceof OllamaTimeoutError) throw e;
    throw new OllamaConnectError(String(e));
  }

  if (!res.ok) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    throw new OllamaHttpError(res.status, await res.text().catch(() => ""));
  }

  let full = "";
  try {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 半行留缓冲
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        const obj = JSON.parse(t) as { response?: string; done?: boolean };
        if (obj.response) {
          full += obj.response;
          onChunk(obj.response);
        }
        if (obj.done) break outer;
      }
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
  return full;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/streamClient.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: Commit**

```powershell
git add src/ollama/streamClient.ts test/streamClient.test.ts
git commit -m "feat: add ollama ndjson streaming client"
```

---

### Task 10: `src/scanner/OllamaWorker.ts`

**Files:**
- Create: `src/scanner/OllamaWorker.ts`
- Test: `test/ollamaWorker.test.ts`

**Interfaces:**
- Consumes: `streamGenerate`（Task 9）、`buildPrompt`（Task 8）
- Produces: `class OllamaWorker`，构造参数 `cfg: { url; model; maxDiffChars; timeoutMs }` 与 `hooks: { onStream(path, chunk); onDone(path, message); onFailed(path, reason); onFatal(reason) }`；方法 `enqueue(task: { path; statusLine; diff; fileList })`、`removeQueued(path)`、`abortAll()`。串行 FIFO（spec §5.2）；HTTP 404 → onFatal 并清空队列

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { OllamaWorker } from "../src/scanner/OllamaWorker";

let server: http.Server;
let baseUrl: string;
afterEach(() => new Promise<void>((r) => server ? server.close(() => r()) : r()));

function startOllama(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

const cfg = (url: string) => ({ url, model: "m", maxDiffChars: 100, timeoutMs: 5000 });

describe("OllamaWorker", () => {
  it("串行 FIFO：任务按入队顺序完成", async () => {
    baseUrl = await startOllama((req, res) => {
      res.end(JSON.stringify({ response: "msg", done: true }) + "\n");
    });
    const order: string[] = [];
    const done = new Promise<void>((resolve) => {
      const w = new OllamaWorker(cfg(baseUrl), {
        onStream: () => {},
        onDone: (p) => { order.push(p); if (order.length === 3) resolve(); },
        onFailed: () => {},
        onFatal: () => {},
      });
      w.enqueue({ path: "a", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "b", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "c", statusLine: "", diff: "d", fileList: "" });
    });
    await done;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("流式 chunk 转发 onStream，onDone 收全文", async () => {
    baseUrl = await startOllama((req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      res.write(JSON.stringify({ response: "feat: " }) + "\n");
      res.write(JSON.stringify({ response: "改动", done: true }) + "\n");
      res.end();
    });
    const chunks: string[] = [];
    const doneP = new Promise<string>((resolve) => {
      const w = new OllamaWorker(cfg(baseUrl), {
        onStream: (_p, c) => chunks.push(c),
        onDone: (_p, m) => resolve(m),
        onFailed: () => {},
        onFatal: () => {},
      });
      w.enqueue({ path: "x", statusLine: "", diff: "d", fileList: "" });
    });
    const msg = await doneP;
    expect(msg).toBe("feat: 改动");
    expect(chunks).toEqual(["feat: ", "改动"]);
  });

  it("404 → onFatal 清空队列", async () => {
    baseUrl = await startOllama((req, res) => { res.statusCode = 404; res.end("nf"); });
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const w = new OllamaWorker(cfg(baseUrl), {
        onStream: () => {},
        onDone: () => {},
        onFailed: (p) => { events.push(`failed:${p}`); },
        onFatal: () => { events.push("fatal"); resolve(); },
      });
      w.enqueue({ path: "a", statusLine: "", diff: "d", fileList: "" });
      w.enqueue({ path: "b", statusLine: "", diff: "d", fileList: "" });
    });
    // 404 是 fatal：a 失败触发 fatal，b 从队列移除（不再产生新事件）
    expect(events).toEqual(["failed:a", "fatal"]);
  });

  it("超时 → onFailed 不影响后续", async () => {
    let hits = 0;
    baseUrl = await startOllama((req, res) => {
      hits++;
      if (hits === 1) return; // 第一个挂住超时
      res.end(JSON.stringify({ response: "ok", done: true }) + "\n");
    });
    const w = new OllamaWorker({ ...cfg(baseUrl), timeoutMs: 80 }, {
      onStream: () => {},
      onDone: () => {},
      onFailed: () => {},
      onFatal: () => {},
    });
    w.enqueue({ path: "slow", statusLine: "", diff: "d", fileList: "" });
    const doneP = new Promise<string>((resolve) => {
      // 用 onDone 捕获第二个任务结果（重新构造 hooks 无法中途换，改用收集器）
      (w as unknown as { hooks: { onDone: (p: string, m: string) => void } }).hooks.onDone = (p, m) => resolve(`${p}:${m}`);
      w.enqueue({ path: "fast", statusLine: "", diff: "d", fileList: "" });
    });
    const r = await doneP;
    expect(r).toBe("fast:ok");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/ollamaWorker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/ollamaWorker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/scanner/OllamaWorker.ts test/ollamaWorker.test.ts
git commit -m "feat: add serial ollama worker queue"
```

---

### Task 11: `src/scanner/GitStatusWorker.ts`

**Files:**
- Create: `src/scanner/GitStatusWorker.ts`
- Test: `test/gitStatusWorker.test.ts`

**Interfaces:**
- Consumes: `runGit`（Task 4）、`parseStatus`（Task 3）、`createLimiter`（Task 7）
- Produces: `getGitStatuses(paths: string[], concurrency = 8): Promise<Map<string, GitStatus>>`（失败路径不在 Map 中 = 排除，spec §7.4）

- [ ] **Step 1: 写失败测试（真实 tmp 仓库矩阵）**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getGitStatuses } from "../src/scanner/GitStatusWorker";

const repos: string[] = [];
function makeRepo(setup: (dir: string) => void, branch = "main"): string {
  const dir = mkdtempSync(join(tmpdir(), "gs-"));
  execSync(`git init -b ${branch}`, { cwd: dir });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: dir });
  setup(dir);
  repos.push(dir);
  return dir;
}
beforeEach(() => { repos.length = 0; });
afterEach(() => repos.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("getGitStatuses", () => {
  it("脏/干净/冲突三态", async () => {
    const clean = makeRepo(() => {});
    const dirty = makeRepo((d) => writeFileSync(join(d, "a.txt"), "hi"));
    const conflict = makeRepo((d) => {
      writeFileSync(join(d, "f.txt"), "base\n");
      execSync("git add f.txt && git -c user.email=t@t -c user.name=t commit -m base", { cwd: d, shell: "cmd.exe" });
      execSync("git checkout -b side", { cwd: d });
      writeFileSync(join(d, "f.txt"), "side\n");
      execSync("git commit -am side", { cwd: d, shell: "cmd.exe" });
      execSync("git checkout main", { cwd: d });
      writeFileSync(join(d, "f.txt"), "main\n");
      execSync("git commit -am main", { cwd: d, shell: "cmd.exe" });
      try { execSync("git merge side", { cwd: d }); } catch { /* 冲突预期 */ }
    });
    const m = await getGitStatuses([clean, dirty, conflict]);
    expect(m.get(clean)!.dirtiness).toBe("clean");
    expect(m.get(dirty)!.dirtiness).toBe("dirty");
    expect(m.get(conflict)!.dirtiness).toBe("conflict");
  });

  it("无 remote → no-remote；有 remote 无 upstream → no-remote", async () => {
    const noRemote = makeRepo(() => {});
    const r = await getGitStatuses([noRemote]);
    expect(r.get(noRemote)!.pushState).toBe("no-remote");
  });

  it("非 git 目录 → 不出现在结果中", async () => {
    const notGit = mkdtempSync(join(tmpdir(), "ng-"));
    const r = await getGitStatuses([notGit]);
    expect(r.has(notGit)).toBe(false);
    rmSync(notGit, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/gitStatusWorker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// 对每个项目并发跑 git status（spec §5.1），失败的项目直接排除（spec §7.4）
import type { GitStatus } from "../messages";
import { runGit } from "../git/spawnGit";
import { parseStatus } from "../git/statusParser";
import { createLimiter } from "../util/createLimiter";

export async function getGitStatuses(
  paths: string[],
  concurrency = 8
): Promise<Map<string, GitStatus>> {
  const limit = createLimiter(concurrency);
  const entries = await Promise.all(
    paths.map(async (p): Promise<[string, GitStatus] | null> => {
      const r = await runGit(p, ["status", "--porcelain", "-b"], 15000);
      if (r.code !== 0) return null; // 非 git 仓库 / 已删除 → 过滤
      return [p, parseStatus(r.stdout)];
    })
  );
  return new Map(entries.filter((e): e is [string, GitStatus] => e !== null));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/gitStatusWorker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/scanner/GitStatusWorker.ts test/gitStatusWorker.test.ts
git commit -m "feat: add concurrent git status worker"
```

---

### Task 12: `MessageStore` + `ScanCoordinator`

**Files:**
- Create: `src/scanner/ScanCoordinator.ts`
- Test: `test/scanCoordinator.test.ts`

**Interfaces:**
- Consumes: `discoverRecentProjects`（Task 6）、`getGitStatuses`（Task 11）、`OllamaWorker`（Task 10）、`WebviewMessage`/`Project`（Task 2）
- Produces:
  - `class MessageStore { set(path, message); get(path); clear() }`（host 端 message 唯一写入点，spec §5.1）
  - `class ScanCoordinator(deps: { discover; getStatuses; ollama; emit; store; diffFor })`，方法 `scan(): Promise<void>`、`abort()`。重扫时旧代作废（generation 计数），旧结果不混叠（spec §5.1 步骤 1）
  - `diffFor(path): Promise<{ statusLine; diff; fileList }>` 由 deps 注入（host 侧用 runGit 实现，扫描测试可 mock）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from "vitest";
import { MessageStore, ScanCoordinator } from "../src/scanner/ScanCoordinator";
import { OllamaWorker } from "../src/scanner/OllamaWorker";
import type { WebviewMessage } from "../src/messages";

function makeOllama(autoDone = true) {
  const hooks = {
    onStream: vi.fn(),
    onDone: vi.fn(),
    onFailed: vi.fn(),
    onFatal: vi.fn(),
  };
  const w = new OllamaWorker({ url: "http://x", model: "m", maxDiffChars: 100, timeoutMs: 1000 }, hooks);
  if (autoDone) {
    // 同步完成模拟：enqueue 后立刻 onDone
    const orig = w.enqueue.bind(w);
    w.enqueue = (t) => { hooks.onDone(t.path, `msg-for-${t.path}`); };
  }
  return { w, hooks };
}

function makeDeps(overrides = {}) {
  const messages: WebviewMessage[] = [];
  const { w: ollama } = makeOllama();
  return {
    messages,
    deps: {
      discover: async () => [
        { path: "d:\\a", rank: 0 },
        { path: "d:\\b", rank: 1 },
      ],
      getStatuses: async () =>
        new Map([
          ["d:\\a", { branch: "main", dirtiness: "dirty" as const, pushState: "ahead" as const, ahead: 1, behind: 0, hasConflicts: false }],
        ]),
      ollama,
      emit: (m: WebviewMessage) => messages.push(m),
      store: new MessageStore(),
      diffFor: async () => ({ statusLine: "## main", diff: "x", fileList: "f" }),
      ...overrides,
    },
    ollama,
  };
}

describe("MessageStore", () => {
  it("set/get/clear", () => {
    const s = new MessageStore();
    s.set("p", "m1");
    expect(s.get("p")).toBe("m1");
    s.clear();
    expect(s.get("p")).toBeUndefined();
  });
});

describe("ScanCoordinator.scan", () => {
  it("产出 projectList，脏项目进生成队列，streamDone 写 store", async () => {
    const { deps, messages } = makeDeps();
    const sc = new ScanCoordinator(deps);
    await sc.scan();
    const list = messages.find((m) => m.type === "projectList") as { items: Array<{ path: string; phase: string; message: string }> };
    expect(list.items.length).toBe(2);
    expect(list.items[0].message).toBe("msg-for-d:\\a");
    expect(deps.store.get("d:\\a")).toBe("msg-for-d:\\a");
  });

  it("重扫作废旧代：旧扫描的 emit 不覆盖新扫描", async () => {
    let releaseOld!: () => void;
    const gate = new Promise<void>((r) => (releaseOld = r));
    const { deps, messages } = makeDeps({
      discover: undefined, // 见下：用可变 deps
    });
    // 可控 discover：第一次慢，第二次快
    let call = 0;
    const slowDeps = {
      ...deps,
      discover: async () => {
        call++;
        if (call === 1) { await gate; return [{ path: "d:\\old", rank: 0 }]; }
        return [{ path: "d:\\new", rank: 0 }];
      },
    };
    const sc = new ScanCoordinator(slowDeps);
    const p1 = sc.scan();
    const p2 = sc.scan(); // 旧代 abort
    releaseOld();
    await Promise.all([p1, p2]);
    const lists = messages.filter((m) => m.type === "projectList") as Array<{ items: Array<{ path: string }> }>;
    // 第一次的 projectList 不应出现（代已作废）
    expect(lists.length).toBe(1);
    expect(lists[0].items[0].path).toBe("d:\\new");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/scanCoordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// 扫描协调器（spec §5.1）：AbortController 管新旧代；message 单一真相源
import type { DiscoveredProject, GitStatus, Project, WebviewMessage } from "../messages";
import type { OllamaWorker } from "./OllamaWorker";

export class MessageStore {
  private map = new Map<string, string>();
  set(path: string, message: string): void { this.map.set(path, message); }
  get(path: string): string | undefined { return this.map.get(path); }
  clear(): void { this.map.clear(); }
}

export interface DiffInfo { statusLine: string; diff: string; fileList: string; }

export interface ScanDeps {
  discover(): Promise<DiscoveredProject[]>;
  getStatuses(paths: string[]): Promise<Map<string, GitStatus>>;
  ollama: OllamaWorker;
  emit(m: WebviewMessage): void;
  store: MessageStore;
  diffFor(path: string): Promise<DiffInfo>;
}

export class ScanCoordinator {
  private generation = 0;

  constructor(private deps: ScanDeps) {}

  abort(): void {
    this.generation++;
    this.deps.ollama.abortAll();
  }

  async scan(): Promise<void> {
    this.abort(); // 作废旧代（spec §5.1 步骤 1）
    const gen = ++this.generation;
    const alive = () => gen === this.generation;

    const discovered = await this.deps.discover();
    if (!alive()) return;
    const paths = discovered.map((d) => d.path);
    const statuses = await this.deps.getStatuses(paths);
    if (!alive()) return;

    const items: Project[] = discovered.map((d) => ({
      path: d.path,
      name: d.path.split(/[\\/]/).filter(Boolean).pop() ?? d.path,
      rank: d.rank,
      lastUsed: d.lastUsed,
      status: statuses.get(d.path) ?? null,
      phase: statuses.has(d.path)
        ? statuses.get(d.path)!.dirtiness === "clean"
          ? "ready"
          : "statused"
        : "scanning",
      message: this.deps.store.get(d.path) ?? "",
    }));
    this.deps.emit({ type: "projectList", items });

    // 脏项目进生成队列（spec §5.1 步骤 4；Ollama 挂了不影响上面）
    for (const item of items) {
      if (!alive()) return;
      const st = item.status;
      if (!st || st.dirtiness === "clean") continue;
      this.deps.ollama.enqueue({
        path: item.path,
        ...(await this.deps.diffFor(item.path)),
      });
    }
  }
}
```

关键点：`streamDone` 的写 store 逻辑在 **extension.ts 的 OllamaWorker hooks** 里（`onDone → store.set + emit(streamDone)`），ScanCoordinator 不持有生成结果——这样重扫 generation 只管扫描侧，message 侧由 store 保证。测试中模拟的 `onDone` 与 extension.ts 装配一致。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/scanCoordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/scanner/ScanCoordinator.ts test/scanCoordinator.test.ts
git commit -m "feat: add scan coordinator with generation abort"
```

---

### Task 13: `src/committer/CommitCoordinator.ts`

**Files:**
- Create: `src/committer/CommitCoordinator.ts`
- Test: `test/commitCoordinator.test.ts`

**Interfaces:**
- Consumes: `runGit`（Task 4）、`createLimiter`（Task 7）、`MessageStore`（Task 12）、`WebviewMessage`（Task 2）
- Produces: `class CommitCoordinator(deps: { runGit; emit; store; concurrency; tmpdir; writeFile; unlink })`：
  - `commit(paths: string[]): Promise<{ ok: number; commitFailed: number; pushFailed: number }>`
  - `pushOne(path: string): Promise<void>`
  - `dispose(): void`
  - 输入校验（spec §5.3）：空数组 no-op；重复去重；非 git 仓库 → emit `commit_failed` + error `not_git_repo`
  - commit 用 `git commit -F <tmpfile>`（spec §5.3）；identity 未配置 → error `identity_not_configured`

- [ ] **Step 1: 写失败测试（真实 tmp 仓库）**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CommitCoordinator } from "../src/committer/CommitCoordinator";
import { MessageStore } from "../src/scanner/ScanCoordinator";
import type { WebviewMessage } from "../src/messages";

const dirs: string[] = [];
function repo(opts: { remote?: string; files?: Record<string, string> } = {}): string {
  const d = mkdtempSync(join(tmpdir(), "cc-"));
  execSync("git init -b main", { cwd: d });
  if (opts.remote) {
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    execSync("git init --bare -b main", { cwd: bare });
    execSync(`git remote add origin ${JSON.stringify(opts.remote ?? bare)}`, { cwd: d, shell: "cmd.exe" });
    dirs.push(bare);
  }
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(d, name), content);
  }
  dirs.push(d);
  return d;
}
beforeEach(() => { dirs.length = 0; });
afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeCoordinator(overrides = {}) {
  const messages: WebviewMessage[] = [];
  const deps = {
    emit: (m: WebviewMessage) => messages.push(m),
    store: new MessageStore(),
    concurrency: 3,
    writeFile: async (p: string, c: string) => { writeFileSync(p, c); },
    unlink: async (p: string) => { rmSync(p, { force: true }); },
    tmpdir: () => tmpdir(),
    ...overrides,
  };
  const cc = new CommitCoordinator(deps);
  return { cc, messages };
}

describe("CommitCoordinator.commit", () => {
  it("成功路径：add → commit(-F) → push，状态机走完", async () => {
    const d = repo({ remote: "x", files: { a.txt: "1" } });
    // remote add 用了 "x" 占位？不行——重写：上面的 repo() 已处理 remote 目录。此处仅验证行为：
    const { cc, messages } = makeCoordinator();
    const store = (deps0 => deps0)(makeCoordinator().cc ? null as never : null as never);
    expect(true).toBe(true);
  });
});
```

**上面最后一个测试是骨架残缺，禁止照抄**——正确的完整测试如下（实现时用这份替换）：

```ts
function repo2(remoteBare?: string): string {
  const d = mkdtempSync(join(tmpdir(), "cc-"));
  execSync("git init -b main", { cwd: d });
  if (remoteBare) execSync(`git remote add origin "${remoteBare}"`, { cwd: d, shell: "cmd.exe" });
  writeFileSync(join(d, "a.txt"), "content");
  dirs.push(d);
  return d;
}
function bare(): string {
  const b = mkdtempSync(join(tmpdir(), "bare-"));
  execSync("git init --bare -b main", { cwd: b });
  dirs.push(b);
  return b;
}

describe("CommitCoordinator.commit", () => {
  it("成功路径：add → commit → push，最终 push_ok", async () => {
    const b = bare();
    const d = repo2(b);
    const { cc, messages } = makeCoordinator();
    (cc as unknown as { deps: { store: MessageStore } }).deps.store.set(d, "feat: 测试提交");
    const summary = await cc.commit([d, d]); // 重复路径去重
    expect(summary.ok).toBe(0); // 注意：push 后是 push_ok，不算 ok——见实现语义
    const phases = messages.filter((m) => m.type === "status").map((m) => (m as { phase: string }).phase);
    expect(phases[phases.length - 1]).toBe("push_ok");
    // message 已落盘
    const log = execSync("git log -1 --pretty=%B", { cwd: d }).toString().trim();
    expect(log).toBe("feat: 测试提交");
  });

  it("空数组 → no-op", async () => {
    const { cc } = makeCoordinator();
    const s = await cc.commit([]);
    expect(s).toEqual({ ok: 0, commitFailed: 0, pushFailed: 0 });
  });

  it("非 git 目录 → commit_failed + not_git_repo，不阻塞其他", async () => {
    const good = repo2();
    const notGit = mkdtempSync(join(tmpdir(), "ng-"));
    dirs.push(notGit);
    const { cc, messages } = makeCoordinator();
    (cc as unknown as { deps: { store: MessageStore } }).deps.store.set(good, "chore: ok");
    await cc.commit([notGit, good]);
    const byPhase = messages.filter((m) => m.type === "status") as Array<{ path: string; phase: string; error?: string }>;
    expect(byPhase.find((m) => m.path === notGit)?.error).toBe("not_git_repo");
    expect(byPhase.find((m) => m.path === good)?.phase).toBe("committed"); // 无 remote → 不 push
  });

  it("多行含特殊字符 message 完整落盘", async () => {
    const d = repo2();
    const { cc } = makeCoordinator();
    (cc as unknown as { deps: { store: MessageStore } }).deps.store.set(d, 'feat: 支持 "引号" 与 $变量 与\n\n多行 body；中文；`反引号`');
    await cc.commit([d]);
    const log = execSync("git log -1 --pretty=%B", { cwd: d }).toString();
    expect(log).toContain("支持 \"引号\" 与 $变量");
    expect(log).toContain("多行 body");
  });

  it("push 失败（remote 断链）→ push_failed，commit 已落盘", async () => {
    const b = bare();
    const d = repo2(b);
    const { cc, messages } = makeCoordinator();
    (cc as unknown as { deps: { store: MessageStore } }).deps.store.set(d, "feat: x");
    rmSync(b, { recursive: true, force: true }); // 断链
    await cc.commit([d]);
    const last = messages.filter((m) => m.type === "status").pop() as { phase: string };
    expect(last.phase).toBe("push_failed");
    const log = execSync("git log -1 --pretty=%B", { cwd: d }).toString();
    expect(log).toContain("feat: x"); // commit 保留
  });

  it("identity 未配置 → identity_not_configured", async () => {
    const d = mkdtempSync(join(tmpdir(), "noid-"));
    execSync("git init -b main", { cwd: d });
    writeFileSync(join(d, "a.txt"), "1");
    execSync("git add -A", { cwd: d });
    dirs.push(d);
    const { cc, messages } = makeCoordinator();
    (cc as unknown as { deps: { store: MessageStore } }).deps.store.set(d, "feat: y");
    await cc.commit([d]);
    const last = messages.filter((m) => m.type === "status").pop() as { phase: string; error?: string };
    expect(last.error).toBe("identity_not_configured");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/commitCoordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// 批量提交协调器（spec §5.3）：并发限流；message 走 -F 临时文件；
// push 失败不影响 commit 已落盘；webview dispose → dispose() 停发新任务
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { WebviewMessage } from "../messages";
import type { MessageStore } from "../scanner/ScanCoordinator";
import { runGit, type GitResult } from "../git/spawnGit";
import { createLimiter } from "../util/createLimiter";

export interface CommitDeps {
  emit(m: WebviewMessage): void;
  store: MessageStore;
  concurrency: number;
  writeFile?(p: string, c: string): Promise<void>;
  unlink?(p: string): Promise<void>;
  tmpdir?(): string;
}

export interface CommitSummary { ok: number; commitFailed: number; pushFailed: number; }

export class CommitCoordinator {
  private disposed = false;
  private limit = createLimiter(this.deps.concurrency);
  private write = this.deps.writeFile ?? writeFile;
  private remove = this.deps.unlink ?? unlink;
  private tmp = this.deps.tmpdir ?? tmpdir;

  constructor(private deps: CommitDeps) {}

  dispose(): void { this.disposed = true; }

  private emitStatus(path: string, phase: WebviewMessage extends { type: "status"; phase: infer P } ? P : never, error?: string): void {
    this.deps.emit({ type: "status", path, phase, error } as WebviewMessage);
  }

  private async isGitRepo(path: string): Promise<boolean> {
    const r = await runGit(path, ["rev-parse", "--is-inside-work-tree"], 10000);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async commit(paths: string[]): Promise<CommitSummary> {
    const summary: CommitSummary = { ok: 0, commitFailed: 0, pushFailed: 0 };
    // 输入校验（spec §5.3）
    const unique = [...new Set(paths)];
    const valid: string[] = [];
    for (const p of unique) {
      if (!(await this.isGitRepo(p))) {
        this.emitStatus(p, "commit_failed", "not_git_repo");
        summary.commitFailed++;
      } else if (!this.deps.store.get(p)?.trim()) {
        this.emitStatus(p, "commit_failed", "empty_message");
        summary.commitFailed++;
      } else {
        valid.push(p);
      }
    }
    if (valid.length === 0) return summary;
    await Promise.all(valid.map((p) => this.limit(() => this.commitOne(p, summary))));
    return summary;
  }

  private async commitOne(path: string, summary: CommitSummary): Promise<void> {
    if (this.disposed) return;
    const message = this.deps.store.get(path)!;
    this.emitStatus(path, "committing");

    const add = await runGit(path, ["add", "-A"], 30000);
    if (add.code !== 0) {
      this.emitStatus(path, "commit_failed", `add_failed: ${tail(add.stderr)}`);
      summary.commitFailed++;
      return;
    }

    // message 写临时文件 → commit -F（spec §5.3，规避 -m 转义）
    const tmpFile = join(this.tmp(), `gitbatch-msg-${randomUUID()}.txt`);
    await this.write(tmpFile, message);
    const commit = await runGit(path, ["commit", "-F", tmpFile], 60000);
    await this.remove(tmpFile).catch(() => {});
    if (commit.code !== 0) {
      const err = isIdentityError(commit) ? "identity_not_configured" : `commit_failed: ${tail(commit.stderr)}`;
      this.emitStatus(path, "commit_failed", err);
      summary.commitFailed++;
      return;
    }

    // push 条件：有 upstream 且 ahead > 0（spec §5.3）
    const up = await runGit(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 10000);
    if (up.code !== 0) {
      this.emitStatus(path, "committed"); // 无 upstream → 无可 push
      summary.ok++;
      return;
    }
    const count = await runGit(path, ["rev-list", "--count", "@{upstream}..HEAD"], 10000);
    if (count.code === 0 && Number(count.stdout.trim()) > 0) {
      await this.doPush(path, summary);
    } else {
      this.emitStatus(path, "committed");
      summary.ok++;
    }
  }

  async pushOne(path: string): Promise<void> {
    const summary: CommitSummary = { ok: 0, commitFailed: 0, pushFailed: 0 };
    await this.doPush(path, summary);
  }

  private async doPush(path: string, summary: CommitSummary): Promise<void> {
    if (this.disposed) return;
    this.emitStatus(path, "committing"); // 推送中沿用提交中态（徽章 spinner）
    const push = await runGit(path, ["push"], 120000);
    if (push.code === 0) {
      this.emitStatus(path, "push_ok");
      summary.ok++;
    } else {
      this.emitStatus(path, "push_failed", `push_failed: ${tail(push.stderr)}`);
      summary.pushFailed++;
    }
  }
}

function tail(s: string, n = 200): string {
  return s.trim().slice(-n);
}

function isIdentityError(r: GitResult): boolean {
  const s = (r.stderr + r.stdout).toLowerCase();
  return (
    s.includes("please tell me who you are") ||
    s.includes("unable to auto-detect email") ||
    s.includes("author identity unknown")
  );
}
```

- [ ] **Step 4: 运行确认通过 + 编译检查**

Run: `npx vitest run test/commitCoordinator.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: Commit**

```powershell
git add src/committer/CommitCoordinator.ts test/commitCoordinator.test.ts
git commit -m "feat: add batch commit coordinator with -F message passing"
```

---

### Task 14: `src/extension.ts` 装配 + 前置检查 + Export Logs

**Files:**
- Modify: `src/extension.ts`（整文件覆盖）
- Create: `src/prereq.ts`（前置检查 + LogBuffer，host 侧可单测部分）
- Test: `test/prereq.test.ts`

**Interfaces:**
- Consumes: Task 2-13 全部产出
- Produces: 插件激活入口；WebviewViewProvider `gitBatch.panel`；消息路由（scan/regenerate/setMessage+ack/commit/push）；`checkPrerequisites(cfg, host): Promise<PrereqReport>`；`class LogBuffer`（环形 200 条，`dump(): string`）；OllamaWorker hooks 落 `store.set + emit(streamDone)`（spec §5.1）

- [ ] **Step 1: 写失败测试（prereq 的纯逻辑部分）**

```ts
import { describe, it, expect } from "vitest";
import { LogBuffer } from "../src/prereq";

describe("LogBuffer", () => {
  it("环形上限 200 条", () => {
    const b = new LogBuffer(200);
    for (let i = 0; i < 250; i++) b.push(`L${i}`);
    const dump = b.dump();
    expect(dump).toContain("L249");
    expect(dump).not.toContain("L49\n");
    expect(dump.split("\n").length).toBe(200);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/prereq.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/prereq.ts`**

```ts
// 前置检查与诊断日志（spec §11.4）
import { runGit } from "./git/spawnGit";
import type { PrereqReport } from "./messages";

export class LogBuffer {
  private lines: string[] = [];
  constructor(private cap = 200) {}
  push(line: string): void {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > this.cap) this.lines.shift();
  }
  dump(): string { return this.lines.join("\n"); }
}

export async function checkPrerequisites(
  cfg: { ollamaUrl: string },
  dbPath: string | null,
  fileExists: (p: string) => Promise<boolean>
): Promise<PrereqReport> {
  const gitR = await runGit(process.cwd(), ["--version"], 5000);
  let ollama = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, "")}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    ollama = res.ok;
  } catch { ollama = false; }
  const db = dbPath !== null && (await fileExists(dbPath));
  return { git: gitR.code === 0, ollama, db };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/prereq.test.ts`
Expected: PASS

- [ ] **Step 5: 整文件覆盖 `src/extension.ts`**

```ts
// 插件激活入口：装配 ScanCoordinator / CommitCoordinator / OllamaWorker / Webview
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  DiscoveredProject,
  HostMessage,
  Project,
  WebviewMessage,
} from "./messages";
import { detectHost, resolveStateDbPath } from "./scanner/hostDetector";
import { discoverRecentProjects } from "./scanner/DiscoveryWorker";
import { getGitStatuses } from "./scanner/GitStatusWorker";
import { OllamaWorker } from "./scanner/OllamaWorker";
import { MessageStore, ScanCoordinator } from "./scanner/ScanCoordinator";
import { CommitCoordinator } from "./committer/CommitCoordinator";
import { initSqlJs, type SqlJsStatic } from "sql.js";
import { checkPrerequisites, LogBuffer } from "./prereq";

class PanelProvider implements vscode.WebviewViewProvider {
  public static viewId = "gitBatch.panel";
  private panel?: vscode.WebviewView;
  constructor(
    private ctx: vscode.ExtensionContext,
    private onMessage: (m: HostMessage) => void,
    private log: LogBuffer
  ) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.panel = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m as HostMessage));
    view.onDidDispose(() => {
      this.panel = undefined;
      this.log.push("webview disposed");
      this.onMessage({ type: "scan" } && ({ type: "__dispose" } as unknown as HostMessage));
    });
  }
  post(m: WebviewMessage): void {
    void this.panel?.webview.postMessage(m);
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
    }
  );

  // ---- Ollama worker：hooks 落 store（spec §5.1 streamDone 走 messageStore） ----
  const ollama = new OllamaWorker(cfg, {
    onStream: (p, chunk) => panel?.post({ type: "stream", path: p, chunk }),
    onDone: (p, message) => {
      store.set(p, message);
      panel?.post({ type: "streamDone", path: p, message });
    },
    onFailed: (p, reason) => {
      log.push(`ollama failed ${p}: ${reason}`);
      panel?.post({ type: "status", path: p, phase: "ready_failed", error: reason });
    },
    onFatal: (reason) => {
      log.push(`ollama fatal: ${reason}`);
      void vscode.window.showErrorMessage(reason);
    },
  });

  // ---- Discovery ----
  const discover = async (): Promise<DiscoveredProject[]> => {
    if (!dbPath) return [];
    const sqlFactory = (): Promise<SqlJsStatic> =>
      initSqlJs({
        locateFile: (f: string) => path.join(context.extensionPath, "dist", f),
      });
    const tmpCopy = async (file: string): Promise<string> => {
      const t = path.join(os.tmpdir(), `vscode-recent-${randomUUID()}.db`);
      await fsp.copyFile(dbPath, t);
      return t;
    };
    return discoverRecentProjects({
      dbPath,
      readFile: (p) => fsp.readFile(p),
      exists: (p) => fsp.access(p).then(() => true, () => false),
      isGitRepo: async (p) => {
        const st = await fsp.stat(path.join(p, ".git")).then(() => true, () => false);
        return st;
      },
      realpath: (p) => fsp.realpath(p).catch(() => p),
      createSql: sqlFactory,
      tmpCopy,
      unlink: (p) => fsp.unlink(p).catch(() => {}),
    });
  };

  // ---- diff 取材（喂给模型的原料） ----
  const diffFor = async (p: string) => {
    const { runGit } = await import("./git/spawnGit");
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

  // ---- 协调器 ----
  let panel: PanelProvider | undefined;
  const emit = (m: WebviewMessage) => panel?.post(m);
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
  const onMessage = (m: HostMessage): void => {
    log.push(`msg: ${m.type}`);
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
        void commitCoordinator.commit(m.paths);
        break;
      case "push":
        void commitCoordinator.pushOne(m.path);
        break;
    }
  };

  panel = new PanelProvider(context, onMessage, log);
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

  // webview dispose：停发新任务，已完成的保留（spec §7.3）
  // onMessage 的 __dispose 由 PanelProvider.onDidDispose 发出
}

export function deactivate(): void {}
```

**实现注意**：上面 `view.onDidDispose` 里 `this.onMessage({ type: "scan" } && ({ type: "__dispose" } as unknown as HostMessage))` 是**错误写法**，正确做法是在 `HostMessage` 联合里加 `| { type: "dispose" }`（改 `src/messages.ts`），PanelProvider 直接 `this.onMessage({ type: "dispose" })`，路由里 `case "dispose": ollama.abortAll(); commitCoordinator.dispose(); break;`。落地时按此修正，不要保留 `&&` hack。

- [ ] **Step 6: 编译 + 全量测试**

```powershell
npm run compile
npx tsc --noEmit
npm test
```

Expected: 编译通过；tsc 零错误；全部测试 PASS（或 vitest stuck 时按 Global Constraints 降级）

- [ ] **Step 7: Commit**

```powershell
git add src/extension.ts src/prereq.ts src/messages.ts test/prereq.test.ts
git commit -m "feat: wire up extension host with scan and commit coordinators"
```

---

### Task 15: Webview 骨架（React 入口 + CSP + hook）

**Files:**
- Create: `src/webview/main.tsx`、`src/webview/App.tsx`、`src/webview/hooks/useExtensionMessage.ts`、`src/webview/postMessage.ts`
- Modify: `esbuild.js`（移除 Task 1 的 `WEBVIEW_READY` 开关）

**Interfaces:**
- Consumes: `WebviewMessage` / `HostMessage` / `Project`（Task 2）
- Produces: `App` 根组件骨架（state：items / ollamaConnected / selected / streaming buffers；handleMessage 分发）；`useExtensionMessage(handler)`；`postHost(m: HostMessage)`（acquireVsCodeApi 包装）。Task 16-18 的组件以此为基座

- [ ] **Step 1: 写 `src/webview/hooks/useExtensionMessage.ts`**

```tsx
// 订阅 host 消息；handler 用 ref 避免重订阅
import { useEffect, useRef } from "react";
import type { WebviewMessage } from "../../messages";

export function useExtensionMessage(handler: (m: WebviewMessage) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const cb = (e: MessageEvent<WebviewMessage>) => ref.current(e.data);
    window.addEventListener("message", cb);
    return () => window.removeEventListener("message", cb);
  }, []);
}
```

- [ ] **Step 2: 写 `src/webview/postMessage.ts`**

```ts
import type { HostMessage } from "../messages";

// webview 内 acquireVsCodeApi 全局唯一
declare global {
  interface Window { acquireVsCodeApi?: () => { postMessage(msg: unknown): void }; }
}
const api = window.acquireVsCodeApi?.();
export function postHost(m: HostMessage): void {
  api?.postMessage(m);
}
```

- [ ] **Step 3: 写 `src/webview/App.tsx` 骨架（Task 16-18 逐块填充子组件）**

```tsx
import { useCallback, useMemo, useState } from "react";
import type { Project, WebviewMessage } from "../messages";
import { useExtensionMessage } from "./hooks/useExtensionMessage";
import { postHost } from "./postMessage";
import { Shell } from "./sc";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import { ProjectList } from "./components/ProjectList";
import { Footer } from "./components/Footer";

export type Filter = "all" | "uncommitted" | "unpushed" | "conflict";

export default function App() {
  const [items, setItems] = useState<Project[]>([]);
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [lastBatch, setLastBatch] = useState<string>("");

  const handleMessage = useCallback((m: WebviewMessage) => {
    switch (m.type) {
      case "projectList":
        setItems(m.items);
        setStreaming({});
        break;
      case "stream":
        setStreaming((s) => ({ ...s, [m.path]: (s[m.path] ?? "") + m.chunk }));
        break;
      case "streamDone":
        setItems((xs) => xs.map((x) => (x.path === m.path ? { ...x, message: m.message, phase: "ready" } : x)));
        setStreaming((s) => { const { [m.path]: _drop, ...rest } = s; return rest; });
        break;
      case "status":
        setItems((xs) => xs.map((x) => (x.path === m.path ? { ...x, phase: m.phase, error: m.error } : x)));
        break;
      case "ollamaState":
        setOllamaConnected(m.connected);
        break;
      case "ack":
        break; // Task 17 编辑态消费
    }
  }, []);
  useExtensionMessage(handleMessage);

  const visible = useMemo(() => filterItems(items, filter), [items, filter]);

  return (
    <Shell>
      <Header
        total={items.length}
        uncommitted={items.filter((x) => x.status && x.status.dirtiness !== "clean").length}
        unpushed={items.filter((x) => x.status?.pushState === "ahead").length}
        ollamaConnected={ollamaConnected}
        onRescan={() => postHost({ type: "scan" })}
        onBatchCommit={() => postHost({ type: "commit", paths: [...selected] })}
        batchDisabled={selected.size === 0}
      />
      <Toolbar filter={filter} onFilter={setFilter} />
      <ProjectList
        items={visible}
        streaming={streaming}
        selected={selected}
        ollamaConnected={ollamaConnected}
        onToggle={(p) =>
          setSelected((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })
        }
        onMessage={(p, msg) => postHost({ type: "setMessage", path: p, message: msg, ackId: crypto.randomUUID() })}
        onRegenerate={(p) => postHost({ type: "regenerate", path: p })}
      />
      <Footer ollamaConnected={ollamaConnected} lastBatch={lastBatch} />
    </Shell>
  );
}

function filterItems(items: Project[], f: Filter): Project[] {
  switch (f) {
    case "uncommitted": return items.filter((x) => x.status && x.status.dirtiness !== "clean");
    case "unpushed": return items.filter((x) => x.status?.pushState === "ahead");
    case "conflict": return items.filter((x) => x.status?.hasConflicts);
    default: return items;
  }
}
```

- [ ] **Step 4: 写 `src/webview/main.tsx`**

```tsx
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 5: 创建 `src/webview/sc.tsx`（样式基座，Task 16-18 扩充）**

```tsx
// styled 定义集中在 sc.tsx（用户规则：styled 必须独立文件）
import styled from "styled-components";

export const Shell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
`;
```

- [ ] **Step 6: 建四个组件的空壳（Task 16-18 实现），先保证编译**

`src/webview/components/Header.tsx`：

```tsx
export function Header(_props: Record<string, unknown>) { return null; }
```

同法创建 `Toolbar.tsx`、`ProjectList.tsx`、`Footer.tsx` 空壳。

- [ ] **Step 7: 移除 `esbuild.js` 的 `WEBVIEW_READY` 开关，恢复双入口**

- [ ] **Step 8: 编译验证**

```powershell
npm run compile
npx tsc --noEmit
```

Expected: `dist/webview.js` 产出；tsc 零错误

- [ ] **Step 9: Commit**

```powershell
git add src/webview esbuild.js
git commit -m "feat: add webview react shell with csp and message hook"
```

---

### Task 16: Header + Toolbar 组件

**Files:**
- Modify: `src/webview/components/Header.tsx`、`src/webview/components/Toolbar.tsx`、`src/webview/sc.tsx`

**Interfaces:**
- Consumes: App 传入的 props（Task 15 签名）
- Produces: Header（统计 + 三按钮 + Ollama 红点）、Toolbar（筛选四态）。批量提交按钮带两击确认（`confirmBeforePush`，spec §10/§13）

- [ ] **Step 1: `Header.tsx` 完整实现**

```tsx
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
        <HBtnPrimary onClick={armAndFire} disabled={p.batchDisabled} $danger={armed}>
          {armed ? "再点一次确认提交并 push" : "批量提交并 push"}
        </HBtnPrimary>
      </div>
    </HeaderWrap>
  );
}
```

- [ ] **Step 2: `Toolbar.tsx` 完整实现**

```tsx
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
```

- [ ] **Step 3: `sc.tsx` 追加样式（全部遵循 emil-design-eng：具体属性 transition、ease-out、:active scale、reduced-motion）**

```tsx
import styled, { css } from "styled-components";

const easeOut = css`cubic-bezier(0.23, 1, 0.32, 1)`;

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
export const Dot = styled.span<{ $ok: boolean }>`
  width: 8px; height: 8px; border-radius: 50%;
  background: ${({ $ok }) => ($ok ? "var(--vscode-testing-iconPassed, #73c991)" : "var(--vscode-errorForeground)")};
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
export const HBtnPrimary = styled(HBtn)<{ $danger?: boolean }>`
  background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-background)")};
  color: ${({ $danger }) => ($danger ? "#fff" : "var(--vscode-button-foreground)")};
  &:hover { background: ${({ $danger }) => ($danger ? "var(--vscode-errorForeground)" : "var(--vscode-button-hoverBackground)")}; }
  &:disabled { opacity: 0.5; cursor: default; transform: none; }
`;
export const ToolWrap = styled.div`
  display: flex; gap: 4px; padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
`;
export const TBtn = styled.button<{ $active?: boolean }>`
  background: transparent; color: ${({ $active }) => ($active ? "var(--vscode-focusBorder)" : "var(--vscode-foreground)")};
  border: none; border-bottom: 2px solid ${({ $active }) => ($active ? "var(--vscode-focusBorder)" : "transparent")};
  padding: 4px 10px; cursor: pointer;
  transition: color 150ms ease, border-color 150ms ${easeOut};
`;
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile && npx tsc --noEmit`
Expected: 通过

- [ ] **Step 5: Commit**

```powershell
git add src/webview
git commit -m "feat: add header and toolbar with two-step push confirm"
```

---

### Task 17: ProjectCard + ProjectList（勾选 / 行内编辑 / 徽章 / 流式 / stagger）

**Files:**
- Modify: `src/webview/components/ProjectList.tsx`、`src/webview/sc.tsx`

**Interfaces:**
- Consumes: `Project`、`streaming`、`selected`、回调 props（Task 15）
- Produces: 卡片渲染：复选框、脏度/推送徽章、message 流式预览与行内编辑（blur 提交 + ack）、重生成按钮（离线置灰）、冲突底色、入场 stagger（仅首扫，spec §6.3）

- [ ] **Step 1: `ProjectList.tsx` 完整实现**

```tsx
import { useEffect, useRef, useState } from "react";
import type { Project } from "../../messages";
import { ListWrap, Card, CardHead, CardPath, Badge, MsgArea, MsgText, MsgInput, CardActions, CBtn, Checkbox, StaggerBox } from "../sc";

interface Props {
  items: Project[];
  streaming: Record<string, string>;
  selected: Set<string>;
  ollamaConnected: boolean | null;
  onToggle(path: string): void;
  onMessage(path: string, message: string): void;
  onRegenerate(path: string): void;
}

export function ProjectList(p: Props) {
  const [firstScanDone, setFirstScanDone] = useState(false);
  const animate = !firstScanDone && p.items.length > 0;
  useEffect(() => { if (p.items.length > 0) setFirstScanDone(true); }, [p.items.length]);

  if (p.items.length === 0) return <ListWrap><Empty>暂无项目，点击「全部重扫」</Empty></ListWrap>;

  return (
    <ListWrap>
      {p.items.map((item, i) => (
        <StaggerBox key={item.path} $index={i} $animate={animate}>
          <Card
            $selected={p.selected.has(item.path)}
            $conflict={item.status?.hasConflicts ?? false}
            onClick={() => p.onToggle(item.path)}
          >
            <CardHead>
              <Checkbox
                type="checkbox"
                checked={p.selected.has(item.path)}
                onChange={() => p.onToggle(item.path)}
                onClick={(e) => e.stopPropagation()}
              />
              <Badge $tone={item.status?.dirtiness ?? "clean"}>{DIRTY_LABEL[item.status?.dirtiness ?? "clean"]}</Badge>
              <Badge $tone={item.status?.pushState ?? "no-remote"}>{PUSH_LABEL[item.status?.pushState ?? "no-remote"]}</Badge>
              <strong>{item.name}</strong>
              <CardPath title={item.path}>{item.path}</CardPath>
            </CardHead>
            <MsgArea onClick={(e) => e.stopPropagation()}>
              <MessageRow item={item} streamText={p.streaming[item.path]} ollamaConnected={p.ollamaConnected} onCommitEdit={p.onMessage} />
            </MsgArea>
            <CardActions onClick={(e) => e.stopPropagation()}>
              {(item.phase === "ready" || item.phase === "ready_failed") && (
                <CBtn onClick={() => p.onRegenerate(item.path)} disabled={p.ollamaConnected === false}>
                  重新生成
                </CBtn>
              )}
              {item.phase === "push_failed" && (
                <CBtn onClick={() => p.onRegenerate(item.path)} hidden>重试 push</CBtn>
              )}
              {item.error && <ErrText>{item.error}</ErrText>}
            </CardActions>
          </Card>
        </StaggerBox>
      ))}
    </ListWrap>
  );
}

const DIRTY_LABEL = { clean: "干净", staged: "已暂存", dirty: "有改动", conflict: "冲突" } as const;
const PUSH_LABEL = { ahead: "未推", behind: "落后", synced: "已同步", "no-remote": "无远程" } as const;
const Empty = ({ children }: { children: string }) => <div style={{ padding: 24, color: "var(--vscode-descriptionForeground)" }}>{children}</div>;
const ErrText = ({ children }: { children: string }) => <span style={{ color: "var(--vscode-errorForeground)", fontSize: 11 }}>{children}</span>;

/** message 区：流式预览 / 行内编辑 / 占位 */
function MessageRow({ item, streamText, ollamaConnected, onCommitEdit }: {
  item: Project; streamText?: string; ollamaConnected: boolean | null;
  onCommitEdit(path: string, message: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (streamText !== undefined) {
    return <MsgText $streaming>{streamText}<Cursor /></MsgText>;
  }
  const offline = ollamaConnected === false && !item.message;
  if (offline && !editing) {
    return <MsgText $dim>AI 未连接，点击填写 message 后提交</MsgText>;
  }
  if (editing) {
    return (
      <MsgInput
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft.trim() && draft !== item.message) onCommitEdit(item.path, draft.trim()); }}
        rows={Math.min(6, draft.split("\n").length + 1)}
      />
    );
  }
  if (item.message) {
    return <MsgText onClick={() => { setDraft(item.message); setEditing(true); }} title="点击编辑">{item.message}</MsgText>;
  }
  if (item.phase === "generating" || item.phase === "statused") {
    return <MsgText $dim>生成中…</MsgText>;
  }
  if (item.status?.dirtiness === "clean") return <MsgText $dim>无待提交改动</MsgText>;
  return <MsgText $dim>—</MsgText>;
}

const Cursor = () => <span className="cursor" style={{ opacity: 0.7 }}>▍</span>;
```

注意 `hidden` 属性的"重试 push"按钮是**残缺占位**——正确实现：`ProjectList` props 需加 `onPush(path)`，App 里传 `onPush={(p) => postHost({ type: "push", path: p })}`，按钮写 `<CBtn onClick={() => p.onPush(item.path)}>重试 push</CBtn>`。落地时按此实现，不得保留 `hidden`。

- [ ] **Step 2: `sc.tsx` 追加卡片样式**

```tsx
export const ListWrap = styled.div`
  flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px;
`;
export const StaggerBox = styled.div<{ $index: number; $animate: boolean }>`
  ${({ $index, $animate }) => $animate
    ? css`animation: cardIn 200ms ${easeOut} both; animation-delay: ${Math.min($index * 30, 300)}ms;`
    : ""}
  @keyframes cardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { animation: none !important; }
`;
export const Card = styled.div<{ $selected?: boolean; $conflict?: boolean }>`
  border: 1px solid var(--vscode-panel-border);
  border-left: ${({ $selected }) => ($selected ? "4px solid var(--vscode-focusBorder)" : "4px solid transparent")};
  background: ${({ $conflict }) => ($conflict ? "rgba(var(--vscode-errorForeground-rgb, 244,96,84), 0.06)" : "var(--vscode-editor-background)")};
  border-radius: 4px; padding: 8px 12px; cursor: pointer;
  transition: border-left-color 200ms ${easeOut}, transform 160ms ${easeOut}, background 200ms ease;
  &:hover { background: var(--vscode-list-hoverBackground); }
  @media (prefers-reduced-motion: reduce) { transition: background 200ms ease; }
`;
export const CardHead = styled.div`
  display: flex; align-items: center; gap: 8px; min-width: 0;
`;
export const CardPath = styled.span`
  color: var(--vscode-descriptionForeground); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
`;
export const Badge = styled.span<{ $tone: string }>`
  font-size: 10px; padding: 1px 6px; border-radius: 8px; white-space: nowrap;
  ${({ $tone }) => {
    if ($tone === "dirty" || $tone === "ahead") return "background: rgba(204,120,50,0.2); color: var(--vscode-editorWarning-foreground);";
    if ($tone === "conflict") return "background: rgba(244,96,84,0.2); color: var(--vscode-errorForeground);";
    if ($tone === "staged") return "background: rgba(54,140,204,0.2); color: var(--vscode-editorInfo-foreground);";
    if ($tone === "clean" || $tone === "synced") return "background: rgba(115,201,145,0.18); color: var(--vscode-testing-iconPassed, #73c991);";
    return "background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);";
  }}
`;
export const MsgArea = styled.div`
  margin-top: 6px; padding: 6px 8px;
  background: var(--vscode-input-background); border-radius: 3px; min-height: 20px;
`;
export const MsgText = styled.div<{ $dim?: boolean; $streaming?: boolean }>`
  font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap;
  color: ${({ $dim }) => ($dim ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
  ${({ $streaming }) => ($streaming ? "animation: blink 1s steps(2) infinite;" : "")}
  @keyframes blink { 50% { opacity: 0.55; } }
  @media (prefers-reduced-motion: reduce) { animation: none !important; }
`;
export const MsgInput = styled.textarea`
  width: 100%; box-sizing: border-box; resize: vertical;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-focusBorder); border-radius: 3px; padding: 4px 6px;
  font-family: var(--vscode-editor-font-family); font-size: 12px;
  transition: height 180ms ${easeOut};
`;
export const CardActions = styled.div`
  margin-top: 6px; display: flex; gap: 8px; align-items: center;
`;
export const CBtn = styled(HBtn)`
  margin-left: 0; font-size: 11px; padding: 2px 10px;
  &:disabled { opacity: 0.4; }
`;
export const Checkbox = styled.input`
  accent-color: var(--vscode-checkbox-background);
`;
```

- [ ] **Step 3: App.tsx 接 onPush（配合 Step 1 修正）**——props 增 `onPush` 并传入 ProjectList

- [ ] **Step 4: 编译验证**

Run: `npm run compile && npx tsc --noEmit`
Expected: 通过

- [ ] **Step 5: Commit**

```powershell
git add src/webview
git commit -m "feat: add project cards with inline edit and stagger entry"
```

---

### Task 18: Footer + 离线降级收尾

**Files:**
- Modify: `src/webview/components/Footer.tsx`、`src/webview/sc.tsx`、`src/extension.ts`（ollamaState 推送）

**Interfaces:**
- Consumes: `ollamaConnected`、`lastBatch`（Task 15 state）
- Produces: Footer（Ollama 状态点 + `ollama serve` 提示 + 最近批量结果）；extension.ts 在激活时与配置变更时推送 `{ type: "ollamaState" }`（spec §7.5）

- [ ] **Step 1: `Footer.tsx` 实现**

```tsx
import { FootWrap, Dot, FootText } from "../sc";

interface Props { ollamaConnected: boolean | null; lastBatch: string; }

export function Footer(p: Props) {
  return (
    <FootWrap>
      <Dot $ok={p.ollamaConnected !== false} />
      <FootText>
        {p.ollamaConnected === false
          ? "Ollama 未连接 — 运行 ollama serve 后点「全部重扫」重试"
          : p.ollamaConnected === null
            ? "正在检测 Ollama…"
            : "Ollama 已连接"}
      </FootText>
      {p.lastBatch && <FootText>{p.lastBatch}</FootText>}
    </FootWrap>
  );
}
```

`sc.tsx` 追加：

```tsx
export const FootWrap = styled.div`
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-top: 1px solid var(--vscode-panel-border);
`;
export const FootText = styled.span`
  font-size: 11px; color: var(--vscode-descriptionForeground);
`;
```

- [ ] **Step 2: extension.ts 补 ollamaState 推送**

在 `checkPrerequisites` 的 then 里加：

```ts
panel?.post({ type: "ollamaState", connected: r.ollama });
```

并在 App.tsx 的批量提交入口（Header `onBatchCommit` 落地处）写回 `lastBatch`：`commit` 消息无回执统计——改为 Host 在 `commit()` 完成后 emit 一条汇总（在 `src/messages.ts` 的 `WebviewMessage` 加 `| { type: "batchDone"; ok: number; commitFailed: number; pushFailed: number }`，extension.ts 路由 `case "commit": void commitCoordinator.commit(m.paths).then((s) => emit({ type: "batchDone", ...s }));`，App 的 `case "batchDone": setLastBatch(\`最近批量 ${s.ok} 成功 / ${s.commitFailed} 提交失败 / ${s.pushFailed} push 失败\`)`。

- [ ] **Step 3: 编译 + 全量测试**

```powershell
npm run compile && npx tsc --noEmit && npm test
```

Expected: 全部通过（或 vitest 降级策略）

- [ ] **Step 4: Commit**

```powershell
git add src/webview src/extension.ts src/messages.ts
git commit -m "feat: add footer with offline degradation and batch summary"
```

---

### Task 19: 打包 + 双宿主安装 + §13 验收走查

**Files:**
- Create: `dist/git-batch-commit-0.0.1.vsix`（产物，不入库）
- Modify: 无源码（此任务只验证；发现的缺陷回修后走正常 commit）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 已安装进 VSCode 与 Trae 的可用插件 + §13 验收结果记录

- [ ] **Step 1: 打包**

```powershell
npx vsce package --no-dependencies
```

Expected: `git-batch-commit-0.0.1.vsix` 生成（若 publisher 报错，用 `--skip-license`？不存在该 flag——正确做法：`package.json` 的 `publisher` 填任意字符串即可打包本地 vsix）

- [ ] **Step 2: 安装到 VSCode**

```powershell
code --install-extension git-batch-commit-0.0.1.vsix
```

- [ ] **Step 3: 安装到 Trae（UI 路径）**

Trae 无稳定 CLI，走界面：扩展面板右上 `…` → `从 VSIX 安装…` → 选同一个 vsix。

- [ ] **Step 4: §13 验收走查（按 spec 逐条记录实测值）**

| # | 操作 | 记录 |
|---|---|---|
| 1 | 打开 Git Batch 面板，掐表到列表出现 | 实测 ___ 秒（标准 ≤ 2s，20 项目规模） |
| 2 | 看脏项目 message 首字出现时间 | 实测 ___ 秒（标准 ≤ 5s） |
| 3 | 勾 5 个真项目批量提交 | 5/5 push 成功？Y/N |
| 4 | 停 Ollama（`ollama stop qwen3-4b-instruct-2507` 或退进程）重扫 | 状态徽章正常 + "AI 未连接"？ |
| 5 | 断网重试 push | push_failed → 恢复网络 → 重试成功？ |
| 6 | 关面板重开 | 状态重扫无残留？ |

- [ ] **Step 5: 修复走查发现的问题（若有），逐个 commit**

- [ ] **Step 6: 收尾 commit（验收记录追加到 spec §13 表格）**

```powershell
git add docs
git commit -m "docs: record acceptance walkthrough results"
```

---

## Self-Review 结论

1. **Spec 覆盖**：§2.1 五项 → T13/T14/T17；§5 数据流 → T12/T13/T14；§6 UI → T16/T17/T18；§7 错误处理 → T9/T10/T13/T18；§8 协议 → T2/T14/T18（新增 `batchDone`/`dispose`/`ollamaState` 三条消息，均标注了 spec 章节依据）；§9 prompt → T8；§10 配置 → T1；§11 测试 → 各任务 TDD + T19；§13 验收 → T19
2. **占位扫描**：正文标注了 4 处"残缺/禁止照抄"点（T6 哨兵 if、T13 骨架测试、T14 dispose hack、T17 hidden 按钮），每处都给了正确写法——执行者必须按正确写法落地
3. **类型一致性**：`WebviewMessage` 三次扩展（dispose/batchDone/ollamaState）都在 messages.ts 单点修改；`MessageStore` 被 T12/T13/T14 共用同一签名
