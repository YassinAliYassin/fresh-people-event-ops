# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Production-hardening pass (docs, hygiene, CI hardening):
  - `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, `CHANGELOG.md`
  - `.editorconfig`, `.prettierrc`, issue/PR templates, Dependabot config
  - API hardening in `server.js` (rate limiting, request-size limits, async temp-file handling, security headers)

## [1.0.0] - Initial release

### Added
- Event booking parsing (EVENT/CLIENT/DATE/TIME/LOCATION/GUESTS/STAFF_REQUIRED/SERVICES/NOTES)
- Automatic staff allocation with team leader selection
- Google Calendar (`.ics`) event generation
- WhatsApp deployment message generation
- Express API (`POST /process-booking`)
- Web dashboard (event/staff/expense CRUD, auth, PDF export, uploads)
- WhatsApp Business API bot + Baileys robot
- GitHub Actions CI (build/health + secret scan)
