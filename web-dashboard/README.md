# Fresh People Event Operations System

## Overview
Automated event management system for Fresh People events with:
- SQLite database backend (`events.db`)
- Web dashboard (used by staff + client self-service portal)
- Auto staff assignment
- Calendar export (.ics)
- WhatsApp API integration (Meta)

The canonical dashboard server is **`server-v4.js`** (v4.45). It is
env-driven: it honours `PORT`, `PROJECT_ROOT`, `EVENTS_DB`, and
`CALENDAR_EVENTS_DIR` with safe defaults, and resolves credentials from
the environment (no secrets in source).

## Features
✅ Event creation with auto-staff assignment
✅ Staff pool management
✅ Calendar export (.ics files)
✅ SQLite database (events + staff + shifts tables)
✅ REST API (events, staff, shifts, reports endpoints)
✅ Web dashboard with stats + live WebSocket updates
✅ Auto event ID generation (FP-YYYYMMDD-NNN)
✅ Arrival time calculation (1hr before event)
✅ Client self-service portal + deployment messages
✅ Report scheduling & post-event reports (PDF)

## Access
- **Web Dashboard**: `http://localhost:${PORT}` (default `PORT=3004`)
- **API Base**: `http://localhost:3004/api/`

Set `DASHBOARD_USER` / `DASHBOARD_PASS` (or rely on the env default and
override via env) for the basic-auth login.

## API Endpoints (subset)
- `GET  /api/events` - List all events
- `POST /api/events` - Create new event
- `GET  /api/staff` - List active staff
- `GET  /api/staffing/overview` - Staffing overview
- `GET  /api/shifts/calendar` - Shift calendar

## File Structure
```
web-dashboard/
├── server-v4.js        (canonical dashboard server, v4.45)
├── public/
│   ├── index.html      (web dashboard)
│   ├── login.html
│   ├── event-day.html
│   └── client-portal.html
├── package.json
└── node_modules/       (gitignored; install via `npm ci`)

../events.db              (SQLite database, gitignored)
../calendar-events/       (generated .ics/.json, gitignored)
```

## Start/Stop
The dashboard is started by the repo's orchestration scripts:
- `../start-event-ops.sh` (launches `server-v4.js` on `PORT=3004`)
- `../ecosystem.config.js` (PM2: dashboard + API + WhatsApp bot)

Manual start:
```bash
cd web-dashboard
PORT=3004 npm start          # resolves to node server-v4.js
# or directly:
node server-v4.js
```

## Notes
- Older server variants (`server.js`, `server-v2.js`, `server-v3.js`)
  are deprecated/orphaned and are not launched by any script or config.
  `server-v4.js` is the only supported dashboard entry point.
- `web-dashboard` is a separate npm project; install deps with
  `npm ci` (reproducible) in this directory.

Built autonomously by Hermes AI.
