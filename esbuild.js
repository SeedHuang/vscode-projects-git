const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

/** Task 15 之前 webview 入口不存在，关闭双入口；Task 15 创建入口后翻为 true */
const WEBVIEW_READY = false;

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
    if (WEBVIEW_READY) {
      const ctxB = await esbuild.context(webviewBuild);
      await Promise.all([ctxA.watch(), ctxB.watch()]);
    } else {
      await ctxA.watch();
    }
    return;
  }
  if (WEBVIEW_READY) {
    await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
  } else {
    await esbuild.build(extensionBuild);
  }
  // sql.js 的 wasm 二进制拷进 dist，运行时用 locateFile 指向它
  const wasmSrc = require.resolve("sql.js/dist/sql-wasm.wasm");
  fs.copyFileSync(wasmSrc, path.join(__dirname, "dist", "sql-wasm.wasm"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});