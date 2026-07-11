const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const fetch = require("node-fetch");

const app = express();
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..');
const EVENTS_DB = process.env.EVENTS_DB || path.join(PROJECT_ROOT, 'events.db');

// Initialize SQLite DB
const db = new sqlite3.Database(EVENTS_DB, (err) => {
    if (err) console.error("DB error:", err);
    else console.log("✓ SQLite DB connected");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event TEXT, client TEXT, date TEXT, time TEXT, location TEXT,
        services TEXT, staff TEXT, leader TEXT, arrivalTime TEXT,
        created_at TEXT, status TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE, phone TEXT, role TEXT, active INTEGER DEFAULT 1
    )`);
    // Insert default staff
    const defaultStaff = ["Mike|leader", "Alex", "John", "Sipho", "Ben", "David", "Thabo", "Kevin"];
    defaultStaff.forEach(s => {
        const parts = s.split("|");
        db.run("INSERT OR IGNORE INTO staff (name, role) VALUES (?, ?)", [parts[0], parts[1] || "staff"]);
    });
});

// WhatsApp Cloud API creds are read from the environment (no secrets in source).
// Set WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID via env or .env (see .env.example).
const WHATSAPP_TOKEN = process.env.WA_ACCESS_TOKEN || 'PASTE_YOUR_TOKEN_HERE';
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || 'PASTE_YOUR_PHONE_NUMBER_ID';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

async function generateEventID() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0,10).replace(/-/g, "");
    return new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as cnt FROM events WHERE id LIKE ?", [`FP-${dateStr}-%`], (err, row) => {
            if (err) reject(err);
            else resolve(`FP-${dateStr}-${String((row.cnt || 0) + 1).padStart(3, "0")}`);
        });
    });
}

function generateICS(ev) {
    let start = ev.time, end = "18:00";
    if (ev.time.includes("-")) {
        const parts = ev.time.split("-").map(s => s.trim());
        start = parts[0]; end = parts[1];
    }
    const fmt = t => t.replace(":", "") + "00";
    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fresh People//EN
BEGIN:VEVENT
UID:${ev.id}@fresh-people.co.za
DTSTAMP:${new Date().toISOString().replace(/[-:]/g,"").slice(0,15)}Z
DTSTART:${ev.date.replace(/-/g,"")}T${fmt(start)}
DTEND:${ev.date.replace(/-/g,"")}T${fmt(end)}
SUMMARY:${ev.event} – ${ev.client}
DESCRIPTION:Client: ${ev.client}\\nStaff: ${ev.staff}\\nDress: All Black\\nArrival: ${ev.arrivalTime}
LOCATION:${ev.location}
END:VEVENT
END:VCALENDAR`;
}

app.post("/api/events", async (req, res) => {
    try {
        const { event, client, date, time, location, services, staffRequired } = req.body;
        if (!event || !client || !date || !time || !location) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        
        const staffList = await new Promise((resolve) => {
            db.all("SELECT name FROM staff WHERE active=1 LIMIT ?", [parseInt(staffRequired) || 8], (err, rows) => {
                resolve(rows.map(r => r.name));
            });
        });
        
        const arrivalRaw = time.includes("-") ? time.split("-")[0].trim() : time;
        const arrH = parseInt(arrivalRaw.split(":")[0]) - 1;
        const arrival = `${String(arrH).padStart(2,"0")}:${arrivalRaw.split(":")[1] || "00"}`;
        
        const id = await generateEventID();
        const ev = { id, event, client, date, time, location, services: services||"", staff: JSON.stringify(staffList), leader: staffList[0], arrivalTime: arrival, created_at: new Date().toISOString(), status: "confirmed" };
        
        db.run("INSERT INTO events (id, event, client, date, time, location, services, staff, leader, arrivalTime, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [id, event, client, date, time, location, ev.services, ev.staff, ev.leader, arrival, ev.created_at, ev.status]);
        
        const ics = generateICS(ev);
        const icsDir = process.env.CALENDAR_EVENTS_DIR || path.join(PROJECT_ROOT, 'calendar-events');
        await fs.writeFile(`${icsDir}/${id}.ics`, ics);
        
        res.json({ success: true, event: ev });
    } catch(e) {
        console.error("Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/events", (req, res) => {
    db.all("SELECT * FROM events ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const events = rows.map(r => ({ ...r, staff: JSON.parse(r.staff || "[]") }));
        res.json(events);
    });
});

app.get("/api/staff", (req, res) => {
    db.all("SELECT * FROM staff WHERE active=1", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✓ Fresh People Event Ops running on http://197.185.136.142:${PORT}`);
    console.log(`✓ SQLite DB: ${EVENTS_DB}`);
});
