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