const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const basicAuth = require('express-basic-auth');

const app = express();
const PORT = 3004;
const DB_PATH = path.join(__dirname, '..', 'events.db');
const CALENDAR_DIR = path.join(__dirname, '..', 'calendar-events');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

app.use(bodyParser.json());

// Basic Auth for dashboard protection
const authUsers = {};
const authUser = process.env.DASHBOARD_USER || 'admin';
const authPass = process.env.DASHBOARD_PASS || 'freshpeople2026';
authUsers[authUser] = authPass;

app.use(basicAuth({
    users: authUsers,
    challenge: true,
    realm: 'Fresh People Event Ops',
    unauthorizedResponse: () => 'Unauthorized - Invalid credentials'
}));
app.use(express.static(path.join(__dirname, 'public')));

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

// GET /api/analytics - comprehensive analytics
app.get('/api/analytics', (req, res) => {
  db.all(`SELECT * FROM events`, [], (err, events) => {
    if (err) return res.status(500).json({error: err.message});

    // Status breakdown
    const statusCounts = { pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
    events.forEach(e => { const s = e.status || 'pending'; if (statusCounts[s] !== undefined) statusCounts[s]++; });

    // Events by month
    const byMonth = {};
    events.forEach(e => { const m = e.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });

    // Events by week (current 12 weeks)
    const now = new Date();
    const weeks = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i * 7);
      const weekStart = new Date(d); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      weeks[key] = 0;
    }
    events.forEach(e => {
      const eDate = new Date(e.date);
      const weekStart = new Date(eDate); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      if (weeks[key] !== undefined) weeks[key]++;
    });

    // Location frequency
    const locationCounts = {};
    events.forEach(e => { locationCounts[e.location] = (locationCounts[e.location] || 0) + 1; });
    const topLocations = Object.entries(locationCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Client frequency
    const clientCounts = {};
    events.forEach(e => { if (e.client) clientCounts[e.client] = (clientCounts[e.client] || 0) + 1; });
    const topClients = Object.entries(clientCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Staff utilization (events per staff member)
    const staffEventCounts = {};
    events.forEach(e => {
      const staffList = JSON.parse(e.staff || '[]');
      staffList.forEach(s => { staffEventCounts[s] = (staffEventCounts[s] || 0) + 1; });
    });
    const staffUtilization = Object.entries(staffEventCounts).sort((a, b) => b[1] - a[1]);

    // Average events per week (last 4 weeks)
    const recentWeekCounts = Object.entries(weeks).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 4).map(v => v[1]);
    const avgPerWeek = recentWeekCounts.length > 0 ? (recentWeekCounts.reduce((a, b) => a + b, 0) / recentWeekCounts.length).toFixed(1) : 0;

    // Upcoming count (next 7 days)
    const today = now.toISOString().slice(0, 10);
    const nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().slice(0, 10);
    const upcomingCount = events.filter(e => e.date >= today && e.date <= nextWeekStr && (e.status !== 'cancelled')).length;

    res.json({
      summary: {
        total: events.length,
        upcoming7days: upcomingCount,
        avgEventsPerWeek: parseFloat(avgPerWeek),
        statusCounts,
        topLocation: topLocations[0] ? topLocations[0][0] : 'N/A',
        topClient: topClients[0] ? topClients[0][0] : 'N/A',
      },
      byMonth: Object.entries(byMonth).sort((a, b) => a[0] < b[0] ? -1 : 1),
      byWeek: Object.entries(weeks).sort((a, b) => a[0] < b[0] ? -1 : 1),
      topLocations,
      topClients,
      staffUtilization,
    });
  });
});

// DELETE /api/templates/:id
app.delete('/api/templates/:id', (req, res) => {
  db.run(`DELETE FROM event_templates WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Template not found'});
    res.json({ success: true, id: req.params.id });
  });
});

// GET /api/export/csv - Export events as CSV
app.get('/api/export/csv', (req, res) => {
  const { status, from, to } = req.query;
  let query = `SELECT * FROM events WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { query += ` AND (status = ? OR (status IS NULL AND ? = 'pending'))`; params.push(status, status); }
  if (from) { query += ` AND date >= ?`; params.push(from); }
  if (to) { query += ` AND date <= ?`; params.push(to); }
  query += ` ORDER BY date, time`;
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const headers = ['ID', 'Event', 'Date', 'Time', 'Location', 'Client', 'Services', 'Staff', 'Status', 'Notes'];
    const csvRows = [headers.join(',')];
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]').join('; ');
      const cols = [
        r.id,
        `"${(r.event || '').replace(/"/g, '""')}"`,
        r.date,
        r.time,
        `"${(r.location || '').replace(/"/g, '""')}"`,
        `"${(r.client || '').replace(/"/g, '""')}"`,
        `"${(r.services || '').replace(/"/g, '""')}"`,
        `"${staffList.replace(/"/g, '""')}"`,
        r.status || 'pending',
        `"${(r.notes || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
      ];
      csvRows.push(cols.join(','));
    });
    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="fresh-people-events-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  });
});

// GET /api/export/pdf - Export event(s) as PDF
app.get('/api/export/pdf', (req, res) => {
  const { id, status, from, to } = req.query;
  let query = `SELECT * FROM events WHERE 1=1`;
  const params = [];

  if (id) { query += ` AND id = ?`; params.push(id); }
  if (status && status !== 'all') { query += ` AND (status = ? OR (status IS NULL AND ? = 'pending'))`; params.push(status, status); }
  if (from) { query += ` AND date >= ?`; params.push(from); }
  if (to) { query += ` AND date <= ?`; params.push(to); }
  query += ` ORDER BY date, time`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows.length === 0) return res.status(404).json({ error: 'No events found' });

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const isSingle = !!id;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${isSingle ? 'event-' + id : 'fresh-people-events'}-${new Date().toISOString().slice(0,10)}.pdf"`);
    doc.pipe(res);

    // Title
    doc.fontSize(24).font('Helvetica-Bold').text('Fresh People Event Ops', { align: 'center' });
    doc.fontSize(14).font('Helvetica').text(isSingle ? 'Event Details' : 'Events Report', { align: 'center' });
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    // Summary for multi-event
    if (!isSingle) {
      doc.fontSize(12).font('Helvetica-Bold').text(`Total Events: ${rows.length}`);
      const statusCounts = { pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
      rows.forEach(r => { const s = r.status || 'pending'; if (statusCounts[s] !== undefined) statusCounts[s]++; });
      doc.fontSize(10).font('Helvetica').text(`Pending: ${statusCounts.pending} | Confirmed: ${statusCounts.confirmed} | Cancelled: ${statusCounts.cancelled} | Completed: ${statusCounts.completed}`);
      doc.moveDown(2);
    }

    // Events
    rows.forEach((r, idx) => {
      if (idx > 0) doc.addPage();

      const staffList = JSON.parse(r.staff || '[]');
      const statusLabel = (r.status || 'pending').toUpperCase();

      // Event header with status color
      doc.fontSize(16).font('Helvetica-Bold').text(`${r.event}`, { continued: false });
      doc.fontSize(9).font('Helvetica').fillColor(statusLabel === 'CONFIRMED' ? '#10b981' : statusLabel === 'CANCELLED' ? '#ef4444' : statusLabel === 'COMPLETED' ? '#3b82f6' : '#f59e0b').text(`Status: ${statusLabel}`);
      doc.fillColor('#000000');
      doc.moveDown(0.5);

      // Details table
      doc.fontSize(11).font('Helvetica');
      const details = [
        ['Event ID', r.id],
        ['Date', r.date],
        ['Time', r.time],
        ['Location', r.location],
        ['Client', r.client || 'N/A'],
        ['Services', r.services || 'N/A'],
        ['Assigned Staff', staffList.join(', ') || 'None'],
      ];

      details.forEach(([label, value]) => {
        doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
        doc.font('Helvetica').text(String(value || 'N/A'));
      });

      if (r.notes) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').text('Notes:', { continued: true });
        doc.font('Helvetica').text(r.notes);
      }

      // Staff list box
      if (staffList.length > 0) {
        doc.moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Staff Assignment');
        doc.moveDown(0.5);
        staffList.forEach(s => {
          doc.fontSize(10).font('Helvetica').text(`• ${s}`);
        });
      }
    });

    doc.end();
  });
});

// GET /api/staff-timeline - Staff allocation timeline
app.get('/api/staff-timeline', (req, res) => {
  db.all(`SELECT id, event, date, time, location, staff, status FROM events WHERE status != 'cancelled' ORDER BY date, time`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const staffMap = {};
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      staffList.forEach(name => {
        if (!staffMap[name]) staffMap[name] = [];
        staffMap[name].push({
          eventId: r.id,
          event: r.event,
          date: r.date,
          time: r.time,
          location: r.location,
          status: r.status || 'pending'
        });
      });
    });
    // Sort each staff's events by date/time
    Object.keys(staffMap).forEach(name => {
      staffMap[name].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    });
    res.json(staffMap);
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Fresh People Event Ops', version: '4.5.0', timestamp: new Date().toISOString() });
});

// POST /api/events/recurring - create recurring events
app.post('/api/events/recurring', async (req, res) => {
  try {
    const { event, startDate, endDate, time, location, client, services, staff, notes, frequency } = req.body;
    if (!event || !startDate || !endDate || !time) {
      return res.status(400).json({ error: 'Event name, startDate, endDate, and time are required' });
    }

    const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly'];
    const freq = frequency || 'weekly';
    if (!validFrequencies.includes(freq)) {
      return res.status(400).json({ error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}` });
    }

    const createdEvents = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    const staffList = staff || [];

    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      const id = await generateEventID(dateStr);
      const activeStaffCount = await getActiveStaffCount();
      const warnings = [];
      if (staffList.length > activeStaffCount) {
        warnings.push(`Staff shortage: ${staffList.length} requested but only ${activeStaffCount} active`);
      }
      const staffJSON = JSON.stringify(staffList);
      const notesText = notes || `Dress Code: All Black\nArrival Time: ${parseInt(time.split(':')[0]) - 1}:${time.split(':')[1]}`;
      const fullNotes = warnings.length > 0 ? `${notesText}\n\n⚠️ WARNINGS:\n${warnings.join('\n')}` : notesText;

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO events (id, event, date, time, location, client, services, staff, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
          [id, event, dateStr, time, location, client, services, staffJSON, fullNotes],
          function(err) {
            if (err) return reject(err);
            createdEvents.push({ id, event, date: dateStr, time, location, client, services, staff: staffList, notes: fullNotes });
            resolve();
          }
        );
      });

      // Advance to next occurrence
      if (freq === 'daily') current.setDate(current.getDate() + 1);
      else if (freq === 'weekly') current.setDate(current.getDate() + 7);
      else if (freq === 'biweekly') current.setDate(current.getDate() + 14);
      else if (freq === 'monthly') current.setMonth(current.getMonth() + 1);
    }

    // Create calendar files for each
    for (const evt of createdEvents) {
      try {
        const icsContent = generateICS(evt);
        await fs.writeFile(path.join(CALENDAR_DIR, `${evt.id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${evt.id}.json`), JSON.stringify(evt, null, 2));
      } catch (e) { console.error('Calendar file error:', e); }
    }

    // Auto-backup after batch creation
    try { await backupDatabase(); } catch (e) { console.error('Backup failed:', e); }

    res.json({ success: true, count: createdEvents.length, events: createdEvents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fresh People Event Ops v4.5 running on http://0.0.0.0:${PORT}`);
});
