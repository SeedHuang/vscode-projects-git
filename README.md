# Git Batch Commit

一个给 VSCode 和 Trae 用的扩展。它的作用是：**把你最近打开过的所有 git 项目摆在一个面板里，勾选后一次性让本地 Ollama 帮你写中文 commit message，再批量 commit + push。**

省掉的事：

- 不用一个个项目切进去 `git status` 看有没有改
- 不用自己写每条 commit message —— 让本地 Ollama 草拟，你在面板里改
- 不用重复点 n 次"提交"按钮 —— 勾一批，点一下，N 个项目一起 commit + push

---

## 它能做什么

打开插件面板（左边活动栏的 **Git Batch** 图标）后你会看到：

1. **项目列表**：自动列出你最近打开过的所有 git 项目，每个项目带一个状态徽章 —— 干净 / 已暂存 / 脏 / 冲突 / 已 ahead 待 push
2. **筛选 tab**：全部、未提交、未 push、冲突 四个 tab，方便快速定位要处理的项目
3. **AI 生成 message**：勾选脏项目后，点"生成"，插件调用 `qwen3-4b-instruct-2507` 模型（默认）边写边流出来给你看
4. **单项目编辑 / 重新生成**：不满意可以自己改文案，或者再点一次让它重写
5. **批量 commit + push**：message 改好之后点"提交"，再点"推送"。两个动作都做了确认拦截，commit/push 前会弹原生确认框（怕误操作，默认开启）
6. **失败重试**：commit 失败可以单独重试 commit；push 失败可以单独重试 push
7. **导出日志**：命令面板里 `Git Batch: Export Logs` 把这次会话的日志导出到文件，方便排查

---

## 安装

### 前置条件

- **Node.js 18+**（装包、跑 esbuild、打 vsix 都要）
- **PowerShell 5.1+**（Windows 自带就行 —— Install 脚本是 .ps1）
- **本地 Ollama** 在 `http://localhost:11434` 跑着，并且已经 `ollama pull qwen3-4b-instruct-2507`。地址或模型想换，可以在 VSCode 设置里改 `gitBatch.ollamaUrl` 和 `gitBatch.ollamaModel`
- **Git** 装着，并且你最近打开过至少一个 git 项目（不然面板是空的）

### 装到 VSCode

打开 PowerShell，cd 到这个仓库的根目录，然后：

```powershell
npm install
npm run package                # 出 .vsix 到 build/
npm run vsix:install           # 装到当前 VSCode
```

或者三合一：

```powershell
npm run vsix:install:rebuild   # 重新打 vsix 并装
npm run vsix:install:vscode:restart   # 装完顺手重启 VSCode 让 webview 出现
```

> ⚠️ 装的时候如果 VSCode 在跑，脚本只会更新元数据，**真正的文件要等所有 VSCode 窗口都关掉再开才会拷进 extensions 目录**。脚本会检测并提示你退 VSCode，或者用 `-Restart` 标志让脚本帮你杀进程后重启。

### 装到 Trae

跟 VSCode 同款，但用另一条脚本。Trae 没有 CLI，脚本直接把 vsix 解压到 Trae 的 extensions 目录：

```powershell
npm install
npm run package                    # 出 .vsix 到 build/
npm run vsix:install:trae          # 装到 Trae (Trae 必须先关掉)
npm run vsix:install:trae:restart  # 装完顺手重启 Trae
```

> Trae 运行时会锁住它的 extensions 目录，所以**装之前必须关掉 Trae**。脚本默认遇到 Trae 在跑会直接退出，让你手动关；加 `-Restart` 标志它会自己杀进程、重启。

---

## 使用流程

打开扩展后跟着这个流程走：

```
打开面板
  ↓
勾选要提交的项目
  ↓
点"生成"（AI 写 message）
  ↓
在每个项目的文本框里看/改 message
  ↓
点"提交"（弹确认框 → 确认）
  ↓
点"推送"（弹确认框 → 确认）
  ↓
看 footer 状态条："最近批量 X 成功 / Y 失败 / Z 失败"
```

### 三个批量按钮的逻辑

| 按钮 | 什么时候能点 | 干什么 |
|---|---|---|
| **生成** | 勾选了脏项目**且**还没 message | 调 Ollama 给每个勾选项目流式写 commit message |
| **提交** | 勾选了脏项目**且**已有 message | 对勾选项目做 `git add -A && git commit -m "..."` |
| **推送** | 勾选了已 commit 但未 push 的项目 | 对勾选项目做 `git push` |

按钮置灰就是当前没满足条件。

### 设置项

在 VSCode / Trae 设置里搜 "Git Batch" 能改这些：

| 设置 | 默认 | 说明 |
|---|---|---|
| `gitBatch.ollamaUrl` | `http://localhost:11434` | Ollama HTTP 地址 |
| `gitBatch.ollamaModel` | `qwen3-4b-instruct-2507` | 模型名 |
| `gitBatch.commitConcurrency` | `3` | 批量提交并发上限 |
| `gitBatch.maxDiffChars` | `8000` | 喂给模型的 diff 截断阈值 |
| `gitBatch.ollamaTimeoutMs` | `30000` | 单项目生成超时（毫秒） |
| `gitBatch.confirmBeforePush` | `true` | push 前弹原生确认框 |
| `gitBatch.confirmBeforeCommit` | `true` | 批量 commit 前弹原生确认框 |

并发太高可能让 Ollama 卡住或 git 锁冲突，从 3 起步稳。

---

## 脚本清单

`npm run <name>` 可用的所有脚本（见 package.json 第 40 行起的 `scripts`）：

| 脚本 | 干什么 |
|---|---|
| `npm run compile` | esbuild 单次编译，产物到 `dist/` |
| `npm run watch` | esbuild watch 模式，改 src 自动重打 |
| `npm run package` | 用 vsce 把 dist 包成 `.vsix`，输出到 `build/` |
| `npm run test` | 跑 vitest 测试套件（一次性，不 watch） |
| `npm run typecheck` | 跑 `tsc --noEmit`，只检查不编译 |
| `npm run vscode:prepublish` | 发布前钩子（等同 compile） |
| `npm run vsix:install` | 把 `build/*.vsix` 装到当前 VSCode |
| `npm run vsix:install:rebuild` | 重新打 vsix + 装 |
| `npm run vsix:install:vscode:restart` | 装完顺手重启 VSCode |
| `npm run vsix:install:trae` | 把 vsix 解压到 Trae 的 extensions 目录 |
| `npm run vsix:install:trae:restart` | 装完顺手重启 Trae |
| `npm run deploy:vscode` | **一键**：编译 + 打 vsix + 装到 VSCode + 重启 VSCode |
| `npm run deploy:trae` | **一键**：编译 + 打 vsix + 装到 Trae + 重启 Trae |

**`deploy:vscode` / `deploy:trae` 是开发时的主入口**。两条脚本互不影响：每条只 kill+relaunch 自己的目标 IDE（脚本按精确 exe 名杀进程），所以你可以在 VSCode 跑 `deploy:trae`（Trae 会被杀并重启），反过来也行。

`vsix:install` 系列脚本在 PowerShell 里跑，参数透传给 `.ps1`：

- `-Force`：跳过"先卸载旧版本"的确认提示
- `-Rebuild`：装之前重新打一遍 vsix
- `-Restart`：装完自动重启 IDE（VSCode / Trae 二选一）

例：

```powershell
npm run vsix:install -- -Force -Rebuild -Restart   # Windows PowerShell 传参要加 --
```

---

## 怎么排错

- **面板是空的**：你最近没在 VSCode / Trae 里打开过 git 项目。随便打开一个，回到面板等几秒让它扫
- **生成 message 一直失败**：看 footer 状态条 + 命令面板 `Git Batch: Export Logs`。常见原因：Ollama 没起 / 端口不对 / 模型没 pull
- **commit / push 失败**：项目列表里那张卡的徽章会变红，hover 上去有错误信息，单项目可以单卡说"重试"—— 不需要重新走批量
- **VSCode 重启后还是看不到扩展**：`%USERPROFILE%\.vscode\extensions\git-batch-commit-<version>\` 应该有 `dist/extension.js` 和 `dist/webview.js`（目录名和 `package.json` 的 `name` + `version` 拼接），没有就说明装的时候有窗口没退干净。再跑一次 `vsix:install:vscode:restart`

---

## 项目结构

```
.
├── src/
│   ├── extension.ts              # 入口：activate() / 注册命令与 webview
│   ├── scanner/                  # 三个并行 Worker
│   │   ├── ScanCoordinator.ts    # 调度 Discovery → GitStatus → Ollama 三步
│   │   ├── DiscoveryWorker.ts    # 读 SQLite 最近项目
│   │   ├── GitStatusWorker.ts    # 跑 git status --porcelain -b
│   │   ├── OllamaWorker.ts       # 流式调 Ollama HTTP
│   │   └── hostDetector.ts       # 区分 VSCode / Trae
│   ├── committer/
│   │   └── CommitCoordinator.ts  # 并发 3 的批量 add+commit+push
│   ├── git/
│   │   ├── spawnGit.ts           # spawn 包装
│   │   └── statusParser.ts       # git status 输出 → 结构化数据
│   ├── ollama/
│   │   ├── streamClient.ts       # 流式 HTTP + NDJSON 解析
│   │   └── prompt.ts             # 喂给 Ollama 的 prompt 模板
│   ├── util/
│   │   └── createLimiter.ts      # 并发限流器
│   ├── messages.ts               # host ↔ webview 消息类型定义
│   └── webview/                  # React + styled-components 的 UI
│       ├── App.tsx               # 主组件 + 状态管理
│       ├── components/           # Header / ProjectCard / Footer 等
│       └── hooks/                # useExtensionMessage / usePathTimers
├── test/                         # vitest 测试
├── scripts/
│   ├── install-vscode.ps1
│   └── install-trae.ps1
├── esbuild.js                    # 双入口构建：extension + webview
├── package.json                  # contributes.configuration 在这改默认值
└── docs/superpowers/             # 设计文档与实施计划
```