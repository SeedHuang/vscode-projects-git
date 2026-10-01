// 完全复刻插件 extension.ts:138-162 里的 discover() 闭包，调用 sql.js 工厂
// 唯一不同：路径写死成 Trae CN
const initSqlJs = require('sql.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

(async () => {
  const dbPath = `${process.env.APPDATA}\\Trae CN\\User\\globalStorage\\state.vscdb`;
  console.log("dbPath:", dbPath);
  console.log("exists:", await fsp.access(dbPath).then(() => true, () => false));

  const sqlFactory = () => initSqlJs({
    locateFile: (f) => path.join(__dirname, 'dist', f),
  });
  const tmpCopy = async (_file) => {
    const t = path.join(os.tmpdir(), `vscode-recent-${randomUUID()}.db`);
    await fsp.copyFile(dbPath, t);
    return t;
  };

  // ---- DiscoveryWorker 等价代码 ----
  function uriToPath(uri) {
    if (!uri || !uri.startsWith("file://")) return null;
    const url = new URL(uri);
    let p = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1).replace(/\//g, "\\");
    if (p.toLowerCase().endsWith(".code-workspace")) p = p.slice(0, -".code-workspace".length);
    return p;
  }

  const tmpPath = await tmpCopy("state.vscdb");
  try {
    const buf = await fsp.readFile(tmpPath);
    const SQL = await sqlFactory();
    const db = new SQL.Database(buf);
    let raw = null;
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
    stmt.bind(["history.recentlyOpenedPathsList"]);
    if (stmt.step()) raw = stmt.get()[0];
    stmt.free();
    db.close();
    if (!raw) { console.log("NO ROW"); return; }
    const parsed = JSON.parse(raw);
    const seen = new Set();
    const out = [];
    let rank = 0;
    for (const e of parsed.entries || []) {
      const candidate = uriToPath(e.folderUri ?? "") ?? uriToPath(e.workspace?.configPath ?? "") ?? null;
      if (!candidate) continue;
      if (!(await fsp.access(candidate).then(() => true, () => false))) continue;
      if (!(await fsp.access(path.join(candidate, ".git")).then(() => true, () => false))) continue;
      const real = await fsp.realpath(candidate);
      const key = real.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: real, rank: rank++, lastUsed: e.lastUsed });
    }
    console.log("DISCOVERED count:", out.length);
    out.forEach(p => console.log("  -", p.path));
  } finally {
    await fsp.unlink(tmpPath).catch(() => {});
  }
})().catch(e => { console.error("ERR:", e); process.exit(1); });