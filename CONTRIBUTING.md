# Contributing to Fresh People Event Operations

Thanks for taking the time to contribute! 🎉

## Code of Conduct

This project and everyone participating in it is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to
uphold this code.

## How to contribute

1. **Open an issue** describing the bug, feature, or improvement (or pick an
   existing one).
2. **Fork the repo** and create a feature branch:
   ```bash
   git checkout -b feat/my-feature
   ```
3. **Make changes** following the guidelines below.
4. **Test** your changes (`npm test`).
5. **Commit** with a clear message, then open a Pull Request against `main`.

## Development setup

```bash
npm install
npm --prefix web-dashboard install
npm run api        # API on :3010
npm run bot        # WhatsApp bot on :3011
npm run dashboard  # Dashboard on :3004
```

## Guidelines

- Keep changes focused; one logical change per PR.
- Never commit secrets or real tokens — use env vars / `.env` (gitignored).
- The `POST /process-booking` public API contract must remain backward
  compatible. Additive fields are fine; removing/renaming fields is not.
- Python processor must stay dependency-free (stdlib only).
- Keep the dashboard monolith (`server-v4.js`) working — refactors that change
  behaviour should be split into a dedicated "refactor" PR and covered by the
  integration tests.

## Testing

```bash
npm test   # runs test/integration.js + dashboard-* tests on fresh DBs
```

Always run the full suite before opening a PR. CI will also verify that all
services boot and no secrets are introduced.

## Commit messages

Use conventional commits where possible:

```
feat: add multi-day event support
fix: reject empty CLIENT field
docs: expand deployment instructions
refactor: extract staff allocation into a module
```
