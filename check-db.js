var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('/home/yassin/fresh-people-event-ops/events.db');
db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", function(e, r) {
  if (e) { console.error(e.message); process.exit(1); }
  console.log(r.length + ' tables:');
  r.forEach(function(t) { console.log(' - ' + t.name); });
  db.close();
});
