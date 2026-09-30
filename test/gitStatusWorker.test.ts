import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      execSync("git add f.txt && git -c user.email=t@t -c user.name=t commit -m base", { cwd: d });
      execSync("git checkout -b side", { cwd: d });
      writeFileSync(join(d, "f.txt"), "side\n");
      execSync("git commit -am side", { cwd: d });
      execSync("git checkout main", { cwd: d });
      writeFileSync(join(d, "f.txt"), "main\n");
      execSync("git commit -am main", { cwd: d });
      try { execSync("git merge side", { cwd: d }); } catch { /* 冲突预期 */ }
    });
    const m = await getGitStatuses([clean, dirty, conflict]);
    expect(m.get(clean)!.dirtiness).toBe("clean");
    expect(m.get(dirty)!.dirtiness).toBe("dirty");
    expect(m.get(conflict)!.dirtiness).toBe("conflict");
  });

  it("无 remote → no-remote", async () => {
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