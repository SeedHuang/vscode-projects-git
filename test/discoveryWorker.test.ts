import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { discoverRecentProjects } from "../src/scanner/DiscoveryWorker";
import type { DiscoveryDeps } from "../src/scanner/DiscoveryWorker";

const require = createRequire(import.meta.url);

async function makeSql() {
  const buf = readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"));
  // sql.js 的 wasmBinary 期望 ArrayBuffer；Buffer 在 Node 22 类型层不直接兼容
  return initSqlJs({ wasmBinary: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer });
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
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
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
    readStorageJson: async () => null,
    stateDbPath: "/tmp/state.vscdb",
    storageJsonPath: null,
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

  it("新版：storage.json 优先于 state.vscdb（VSCode 1.86+ 路径）", async () => {
    const buf = await makeDbBuffer(LIST); // db 里其实有 4 个
    let storageCalled = false;
    const r = await discoverRecentProjects(
      makeDeps(
        {
          storageJsonPath: "/tmp/storage.json",
          // 只要 storageJson 返非空就走它；stateDb 完全不看
          stateDbPath: null,
          readStorageJson: async () => {
            storageCalled = true;
            return {
              profileAssociations: {
                workspaces: {
                  "file:///d%3A/code/alpha": "__default__profile__",
                  "file:///d%3A/code/delta": "__default__profile__",
                },
              },
              backupWorkspaces: { folders: [{ folderUri: "file:///d%3A/code/beta" }] },
              windowsState: { lastActiveWindow: { folder: "file:///d%3A/code/gamma" } },
            };
          },
        },
        buf
      )
    );
    expect(storageCalled).toBe(true);
    // alpha 来自 workspaces；beta 来自 backupWorkspaces；gamma 来自 lastActiveWindow
    // delta 在 workspaces 里但没 git 标记（默认 isGitRepo 不过滤）→ 保留
    expect(r.map((p) => p.path)).toEqual([
      "d:\\code\\alpha",
      "d:\\code\\delta",
      "d:\\code\\beta",
      "d:\\code\\gamma",
    ]);
  });

  it("storage.json 不可用时回退到 state.vscdb（旧版本路径）", async () => {
    const buf = await makeDbBuffer(LIST);
    const r = await discoverRecentProjects(
      makeDeps(
        { storageJsonPath: "/tmp/storage.json", readStorageJson: async () => null },
        buf
      )
    );
    expect(r.map((p) => p.path)).toEqual(["d:\\code\\alpha", "d:\\code\\beta"]);
  });
});