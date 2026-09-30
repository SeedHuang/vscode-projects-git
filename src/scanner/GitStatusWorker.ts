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
    paths.map((p) =>
      limit(async (): Promise<[string, GitStatus] | null> => {
        const r = await runGit(p, ["status", "--porcelain", "-b"], 15000);
        if (r.code !== 0) return null; // 非 git 仓库 / 已删除 → 过滤
        return [p, parseStatus(r.stdout)];
      })
    )
  );
  return new Map(entries.filter((e): e is [string, GitStatus] => e !== null));
}