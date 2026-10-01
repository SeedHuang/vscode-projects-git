// 读 VSCode 自己的 state.vscdb
const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const src = `${process.env.APPDATA}\\Code\\User\\globalStorage\\state.vscdb`;
  console.log("reading:", src);
  const buf = fs.readFileSync(src);
  const db = new SQL.Database(buf);
  const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
  stmt.bind(["history.recentlyOpenedPathsList"]);
  const raw = stmt.step() ? stmt.get()[0] : null;
  stmt.free();
  db.close();
  if (!raw) { console.log("NO ROW"); return; }
  const obj = JSON.parse(raw);
  console.log(`entries: ${(obj.entries || []).length}`);
  (obj.entries || []).slice(0, 15).forEach((e, i) => {
    console.log(i, JSON.stringify({ folderUri: e.folderUri, workspace: e.workspace, lastUsed: e.lastUsed }));
  });
})();