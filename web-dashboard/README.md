# Fresh People Event Operations System v2.0

## Overview
Automated event management system for Fresh People events with:
- SQLite database backend
- Web dashboard (3-col X-style design)
- Auto staff assignment
- Calendar export (.ics)
- WhatsApp API integration (Meta)

## Features
✅ Event creation with auto-staff assignment
✅ Staff pool management (8 default staff)
✅ Calendar export (.ics files)
✅ SQLite database (events + staff tables)
✅ REST API (events, staff endpoints)
✅ Web dashboard with stats
✅ Auto event ID generation (FP-YYYYMMDD-NNN)
✅ Arrival time calculation (1hr before event)

## Access
- **Web Dashboard**: http://197.185.136.142:3004
- **API Base**: http://197.185.136.142:3004/api/

## API Endpoints
- `GET /api/events` - List all events
- `POST /api/events` - Create new event
- `GET /api/staff` - List active staff

## File Structure
```
web-dashboard/
├── server-v2.js (main server with SQLite)
├── public/
│   └── index.html (web dashboard)
├── package.json
└── node_modules/

calendar-events/
├── *.json (event data)
└── *.ics (calendar files)

events.db (SQLite database)
```

## Start/Stop
```bash
# Start
cd /home/yassin/fresh-people-event-ops/web-dashboard
node server-v2.js

# Or use PM2 (recommended)
pm2 start server-v2.js --name fresh-people-ops
```

## Next Steps (v2.1+)
- [ ] Event editing/deletion
- [ ] Staff management UI
- [ ] WhatsApp notifications (when API fixed)
- [ ] Email notifications (when auth fixed)
- [ ] Calendar view
- [ ] Event search/filter
- [ ] Nginx reverse proxy
- [ ] PM2 process management
- [ ] Mobile PWA support

## Status
✅ Production ready (core features)
⚠️ WhatsApp API (blocked by security policy)
⚠️ Email (auth issues)
⚠️ Nginx (blocked by security policy)

Built autonomously by Hermes AI.
