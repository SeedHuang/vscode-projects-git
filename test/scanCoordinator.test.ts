import { describe, it, expect, vi } from "vitest";
import { MessageStore, ScanCoordinator } from "../src/scanner/ScanCoordinator";
import { OllamaWorker } from "../src/scanner/OllamaWorker";
import type { WebviewMessage } from "../src/messages";

function makeOllama(store: MessageStore) {
  const hooks = {
    onStream: vi.fn(),
    onDone: vi.fn((path: string, message: string) => store.set(path, message)),
    onFailed: vi.fn(),
    onFatal: vi.fn(),
  };
  const w = new OllamaWorker({ url: "http://x", model: "m", maxDiffChars: 100, timeoutMs: 1000 }, hooks);
  // 同步完成模拟：enqueue 后立刻 onDone（绕开真实 streamGenerate）
  (w as unknown as { enqueue: (t: { path: string }) => void }).enqueue = (t) => {
    hooks.onDone(t.path, `msg-for-${t.path}`);
  };
  return { w, hooks };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const messages: WebviewMessage[] = [];
  const store = new MessageStore();
  const { w: ollama, hooks } = makeOllama(store);
  const deps = {
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
    store,
    diffFor: async () => ({ statusLine: "## main", diff: "x", fileList: "f" }),
    ...overrides,
  };
  return { deps, messages, ollama, hooks };
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
  it("产出 projectList，脏项目进生成队列", async () => {
    const { deps, messages, hooks } = makeDeps();
    const sc = new ScanCoordinator(deps);
    await sc.scan();
    const list = messages.find((m) => m.type === "projectList") as { items: Array<{ path: string; phase: string; message: string }> };
    expect(list.items.length).toBe(2);
    // 第一次 projectList emit 时 OllamaWorker 还没回写——message 字段是空
    expect(list.items[0].message).toBe("");
    // 同步 mock 触发 onDone，store 应已填
    expect(deps.store.get("d:\\a")).toBe("msg-for-d:\\a");
    // b 是干净仓库，没进 ollama
    expect(hooks.onDone).toHaveBeenCalledTimes(1);
  });

  it("重扫作废旧代：旧扫描的 emit 不覆盖新扫描", async () => {
    let releaseOld!: () => void;
    const gate = new Promise<void>((r) => (releaseOld = r));
    const { deps, messages } = makeDeps();
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