const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, '..', 'events.db'));

const tables = ['events', 'staff', 'clients', 'equipment', 'venues', 'users', 'event_reviews', 'event_tasks', 'purchase_orders', 'staff_timesheets', 'documents', 'suppliers', 'event_templates', 'budgets'];
let i = 0;
function next() {
  if (i >= tables.length) { db.close(); return; }
  const t = tables[i++];
  db.get(`SELECT COUNT(*) as c FROM ${t}`, (e, r) => {
    console.log(`${t}: ${r ? r.c : 'N/A'}`);
    next();
  });
}
next();
