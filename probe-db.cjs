// 一次性脚本：读 Trae CN state.vscdb 看最近项目表
const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const src = process.env.TRAE_DB || `${process.env.APPDATA}\\Trae CN\\User\\globalStorage\\state.vscdb`;
  const buf = fs.readFileSync(src);
  const db = new SQL.Database(buf);
  const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
  stmt.bind(["history.recentlyOpenedPathsList"]);
  let row = null;
  if (stmt.step()) row = stmt.get()[0];
  stmt.free();
  db.close();
  if (!row) { console.log("NO ROW for key"); return; }
  const obj = JSON.parse(row);
  const entries = obj.entries || [];
  console.log(`entries count: ${entries.length}`);
  entries.slice(0, 10).forEach((e, i) => {
    console.log(i, JSON.stringify({
      folderUri: e.folderUri,
      fileUri: e.fileUri,
      workspace: e.workspace,
      lastUsed: e.lastUsed,
    }));
  });
})();