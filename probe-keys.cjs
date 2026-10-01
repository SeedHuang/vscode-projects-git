// 列出 Code state.vscdb 里所有 key
const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const src = `${process.env.APPDATA}\\Code\\User\\globalStorage\\state.vscdb`;
  const buf = fs.readFileSync(src);
  const db = new SQL.Database(buf);
  const stmt = db.prepare("SELECT key FROM ItemTable ORDER BY key");
  while (stmt.step()) console.log(stmt.get()[0]);
  stmt.free();
  db.close();
})();