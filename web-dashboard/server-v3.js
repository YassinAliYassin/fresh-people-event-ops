const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3004;
const DB_PATH = path.join(__dirname, '..', 'events.db');
const CALENDAR_DIR = path.join(__dirname, '..', 'calendar-events');

app.use(bodyParser.json());
app.use(express.static('public'));

// Initialize DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err);
  else console.log('Connected to SQLite DB');
});

// Helper: Generate event ID
async function generateEventID(dateStr) {
  const dateObj = new Date(dateStr);
  const yyyymmdd = dateObj.toISOString().slice(0,10).replace(/-/g,'');
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id FROM events WHERE id LIKE ? ORDER BY id DESC LIMIT 1`,
      [`FP-${yyyymmdd}-%`],
      (err, rows) => {
        if (err) return reject(err);
        let num = 1;
        if (rows.length) {
          const last = rows[0].id;
          num = parseInt(last.split('-')[2]) + 1;
        }
        resolve(`FP-${yyyymmdd}-${String(num).padStart(3,'0')}`);
      }
    );
  });
}

// Helper: Generate ICS
function generateICS(event) {
  const dtStart = new Date(`${event.date}T${event.time}`).toISOString().replace(/[-:]/g,'').slice(0,15);
  const endTime = new Date(`${event.date}T${event.time}`);
  endTime.setHours(endTime.getHours() + 4);
  const dtEnd = endTime.toISOString().replace(/[-:]/g,'').slice(0,15);
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Fresh People//Event//EN\nBEGIN:VEVENT\nUID:${event.id}@fresh-people.co.za\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}\nDTSTART:${dtStart}\nDTEND:${dtEnd}\nSUMMARY:${event.event}\nLOCATION:${event.location}\nDESCRIPTION:Client: ${event.client}\\nServices: ${event.services}\\nTeam: ${event.staff.join(', ')}\\nNotes: ${event.notes}\nEND:VEVENT\nEND:VCALENDAR`;
}

// GET /api/events
app.get('/api/events', (req, res) => {
  db.all(`SELECT * FROM events ORDER BY date DESC, time DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// POST /api/events
app.post('/api/events', async (req, res) => {
  try {
    const { event, date, time, location, client, services, staff, notes } = req.body;
    const id = await generateEventID(date);
    const staffJSON = JSON.stringify(staff || []);
    const notesText = notes || `Dress Code: All Black\nArrival Time: ${parseInt(time.split(':')[0])-1}:${time.split(':')[1]}`;
    db.run(
      `INSERT INTO events (id, event, date, time, location, client, services, staff, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, event, date, time, location, client, services, staffJSON, notesText],
      async function(err) {
        if (err) return res.status(500).json({error: err.message});
        const newEvent = {id, event, date, time, location, client, services, staff: JSON.parse(staffJSON), notes: notesText};
        const icsContent = generateICS(newEvent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(newEvent, null, 2));
        res.json(newEvent);
      }
    );
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// PUT /api/events/:id (update event)
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

// DELETE /api/events/:id
app.delete('/api/events/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM events WHERE id=?`, [id], async function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
    // Delete files
    try { await fs.unlink(path.join(CALENDAR_DIR, `${id}.ics`)); } catch(e) {}
    try { await fs.unlink(path.join(CALENDAR_DIR, `${id}.json`)); } catch(e) {}
    res.json({success: true, id});
  });
});

// GET /api/staff
app.get('/api/staff', (req, res) => {
  db.all(`SELECT * FROM staff WHERE active=1 ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// PUT /api/staff/:id (toggle active)
app.put('/api/staff/:id', (req, res) => {
  const { active } = req.body;
  db.run(`UPDATE staff SET active=? WHERE id=?`, [active ? 1 : 0, req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({success: true, id: req.params.id, active});
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fresh People Event Ops v3.0 running on http://0.0.0.0:${PORT}`);
});

// Error handlers to keep server alive
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
