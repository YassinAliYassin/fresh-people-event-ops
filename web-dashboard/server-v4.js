const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3004;
const DB_PATH = path.join(__dirname, '..', 'events.db');
const CALENDAR_DIR = path.join(__dirname, '..', 'calendar-events');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

app.use(bodyParser.json());
app.use(express.static('public'));

// Initialize DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err);
  else console.log('Connected to SQLite DB');
});

// Ensure backup directory exists
fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});

// Helper: Generate event ID
async function generateEventID(dateStr) {
  const dateObj = new Date(dateStr);
  const yyyymmdd = dateObj.toISOString().slice(0,10).replace(/-/g,'');
  return new Promise((resolve, reject) => {
    db.all(`SELECT id FROM events WHERE id LIKE ? ORDER BY id DESC LIMIT 1`, [`FP-${yyyymmdd}-%`], (err, rows) => {
      if (err) return reject(err);
      let num = 1;
      if (rows.length) {
        const last = rows[0].id;
        num = parseInt(last.split('-')[2]) + 1;
      }
      resolve(`FP-${yyyymmdd}-${String(num).padStart(3,'0')}`);
    });
  });
}

// Helper: Get active staff count
async function getActiveStaffCount() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as count FROM staff WHERE active=1`, (err, row) => {
      if (err) return reject(err);
      resolve(row.count);
    });
  });
}

// Helper: Generate ICS
function generateICS(event) {
  const dtStart = new Date(`${event.date}T${event.time}`).toISOString().replace(/[-:]/g,'').slice(0,15);
  const endTime = new Date(`${event.date}T${event.time}`);
  endTime.setHours(endTime.getHours() + 4);
  const dtEnd = endTime.toISOString().replace(/[-:]/g,'').slice(0,15);
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Fresh People//Event//EN\nBEGIN:VEVENT\nUID:${event.id}@fresh-people.co.za\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}\nDTSTART:${dtStart}\nDTEND:${dtEnd}\nSUMMARY:${event.event}\nLOCATION:${event.location}\nDESCRIPTION:Client: ${event.client}\\nServices: ${event.services}\\nTeam: ${(event.staff || []).join(', ')}\\nNotes: ${event.notes}\nEND:VEVENT\nEND:VCALENDAR`;
}

// Helper: Backup database
async function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `events-backup-${timestamp}.db`);
  await fs.copyFile(DB_PATH, backupPath);
  // Keep only last 30 backups
  const files = (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('events-backup-')).sort();
  while (files.length > 30) {
    await fs.unlink(path.join(BACKUP_DIR, files.shift()));
  }
  return backupPath;
}

// GET /api/events
app.get('/api/events', (req, res) => {
  db.all(`SELECT * FROM events ORDER BY date DESC, time DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// POST /api/events (with staff shortage warning)
app.post('/api/events', async (req, res) => {
  try {
    const { event, date, time, location, client, services, staff, notes } = req.body;
    const id = await generateEventID(date);
    const staffList = staff || [];
    const activeStaffCount = await getActiveStaffCount();
    const warnings = [];
    
    if (staffList.length > activeStaffCount) {
      warnings.push(`Staff shortage: ${staffList.length} requested but only ${activeStaffCount} active`);
    }
    
    const staffJSON = JSON.stringify(staffList);
    const notesText = notes || `Dress Code: All Black\nArrival Time: ${parseInt(time.split(':')[0])-1}:${time.split(':')[1]}`;
    const fullNotes = warnings.length > 0 ? `${notesText}\n\n⚠️ WARNINGS:\n${warnings.join('\n')}` : notesText;
    
    db.run(
      `INSERT INTO events (id, event, date, time, location, client, services, staff, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, event, date, time, location, client, services, staffJSON, fullNotes],
      async function(err) {
        if (err) return res.status(500).json({error: err.message});
        const newEvent = {id, event, date, time, location, client, services, staff: staffList, notes: fullNotes, warnings};
        const icsContent = generateICS(newEvent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(newEvent, null, 2));
        // Auto-backup on event creation
        try { await backupDatabase(); } catch(e) { console.error('Backup failed:', e); }
        res.json(newEvent);
      }
    );
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', (req, res) => {
  const { event, date, time, location, client, services, staff, notes } = req.body;
  const id = req.params.id;
  const staffJSON = JSON.stringify(staff || []);
  db.run(
    `UPDATE events SET event=?, date=?, time=?, location=?, client=?, services=?, staff=?, notes=? WHERE id=?`,
    [event, date, time, location, client, services, staffJSON, notes, id],
    async function(err) {
      if (err) return res.status(500).json({error: err.message});
      if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
      const updatedEvent = {id, event, date, time, location, client, services, staff: JSON.parse(staffJSON), notes};
      const icsContent = generateICS(updatedEvent);
      await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
      await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(updatedEvent, null, 2));
      res.json(updatedEvent);
    }
  );
});

// PATCH /api/events/:id/status - Update event status
app.patch('/api/events/:id/status', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`});
  }
  const id = req.params.id;
  db.run(`UPDATE events SET status=? WHERE id=?`, [status, id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
    res.json({ success: true, id, status });
  });
});

// DELETE /api/events/:id
app.delete('/api/events/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM events WHERE id=?`, [id], async function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
    try { await fs.unlink(path.join(CALENDAR_DIR, `${id}.ics`)); } catch(e) {}
    try { await fs.unlink(path.join(CALENDAR_DIR, `${id}.json`)); } catch(e) {}
    res.json({success: true, id});
  });
});

// GET /api/staff
app.get('/api/staff', (req, res) => {
  db.all(`SELECT * FROM staff ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// POST /api/staff - add new staff member
app.post('/api/staff', (req, res) => {
  const { name, phone, role } = req.body;
  if (!name) return res.status(400).json({error: 'Name is required'});
  db.run(`INSERT INTO staff (name, phone, role, active) VALUES (?, ?, ?, 1)`, [name, phone || null, role || 'staff'], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ id: this.lastID, name, phone: phone || null, role: role || 'staff', active: 1 });
  });
});

// PUT /api/staff/:id - update staff (including phone)
app.put('/api/staff/:id', (req, res) => {
  const { name, phone, role, active } = req.body;
  const id = req.params.id;
  db.run(
    `UPDATE staff SET name=?, phone=?, role=?, active=? WHERE id=?`,
    [name, phone || null, role || 'staff', active ? 1 : 0, id],
    function(err) {
      if (err) return res.status(500).json({error: err.message});
      if (this.changes === 0) return res.status(404).json({error: 'Staff not found'});
      res.json({ success: true, id, name, phone, role, active: active ? 1 : 0 });
    }
  );
});

// DELETE /api/staff/:id
app.delete('/api/staff/:id', (req, res) => {
  db.run(`DELETE FROM staff WHERE id=?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ success: true, id: req.params.id });
  });
});

// GET /api/calendar (simple calendar view data)
app.get('/api/calendar', (req, res) => {
  db.all(`SELECT id, event, date, time, location, status FROM events ORDER BY date, time`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// GET /api/templates - list all event templates
app.get('/api/templates', (req, res) => {
  db.all(`SELECT * FROM event_templates ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// GET /api/templates/:id - get single template
app.get('/api/templates/:id', (req, res) => {
  db.get(`SELECT * FROM event_templates WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({error: err.message});
    if (!row) return res.status(404).json({error: 'Template not found'});
    res.json(row);
  });
});

// POST /api/templates - create new template
app.post('/api/templates', (req, res) => {
  const { name, description, default_duration_hours, pre_arrival_hours, dress_code, default_services, default_staff_count } = req.body;
  if (!name) return res.status(400).json({error: 'Name is required'});
  db.run(
    `INSERT INTO event_templates (name, description, default_duration_hours, pre_arrival_hours, dress_code, default_services, default_staff_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, description || '', default_duration_hours || 4, pre_arrival_hours || 1, dress_code || 'All Black', default_services || '', default_staff_count || 8],
    function(err) {
      if (err) return res.status(500).json({error: err.message});
      res.json({ id: this.lastID, name, description, default_duration_hours, pre_arrival_hours, dress_code, default_services, default_staff_count });
    }
  );
});

// GET /api/conflicts - check for booking conflicts
app.get('/api/conflicts', (req, res) => {
  db.all(`SELECT id, event, date, time, location, staff, status FROM events WHERE status != 'cancelled' OR status IS NULL`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    const eventsByDate = {};
    const conflicts = [];
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      if (!eventsByDate[r.date]) eventsByDate[r.date] = [];
      eventsByDate[r.date].push({ id: r.id, event: r.event, time: r.time, location: r.location, staff: staffList });
    });
    Object.entries(eventsByDate).forEach(([date, events]) => {
      if (events.length > 1) {
        const staffCounts = {};
        events.forEach(e => e.staff.forEach(s => { staffCounts[s] = (staffCounts[s] || 0) + 1; }));
        const doubleBooked = Object.entries(staffCounts).filter(([_, c]) => c > 1);
        if (doubleBooked.length > 0) {
          conflicts.push({ date, events, doubleBooked: Object.fromEntries(doubleBooked) });
        }
      }
    });
    res.json({ conflicts, hasConflicts: conflicts.length > 0 });
  });
});

// GET /api/alerts - get all alerts (conflicts + shortages + upcoming)
app.get('/api/alerts', (req, res) => {
  db.all(`SELECT * FROM events WHERE status != 'cancelled' OR status IS NULL ORDER BY date, time`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    
    const alerts = [];
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    
    // Check for staff shortages
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      if (r.notes && r.notes.includes('Staff shortage')) {
        alerts.push({
          type: 'shortage',
          severity: 'warning',
          eventId: r.id,
          event: r.event,
          date: r.date,
          time: r.time,
          message: `Staff shortage for "${r.event}" on ${r.date}`
        });
      }
      // Upcoming events (within 24h)
      if (r.date <= tomorrowStr && r.date >= now.toISOString().slice(0, 10)) {
        alerts.push({
          type: 'upcoming',
          severity: 'info',
          eventId: r.id,
          event: r.event,
          date: r.date,
          time: r.time,
          message: `Upcoming: "${r.event}" on ${r.date} at ${r.time}`
        });
      }
    });
    
    // Check for conflicts
    const eventsByDate = {};
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      if (!eventsByDate[r.date]) eventsByDate[r.date] = [];
      eventsByDate[r.date].push({ id: r.id, event: r.event, time: r.time, location: r.location, staff: staffList });
    });
    Object.entries(eventsByDate).forEach(([date, events]) => {
      if (events.length > 1) {
        const staffCounts = {};
        events.forEach(e => e.staff.forEach(s => { staffCounts[s] = (staffCounts[s] || 0) + 1; }));
        const doubleBooked = Object.entries(staffCounts).filter(([_, c]) => c > 1);
        if (doubleBooked.length > 0) {
          alerts.push({
            type: 'conflict',
            severity: 'critical',
            date,
            events,
            doubleBooked: Object.fromEntries(doubleBooked),
            message: `Conflict on ${date}: Staff ${doubleBooked.map(([s]) => s).join(', ')} double-booked`
          });
        }
      }
    });
    
    // Sort: critical first, then warning, then info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    
    res.json({ alerts, total: alerts.length, critical: alerts.filter(a => a.severity === 'critical').length });
  });
});

// POST /api/backup - manual backup trigger
app.post('/api/backup', async (req, res) => {
  try {
    const backupPath = await backupDatabase();
    res.json({ success: true, path: backupPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backups - list available backups
app.get('/api/backups', async (req, res) => {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('events-backup-')).sort().reverse();
    const backups = await Promise.all(files.map(async f => {
      const stat = await fs.stat(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, created: stat.mtime.toISOString() };
    }));
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Fresh People Event Ops', version: '4.1.0', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fresh People Event Ops v4.1 running on http://0.0.0.0:${PORT}`);
});
