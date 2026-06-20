var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('events.db');
db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", function(e, r) {
  if (e) { console.error("ERR:", e.message); process.exit(1); }
  console.log(r.map(function(t){return t.name}).join('\n'));
  db.close();
});
