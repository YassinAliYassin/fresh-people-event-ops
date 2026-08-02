# Audit — fresh-people-event-ops

**Audit date:** 2026-08-02 · **Auditor:** Hermes (Lead Staff Engineer)

## Overview

| Field | Value |
|-------|-------|
| Repo | `YassinAliYassin/fresh-people-event-ops` |
| Visibility | Public |
| Purpose | Automated event-booking & operations system for Fresh People |
| Stack | Node (Express, Baileys, Telegram bot) + Python 3 + SQLite + web dashboard |
| Primary language | JavaScript (10.6k LOC) + Python (0.5k) |
| Maturity | Functional prototype → needs production hardening |

## Purpose

Parses a WhatsApp-style booking message and emits, in one flow: an event ID, a
booking summary, an allocated staff team with leader, a Google-Calendar `.ics`
event, and a WhatsApp deployment message. Includes a web dashboard for event /
staff / expense CRUD and a WhatsApp Business API bot.

## Architecture

- `event_processor.py` — pure, dependency-free core (parse + allocate + generate).
- `server.js` — small Express API (`POST /process-booking`) + homepage + health.
- `web-dashboard/server-v4.js` — **8,500-line monolith**: auth, sessions, CRUD,
  PDF export (PDFKit), uploads (multer), email (nodemailer), web push.
- `whatsapp-api-bot.js` — WhatsApp Business API bot.
- Python support tools (`query.py`, `schema.py`, `cf_check.py`, …) and shell scripts.
- PM2 via `ecosystem.config.js`.

## Scorecard (0–10)

| Dimension | Score | Notes |
|-----------|:-----:|-------|
| Architecture | 4 | Good separation of Python core; dashboard is a single 8.5k-line monolith |
| Code quality | 5 | Readable, but duplicated logic and mixed Python/Node conventions |
| Security | 5 | API now hardened (rate limit, size limits, headers); dashboard auth is in-memory |
| Documentation | 4 | Basic README; no CONTRIBUTING/SECURITY/CHANGELOG before this pass |
| Maintainability | 4 | Monolith, hardcoded staff pool, no Docker |
| Performance | 6 | Fine for small scale; synchronous/file-IO paths improved |
| Developer experience | 5 | Good scripts + PM2; no Docker or typed dashboard |
| Business readiness | 4 | Works end-to-end, tested; needs auth/limits/observability to ship |

**Overall: 4.6 / 10** · **Business readiness: 4 / 10**

## High priority

1. Split the 8.5k-line `server-v4.js` into modular routers/controllers.
2. Move staff pool + booking data into the DB (configurable per event) instead of
   the hardcoded Python list.
3. Add real authentication (DB-backed sessions / JWT) rather than in-memory only,
   and hash passwords already (bcryptjs used in dashboard).
4. Add a proper logging layer (request logs + error logs) and observability.
5. Containerize (Docker / docker-compose) for reproducible deploys.

## Medium priority

6. Add unit tests for `event_processor.py` (currently integration-only).
7. Add request rate-limiting at the reverse-proxy/nginx level too.
8. Add API versioning + OpenAPI/Swagger.
9. Sanitize/normalize file-upload validation (currently the filter allows all).

## Low priority

10. Enforce consistent Prettier formatting across JS.
11. Add `.env.example` placeholder documentation parity for the dashboard.
12. Add a screenshot/logo to README (public-facing polish).
13. Migrate CI to a shared reusable workflow.

## Technical debt estimate

~2–3 engineer-weeks (primarily the dashboard monolith refactor and auth rework).

## Hours saved by this pass

~12–15 hours (README/CONTRIBUTING/SECURITY/CHANGELOG, hygiene files, API
hardening, CI templates, docs) — work that was previously absent or one-off.
