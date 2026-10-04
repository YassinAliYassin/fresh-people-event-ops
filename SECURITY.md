# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | ✅ Active support  |

## Reporting a Vulnerability

Security issues — leaked credentials, authentication bypasses, injection, or any
other vulnerability — must **not** be reported in a public issue.

Please report privately by emailing **info@solidsolutions.africa** with the
subject prefix `[SECURITY] fresh-people-event-ops`. Include:

- A description of the vulnerability
- Steps to reproduce
- The affected version/commit
- Any suggested fix (optional)

You will receive an acknowledgement within 72 hours, and we will keep you
informed of progress toward a fix.

## Secrets Hygiene

- Real WhatsApp / Telegram / SMTP / Web Push / database credentials must be
  loaded from the environment, never committed.
- `.env`, `.env.local`, `vapid-keys.json`, `*.log` and local DBs are gitignored.
- CI runs a secret scan (`.github/workflows/secret-scan.yml`) that blocks any
  push/PR introducing a real credential.
- If you ever commit a real token, rotate it immediately and remove it from
  history.
