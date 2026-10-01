// 完整模拟插件里的 DiscoveryWorker 逻辑
const initSqlJs = require('sql.js');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

function uriToPath(uri) {
  if (!uri || !uri.startsWith("file://")) return null;
  const url = new URL(uri);
  let p = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:\//.test(p)) {
    p = p.slice(1).replace(/\//g, "\\");
  }
  if (p.toLowerCase().endsWith(".code-workspace")) {
    p = p.slice(0, -".code-workspace".length);
  }
  return p;
}

(async () => {
  const SQL = await initSqlJs();
  const tmp = path.join(os.tmpdir(), `vscode-recent-${Date.now()}.db`);
  await fsp.copyFile(`${process.env.APPDATA}\\Trae CN\\User\\globalStorage\\state.vscdb`, tmp);
  const buf = await fsp.readFile(tmp);
  const db = new SQL.Database(buf);
  const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
  stmt.bind(["history.recentlyOpenedPathsList"]);
  const raw = stmt.step() ? stmt.get()[0] : null;
  stmt.free();
  db.close();
  await fsp.unlink(tmp).catch(() => {});
  if (!raw) { console.log("NO RAW"); return; }
  const parsed = JSON.parse(raw);
  console.log(`parsed entries: ${(parsed.entries || []).length}`);

  let totalFiltered = { notUri: 0, notExists: 0, notGit: 0, dup: 0, kept: 0 };
  const seen = new Set();
  for (const e of parsed.entries || []) {
    const candidate = uriToPath(e.folderUri ?? "") ?? uriToPath(e.workspace?.configPath ?? "") ?? null;
    if (!candidate) { totalFiltered.notUri++; continue; }
    const exists = await fsp.access(candidate).then(() => true, () => false);
    if (!exists) { totalFiltered.notExists++; console.log("NOT EXISTS:", candidate); continue; }
    const isGit = await fsp.access(path.join(candidate, ".git")).then(() => true, () => false);
    if (!isGit) { totalFiltered.notGit++; console.log("NOT GIT:", candidate); continue; }
    const real = await fsp.realpath(candidate);
    const key = real.toLowerCase();
    if (seen.has(key)) { totalFiltered.dup++; continue; }
    seen.add(key);
    totalFiltered.kept++;
  }
  console.log("result:", totalFiltered);
})();