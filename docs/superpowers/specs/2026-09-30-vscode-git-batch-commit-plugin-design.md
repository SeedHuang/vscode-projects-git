# 2026-09-30 VSCode/Trae 批量提交插件 设计文档

> **状态**：设计中
> **路径分类**：架构级（新项目、新子系统）
> **目标宿主**：VSCode 1.85+ 与 Trae（基于 VSCode 内核的衍生编辑器）

---

## 1. 背景

用户本地同时维护多个项目，经常需要批量提交并推送到远端。手写每个项目的 commit message 耗时且质量不稳定。本机已安装 Ollama 与 `qwen3-4b-instruct-2507` 模型，希望通过 VSCode/Trae 插件统一管理最近打开项目的 git 状态，并借助本地 LLM 生成 commit message。

## 2. 目标与边界

### 2.1 必须实现（MVP）

1. 扫描当前编辑器中"最近打开过的项目"列表
2. 对每个项目解析 git 状态：脏/暂存/干净、冲突、是否配置 remote、ahead/behind
3. 对脏项目调用本地 Ollama 生成中文 commit message（流式预览）
4. Webview 页面内勾选项目，批量执行 `add + commit + push`
5. 消息支持单项目编辑、重生成；commit 失败可重试 commit，push 失败可单独重试 push

### 2.2 明确不做（YAGNI）

- 不读取其他编辑器的历史记录
- 不接云端 LLM（OpenAI/Claude）
- 不做 conventional commit 格式的强制校验（4B 模型有幻觉，让用户在预览里改）
- 不做 monorepo 拆分检测
- 不做深色/浅色主题切换（跟随编辑器 CSS 变量）
- 不做提交历史回顾页
- 不做设置页（Ollama 地址与端口通过 `package.json contributes.configuration` 配置，默认 `http://localhost:11434`）
- 不做自定义快捷键

### 2.3 范围检查

单一插件、单一交付包；插件脚手架（React + TS + esbuild webview）+ Extension Host 三个 Worker（发现/git/Ollama）+ 一个 CommitCoordinator。可在单个实施计划内交付，无需拆分多个 spec。

## 3. 用户故事

1. 作为开发者，我打开插件主页，立即看到所有最近打开的项目及其 git 状态徽章。
2. 作为开发者，我看到脏项目的 AI 生成 message 流式出现，可以在内联文本框里改。
3. 作为开发者，我勾选要提交的项目，点一个按钮批量 add + commit + push。
4. 作为开发者，我看到哪些项目 commit 成功但 push 失败，可单独点"重试 push"。
5. 作为开发者，我关掉 webview 重新打开，所有状态重新扫描（不持久化）。

## 4. 架构

### 4.1 进程与组件

```
┌─────────────────────────────┐
│      VSCode/Trae 进程        │
│ ┌──────────────────────────┐ │
│ │  Extension Host          │ │
│ │ ┌──────────────────────┐ │ │
│ │ │ ScanCoordinator      │ │ │   并行启动
│ │ │ ┌──────────────────┐ │ │ │
│ │ │ │DiscoveryWorker   │ │ │ │
│ │ │ └──────────────────┘ │ │ │
│ │ │ ┌──────────────────┐ │ │ │
│ │ │ │GitStatusWorker   │ │ │ │
│ │ │ └──────────────────┘ │ │ │
│ │ │ ┌──────────────────┐ │ │ │   前两步 done 后才启动
│ │ │ │OllamaWorker      │ │ │ │
│ │ │ └──────────────────┘ │ │ │
│ │ └──────────────────────┘ │
│ │ ┌──────────────────────┐ │
│ │ │ CommitCoordinator    │ │   并发上限 3
│ │ └──────────────────────┘ │
│ └──────────────────────────┘
│         │ postMessage
│         ▼
│ ┌──────────────────────────┐
│ │      Webview             │
│ │   React + styled-     │
│ │   components + esbuild   │
│ └──────────────────────────┘
└─────────────────────────────┘
```

### 4.2 文件/目录结构

```
.
├── package.json                       # contributes + activationEvents
├── tsconfig.json
├── src/
│   ├── extension.ts                   # activate(), 注册命令与 webview view
│   ├── scanner/
│   │   ├── ScanCoordinator.ts         # 并行调度三个 Worker
│   │   ├── DiscoveryWorker.ts         # 读 SQLite 最近项目
│   │   ├── GitStatusWorker.ts         # spawn git status
│   │   └── OllamaWorker.ts            # 流式调用 Ollama HTTP
│   ├── committer/
│   │   └── CommitCoordinator.ts       # 并发限流 3 的批量提交
│   ├── git/
│   │   ├── statusParser.ts            # git status --porcelain -b 解析
│   │   └── spawnGit.ts                # spawn 包装，错误归一化
│   ├── ollama/
│   │   ├── streamClient.ts            # 流式 HTTP NDJSON 解析
│   │   └── prompt.ts                  # 中文 prompt 模板
│   ├── messages.ts                    # Host ↔ Webview 联合类型
│   └── webview/
│       ├── main.tsx                   # React 入口
│       ├── App.tsx                    # 根组件
│       ├── sc.tsx                     # styled-components 定义
│       ├── components/
│       │   ├── Header.tsx
│       │   ├── Toolbar.tsx
│       │   ├── ProjectList.tsx
│       │   └── ProjectCard.tsx
│       └── hooks/
│           └── useExtensionMessage.ts
└── test/
    ├── statusParser.test.ts
    ├── streamClient.test.ts
    ├── prompt.test.ts
    └── fixtures/                      # 手工假历史/假 git 仓库
```

## 5. 数据流

### 5.1 扫描流程

```
触发源：
  - Webview onload → 消息 { type: "scan" }
  - Header 按钮 [全部重扫] → 消息 { type: "scan" }
  - Command Palette "刷新" → 内部直接调用 ScanCoordinator

ScanCoordinator.scan():
  1. 若有正在跑的 scan 实例：先 abort 旧的（每个 Worker 持 AbortController），再启新的
  2. 并发启动 DiscoveryWorker 与 GitStatusWorker
  3. 两者都 done 后，Webview 收到 { type: "projectList", items }
     此时每张卡有 status 徽章，message 区域占位"生成中..."
  4. 启动 OllamaWorker，对每个脏项目串行生成 message
  5. 流式 chunk 推回 Webview，最终 { type: "streamDone", path, message }
     **每次 streamDone 走 host 端 messageStore.set()，webview 重连时由 host 重发 projectList**
```

### 5.2 Ollama 调用

- 端点：`POST http://localhost:11434/api/generate`
- 请求体：`{ model: "qwen3-4b-instruct-2507", prompt: string, stream: true, options: { temperature: 0.2 } }`
- 响应：NDJSON，每行 `{ response: "字", done: false }` 或 `{ done: true, ... }`
- 超时：单次生成 30s 视为超时
- 失败：HTTP 4xx/5xx → 整批停掉；连接拒绝 → 仅 OllamaWorker 不影响其他 Worker

### 5.3 提交流程

```
Webview 点 "批量提交并 push"
  → 发 { type: "commit", paths: string[] }

输入校验（host 端，OllamaWorker 与 CommitCoordinator 共享同一个 validatePaths）：
  - 空数组 → 直接 ack 无操作
  - 路径不存在 / 不是 git 仓库 → 该卡推 { status: "commit_failed", reason: "not_git_repo" }，跳过
  - 重复路径去重，保留首次出现

CommitCoordinator.commit(paths):
  并发限流 3（p-limit 模式）
  对每个 path：
    1. git add -A（spawn 数组参数，无 shell 转义风险）
    2. 用临时文件 -F 写 message，git commit -F <tmpfile>
       （规避 -m 单行 + shell 特殊字符问题，支持多行中文）
    3. 若 .ahead > 0 且有 remote → git push
    4. 每步推 { type: "status", path, status }
  CommitCoordinator 在 webview dispose 时拿 AbortSignal 停发新任务，已 commit 的保留

状态码（写入卡片的 status 字段）：
  "scanning" | "statused" | "generating" | "ready" | "ready_failed" |
  "committing" | "committed" | "push_failed" | "push_ok" | "commit_failed"

单一真相源：所有 phase 写者只有 host 端（ScanCoordinator + CommitCoordinator），
Webview 收到的 phase 永远来自 host 推送，禁止 webview 端本地 mutate phase。
```

### 5.4 持久化策略

**不持久化任何状态**。每次打开 webview 重新扫描、重新生成 message。本地 LLM 生成成本低，持久化反而会让 message 跟实际变更错位。

## 6. UI 设计

### 6.1 页面布局

```
┌─────────────────────────────────────────────────────────────┐
│ Header  · 扫描到 N 个项目 · 未提交 X · 未 push Y             │
│         [全部重扫]  [刷新消息]  [批量提交并 push]             │
├─────────────────────────────────────────────────────────────┤
│ Toolbar  筛选:[全部][未提交][未 push][冲突]  排序:[最近打开]  │
├─────────────────────────────────────────────────────────────┤
│ ProjectList（卡片列表，可滚动）                               │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ ☑ ✓📝 🚀  my-app       /Users/x/code/my-app              ││
│ │      feat: 添加用户登录表单与 token 校验                  ││
│ │      +12 -3  main ✓ ahead 3                              ││
│ │      [ ✏️ 改 message ]  [ 🗑️ 排除 ]                       ││
│ └──────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
│ Footer  ● Ollama 已连接 ·  最近条目 3/7 成功                    │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 状态徽章

| 字段 | 取值 | UI |
|---|---|---|
| status（脏度） | clean/staged/dirty/conflict | 图标 + 颜色 |
| push（推送） | ahead/behind/synced/no-remote | 文字徽章 |
| phase（流程） | 见 §5.3 | 影响按钮可见性 |

### 6.3 关键交互（emil-design-eng 准则）

| 交互 | 实现 |
|---|---|
| 卡片入场 | stagger 30ms 延迟，从 `translateY(8px) + opacity:0` → 正常，200ms ease-out。仅首次扫描播放，刷新不重播 |
| 复选框选中 | 卡片左边描边 0 → 4px，200ms ease-out |
| Message 内联编辑 | textarea 替换显示；blur 时提交修改；高度过渡 180ms ease-out，不用 modal |
| 重新生成 message | 按钮变 spinner，完成时 message 区 100ms 闪烁一次 |
| 筛选切换 | CSS transition（不是 keyframes），避免反复触发重影 |
| 冲突卡片 | 背景 `var(--vscode-errorBackground)` 6% 透明度 |
| 按钮 :active | `transform: scale(0.97)` 160ms ease-out |
| prefers-reduced-motion | 减少/移除位移类动画，保留 opacity 与颜色过渡 |

## 7. 错误处理

### 7.1 Ollama 相关

| 情况 | 现象 | 处理 |
|---|---|---|
| Ollama 未启动（ECONNREFUSED） | 全卡 message 区"AI 未连接"灰条 | Header 红点 + Footer 提示 `ollama serve`；不影响 scan/status |
| 单项目超时（>30s） | 该卡 message 区"超时，点击重试" | 不阻塞其他卡 |
| 模型 404 | 整个生成停掉，Footer 报错 | 检查模型配置 |
| 返回空字符串 | 该卡 message 区"生成失败，点击重试" | 单点重试 |

### 7.2 SQLite 相关

- 读 `state.vscdb` 前 `fs.copyFile` 到 `os.tmpdir()/vscode-recent-<uuid>.db`，sql.js 打开副本
- 副本读完即删除，**不落地不缓存**（个人浏览历史不应留磁盘痕迹）

### 7.3 Git 相关

| 失败位置 | 处理 |
|---|---|
| `git add` 失败 | 状态 → `commit_failed`，message 区不变 |
| `git commit` 失败（hook/未配邮箱） | 状态 → `commit_failed`，徽章红，Footer 显示 stderr |
| `git push` 失败 | commit 已落盘；状态 → `push_failed` 橙；可单点重试 push |
| 用户未配 user.email/user.name | commit 失败时 stderr 检测，**不阻塞其他项目**，Footer 提示配置命令 |
| Webview 中途 dispose | CommitCoordinator 拿 AbortSignal 停发新任务；已 commit 的保留；host 端 phaseMap 继续托管，下次重连时由 host 重发 projectList |

### 7.4 接管时刻（用户手动制造的脏状态）

| 接管前用户可能做了 | plugin 行为 |
|---|---|
| 删了 `.git` 目录 | DiscoveryWorker 后过滤：`fs.stat(path + '/.git')` 失败的项目从列表移除，Footer 不报错 |
| 项目含 submodule | 顶层路径加进来后 git status 只反映外层 dirty；submodule 内部 dirty **不展示**（避免一次 commit 跨 worktree） |
| 用户外部 `git commit --amend` | phaseMap 不会自动同步；下次扫描会刷新 phase → 自动纠正 |
| 用户外部 `git fetch` 后本地落后 | phase 显示 `behind`；不自动 pull（避免误合并） |
| 路径是 symlink / junction | 用 `fs.realpath` 解析为真实路径后再走 git；解析失败则按"非 git 仓库"过滤 |

### 7.5 离线降级（Ollama 不可用）

- Header 红点 + Footer 提示 `ollama serve`
- 所有脏项目 message 区域显示 "AI 未连接，手动填写后提交"
- 不阻止用户手填 message 后提交
- `regenerate` 按钮置灰

## 8. 消息协议

### 8.1 Webview → Host

```ts
type HostMessage =
  | { type: "scan" }
  | { type: "regenerate"; path: string }
  | { type: "setMessage"; path: string; message: string; ackId: string }
  | { type: "commit"; paths: string[] }
  | { type: "push"; path: string }
  | { type: "ack"; ackId: string };
```

**`ack` 协议**：host 端收到 `setMessage` 后立即回 `{ type: "ack", ackId }`，
Webview 显示"已保存 ✓"短暂反馈；webview 重连时 host 重发 projectList 自动恢复。

### 8.2 Host → Webview

```ts
type WebviewMessage =
  | { type: "projectList"; items: Project[] }
  | { type: "stream"; path: string; chunk: string }
  | { type: "streamDone"; path: string; message: string }
  | { type: "status"; path: string; status: ProjectStatus }
  | { type: "ack"; ackId: string };

type ProjectStatus =
  | "scanning" | "statused" | "generating" | "ready" | "ready_failed"
  | "committing" | "committed" | "push_failed" | "push_ok" | "commit_failed";
```

类型集中定义在 `src/messages.ts`，扩展联合类型编译期即可发现遗漏。

## 9. Prompt 模板

```
你是一个 commit message 助手。根据提供的 git diff 输出中文 commit message。

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
- 如果 diff 为空或只有 lock 文件变动，输出 "chore: update dependencies" 或类似一句
- 如果 diff 超长被截断，只根据给出的"文件清单 + 状态"总结，不要编造细节
```

**Diff 截断保护**：diff > 8000 字符时只喂"文件清单 + 状态"，模型给粗略 message，避免撑爆 8k 上下文。

## 10. 配置项（`package.json contributes.configuration`）

| key | default | 说明 |
|---|---|---|
| `gitBatch.ollamaUrl` | `http://localhost:11434` | Ollama HTTP 地址 |
| `gitBatch.ollamaModel` | `qwen3-4b-instruct-2507` | 模型名（取数命令：`ollama list`） |
| `gitBatch.commitConcurrency` | `3` | 批量提交并发上限 |
| `gitBatch.maxDiffChars` | `8000` | 喂模型的 diff 截断阈值 |
| `gitBatch.ollamaTimeoutMs` | `30000` | 单项目生成超时 |
| `gitBatch.confirmBeforePush` | `true` | push 前 hold-to-confirm（不可逆保护） |
| `gitBatch.confirmBeforeCommit` | `true` | 批量 commit 前显示 diff 总览摘要 |

## 11. 测试

### 11.1 单元测试（vitest）

| 模块 | 测试用例 |
|---|---|
| `statusParser` | 解析各种 `git status --porcelain -b` 输出（脏/暂存/干净/冲突/ahead/behind/no-remote） |
| `streamClient` | mock HTTP 层，验证 NDJSON 解析正确、超时降级 |
| `prompt` | 验证 prompt 模板不含违规指令（"tweak" 这类模型爱造的英文前缀） |
| `CommitCoordinator` | mock spawn，验证 add/commit/push 调用顺序与失败时的状态码 |
| `spawnGit` | 多行 message / 含 shell 特殊字符 / 中文 / 空字符串 |
| `discovery/hostDetector` | VSCode / Trae / 未知宿主三态识别 |
| `scanCoordinator` | 重扫时旧实例 abort，新结果不混叠 |

### 11.2 Fixture 覆盖矩阵

| 维度 | 覆盖 |
|---|---|
| 路径分隔符 | Windows `\` 与 POSIX `/` |
| 编码 | UTF-8 / UTF-8 BOM / GBK / CRLF |
| 路径特殊字符 | 含空格 / 中文 / emoji |
| Git 异常状态 | detached HEAD / rebase 中 / submodule / bare repo |
| Ollama 响应 | 正常流 / 超时 / 404 / ECONNREFUSED / 返回空 |

### 11.3 已知环境问题

Vitest 在受限沙箱中可能 stuck 在 `[queued]`。落地时若遇此现象，按 KB L-2026-09-27-006 改用 `tsc --noEmit` + 读测试文件三态校验代替运行验证。

### 11.4 前置条件 & 诊断入口

**安装前置条件**（`activate()` 时检测，缺则弹一次性提醒）：

| 依赖 | 检测命令 |
|---|---|
| git | `spawn('git', ['--version'])` |
| Ollama | `fetch(ollamaUrl + '/api/tags')` |
| `state.vscdb` 存在 | `fs.exists(stateVscdbPath)` |

**诊断入口**：

- 命令面板 `Git Batch: Export Logs` → 把 host 端日志（最近 200 条）写到工作区根 `.vscode/gitBatch-logs.txt`
- Footer 状态行实时显示当前阶段错误

## 12. 风险与权衡

| 风险 | 决策 |
|---|---|
| qwen3-4b-instruct-2507 在某些 diff 上生成质量差 | 用户预览可编辑 + 重生成按钮；类型限定 8 个降幻觉 |
| VSCode 与 Trae 的 `state.vscdb` 路径不同 | 通过 `env.VSCODE_CWD` / `process.argv` 探测运行时：`vscode` → 走 `%APPDATA%\Code\...`；`trae` → 走 `%APPDATA%\Trae\...`；落地时跑一次跨平台真值校验，落进 `discovery/hostDetector.ts` |
| Ollama 在 Windows 上的子进程 shell 差异 | `spawnGit` 用 `shell: false` + 数组参数，跨平台一致 |
| Webview 在 React 18+ 下多次 postMessage 可能合批 | React 不参与 Host↔Webview 边界通信；`vscode.postMessage` 是同步入队 + 异步跨进程，本身不会丢 chunk；**移除错误的 queueMicrotask 风险条目** |
| 批量提交时本机磁盘 IO 抖动 | 并发上限 3，避免和 Ollama 抢 IO |

## 13. 验收标准

每条标注【自动/人工】与取数命令。

1. 【自动】打开插件主页，2 秒内（20 个项目规模）显示完整列表与状态徽章
   - 取数命令：`vscode-test` 脚本计 `t0=Date.now()` 到 `projectList` 消息到达的差值
2. 【人工+自动】脏项目的 message 在 5 秒内开始流式出现，10 秒内完成
   - 取数命令：`ollama logs` 抓 time-to-first-token；fixture 仓库下用 vitest 计时 `streamFirstToken`
3. 【自动】勾选 5 个项目点批量提交，3 个并发执行，5 个全部成功 push 到远端
   - 取数命令：mock spawn 后断言 `concurrencySeen === 3` 且 `successCount === 5`
4. 【人工+自动】关掉 Ollama 后打开插件，状态徽章正常显示，message 区显"AI 未连接"，不影响 scan/status
   - 取数命令：`fetch('http://localhost:11434')` 失败时 vitest 断言 Header 红点文案
5. 【人工】拔网线后单 push 重试可恢复
   - 取数命令：手工断网 → 触发 push → 看 push_failed 状态 → 重连 → 重试成功
6. 【自动】关闭 webview 重新打开，所有状态重新扫描无残留
   - 取数命令：vitest 断言 host 端 phaseMap dispose 后内存归零

## 14. Backlog（P2 处置）

| # | 来源 | P2 简述 | 处置 | 理由 |
|---|---|---|---|---|
| B1 | Q15 | §12 风险表中 `queueMicrotask` 条目错误 | **关闭** | 已并入 §12 风险表正文修订，不再单列 |
| B2 | Q16 | spawn 数组参数未在 spec 明说 | **采纳** | 已并入 §5.3 步骤 1 |
```