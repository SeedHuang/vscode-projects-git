// 打 vsix：产物名 <name>-<version>.vsix 全部从 package.json 读，避免多处硬编码。
// 唯一真源：package.json 的 name + version —— 改它们，产物路径自动跟上。
//
// 直接 import vsce 库的 packageCommand() 函数 —— 绕开它的 CLI 入口（CLI 在
// fire-and-forget 模式下不可靠：program.action 不被 commander await，进程可能
// 在 pack 完成前就退出）。库 API 是正经 async function，能 await 到结果。
import { readFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(here, ".."));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

mkdirSync(join(repoRoot, "build"), { recursive: true });

const vsixPath = join(repoRoot, "build", `${pkg.name}-${pkg.version}.vsix`);

// Drop any stale artifact: if packageCommand() resolves without actually writing
// (the silent-failure class this script was written to defeat), existsSync()
// below could otherwise pass on a file from a previous build and the installer
// would ship old code.
rmSync(vsixPath, { force: true });

console.log(`[build] pkg name=${pkg.name} version=${pkg.version}`);
console.log(`[build] target: ${vsixPath}`);

// Bare specifier — resolved via package.json dependencies. Works with npm,
// pnpm, yarn, workspaces. If vsce is missing (e.g. `npm ci --omit=dev`) the
// import throws a useful module-not-found message; we surface that below.
let packageCommand;
try {
  ({ packageCommand } = await import("@vscode/vsce/out/package.js"));
} catch (err) {
  console.error(`[build] failed to load @vscode/vsce: ${err?.message ?? err}`);
  console.error(`[build] hint: run 'npm install' to install devDependencies.`);
  process.exit(1);
}

try {
  await packageCommand({
    cwd: repoRoot,
    packagePath: vsixPath,
    dependencies: false,
    allowMissingRepository: true,
  });
} catch (err) {
  console.error(`[build] vsce failed: ${err?.message ?? err}`);
  process.exit(1);
}

if (!existsSync(vsixPath)) {
  console.error(`[build] expected artifact missing: ${vsixPath}`);
  process.exit(2);
}

console.log(`[build] OK: ${vsixPath} (${statSync(vsixPath).size} bytes)`);
