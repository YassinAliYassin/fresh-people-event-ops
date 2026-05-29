const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");
const sqlite3 = require("sqlite3").verbose();
const basicAuth = require("express-basic-auth");

const app = express();
const PORT = 3004;
const EVENTS_DIR = "/home/yassin/fresh-people-event-ops/calendar-events";
const DB_PATH = "/home/yassin/fresh-people-event-ops/events.db";

// Password protection - ONLY Yassin
const auth = basicAuth({
    users: { 'yassin': 'FreshPeople2026!' },
    challenge: true,
    realm: 'Fresh People Ops - Private Access'
});

// Apply auth to ALL routes
app.use(auth);

const STAFF_POOL = ["Mike", "Alex", "John", "Sipho", "Ben", "David", "Thabo", "Kevin"];

const WHATSAPP_TOKEN = "EAAW5l0R09ZCkBRtnTRodFTZAUZACZCct6XY91O1oAmOYMaoFhmrAp1ROJOiSnGwEKCMSFTHXNoULbBw3CuKb60oZCVA8d5dTNGKD5oiW89NfjTAAQmE9ysbMsod6RS4V8mUwzYm0DZBSQ1rYhVk8fXG9yoAD57BK2JzO7PC3qNM8Md2lM1Rz1Va8DRKTHqbqIZD";
const PHONE_NUMBER_ID = "106073502372079";

// SQLite DB helper
function getDB() {
    return new sqlite3.Database(DB_PATH);
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

async function generateEventID() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0,10).replace(/-/g, "");
    const files = await fs.readdir(EVENTS_DIR);
    const todayCount = files.filter(f => f.startsWith("FP-" + dateStr)).length;
    return "FP-" + dateStr + "-" + String(todayCount + 1).padStart(3, "0");
}

function generateICS(ev) {
    let start = ev.time, end = "18:00";
    if (ev.time.includes("-")) {
        const parts = ev.time.split("-").map(s => s.trim());
        start = parts[0]; end = parts[1];
    }
    const fmt = t => t.replace(":", "") + "00";
    return "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Fresh People//EN\nBEGIN:VEVENT\nUID:" + ev.id + "@fresh-people.co.za\nDTSTAMP:" + new Date().toISOString().replace(/[-:]/g,"").slice(0,15) + "Z\nDTSTART:" + ev.date.replace(/-/g,"") + "T" + fmt(start) + "\nDTEND:" + ev.date.replace(/-/g,"") + "T" + fmt(end) + "\nSUMMARY:" + ev.event + " – " + ev.client + "\nDESCRIPTION:Client: " + ev.client + "\\nStaff: " + ev.staff.join(", ") + "\\nDress: All Black\\nArrival: " + ev.arrivalTime + "\nLOCATION:" + ev.location + "\nEND:VEVENT\nEND:VCALENDAR";
}

app.post("/api/events", async (req, res) => {
    try {
        const { event, client, date, time, location, services, staffRequired } = req.body;
        if (!event || !client || !date || !time || !location) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const max = parseInt(staffRequired) || STAFF_POOL.length;
        const staff = STAFF_POOL.slice(0, Math.min(max, STAFF_POOL.length));
        const arrivalRaw = time.includes("-") ? time.split("-")[0].trim() : time;
        const arrH = parseInt(arrivalRaw.split(":")[0]) - 1;
        const arrival = String(arrH).padStart(2,"0") + ":" + (arrivalRaw.split(":")[1] || "00");
        const id = await generateEventID();
        const ev = { id, event, client, date, time, location, services: services||"", staff, leader: staff[0], arrivalTime: arrival, created_at: new Date().toISOString(), status: "confirmed" };
        await fs.writeFile(path.join(EVENTS_DIR, id + ".json"), JSON.stringify(ev, null, 2));
        await fs.writeFile(path.join(EVENTS_DIR, id + ".ics"), generateICS(ev));
        res.json({ success: true, event: ev });
    } catch(e) {
        console.error("Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/events", async (req, res) => {
    try {
        const files = await fs.readdir(EVENTS_DIR);
        const events = [];
        for (const f of files) {
            if (f.endsWith(".json")) {
                try {
                    const data = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, f), "utf8"));
                    events.push({ id: data.id||f.replace(".json",""), event: data.event||"", client: data.client||"", date: data.date||"", time: data.time||"", location: data.location||"", staff: data.staff||[], leader: data.leader||"", created_at: data.created_at||"" });
                } catch(e) {}
            }
        }
        res.json(events);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, "0.0.0.0", () => console.log("Fresh People Ops running on :" + PORT));

// Templates API
app.get("/api/templates", (req, res) => {
    const db = getDB();
    db.all("SELECT * FROM event_templates ORDER BY name", [], (err, rows) => {
        db.close();
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get("/api/templates/:id", (req, res) => {
    const db = getDB();
    db.get("SELECT * FROM event_templates WHERE id = ?", [req.params.id], (err, row) => {
        db.close();
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Template not found" });
        res.json(row);
    });
});
