#!/usr/bin/env node
// Integration test for the dashboard's Expense CRUD API (web-dashboard/server-v4.js).
// Runs against an ISOLATED temporary SQLite DB (via EVENTS_DB env) so it never
// touches the real events.db. Exercises the financial core: auth, validation,
// create -> list -> update -> delete.
//
// Self-contained (Node built-ins only). Usage: node test/dashboard-expenses.js

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3015;
const ROOT = path.dirname(__dirname);              // project root
const SERVER = path.join(ROOT, 'web-dashboard', 'server-v4.js');
const BASE = `http://127.0.0.1:${PORT}`;

let failed = false;

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = Object.assign(
      { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      headers
    );
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(
      `${BASE}${pathname}`,
      { method, headers: h },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (_) {}
          resolve({ status: res.statusCode, text: data, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request socket timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function waitFor(predicate, timeoutMs = 15000, intervalMs = 250) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      Promise.resolve(predicate()).then((ok) => {
        if (ok) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for server'));
        setTimeout(tick, intervalMs);
      }).catch(reject);
    };
    tick();
  });
}

async function main() {
  // Isolated DB + dirs so the test never mutates the real events.db.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-exp-'));
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    EVENTS_DB: path.join(tmp, 'events.db'),
    CALENDAR_EVENTS_DIR: path.join(tmp, 'calendar-events'),
    PROJECT_ROOT: ROOT,
    NODE_ENV: 'test',
  });

  const child = spawn('node', [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const cleanup = () => { try { child.kill(); } catch (_) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} };

  try {
    await waitFor(async () => {
      try {
        const r = await request('GET', '/api/expenses');
        return r.status === 401 || r.status === 200; // 401 = up + auth enforced
      }
      catch (_) { return false; }
    });
  } catch (e) {
    console.error('::error::dashboard did not boot\n', log.slice(-2000));
    cleanup();
    process.exit(1);
  }

  try {
    // 1) Unauthenticated access is rejected.
    const unauth = await request('GET', '/api/expenses');
    assert.strictEqual(unauth.status, 401, `expected 401 unauth, got ${unauth.status}`);
    console.log('✓ GET /api/expenses without auth -> 401');

    // 2) Create the admin user (seed path) and build a Basic auth header.
    const setup = await request('POST', '/api/auth/setup', {
      username: 'admin', password: 'test-pass-123', fullName: 'Test Admin',
    });
    assert.strictEqual(setup.status, 200, `auth/setup failed: ${setup.text}`);
    const AUTH = 'Basic ' + Buffer.from('admin:test-pass-123').toString('base64');
    console.log('✓ POST /api/auth/setup creates admin user');

    // 3) Validation: missing event_id -> 400.
    const bad = await request('POST', '/api/expenses', { description: 'no event' }, { authorization: AUTH });
    assert.strictEqual(bad.status, 400, `expected 400 for missing event_id, got ${bad.status}`);
    console.log('✓ POST /api/expenses rejects missing event_id with 400');

    // 4) Create an expense.
    const created = await request('POST', '/api/expenses', {
      event_id: 'EVT-001', category: 'catering', description: 'Gala catering',
      amount: 15000, currency: 'ZAR', vendor: 'Gourmet Co', status: 'approved',
    }, { authorization: AUTH });
    assert.strictEqual(created.status, 200, `create failed: ${created.text}`);
    assert.ok(created.json && created.json.success, 'create should report success');
    const id = created.json.id;
    assert.ok(Number.isInteger(id) && id > 0, `expected numeric expense id, got ${id}`);
    console.log(`✓ POST /api/expenses creates expense id=${id}`);

    // 5) Read it back via the single-expense endpoint.
    const got = await request('GET', `/api/expenses/${id}`, null, { authorization: AUTH });
    assert.strictEqual(got.status, 200, `get by id failed: ${got.text}`);
    assert.strictEqual(got.json.expense.description, 'Gala catering', 'read-back description mismatch');
    console.log('✓ GET /api/expenses/:id returns the created expense');

    // 6) Update it.
    const updated = await request('PUT', `/api/expenses/${id}`, { amount: 18000, status: 'pending' }, { authorization: AUTH });
    assert.strictEqual(updated.status, 200, `update failed: ${updated.text}`);
    const got2 = await request('GET', `/api/expenses/${id}`, null, { authorization: AUTH });
    assert.strictEqual(got2.json.expense.amount, 18000, 'update amount not applied');
    assert.strictEqual(got2.json.expense.status, 'pending', 'update status not applied');
    console.log('✓ PUT /api/expenses/:id updates the expense');

    // 7) Delete it.
    const del = await request('DELETE', `/api/expenses/${id}`, null, { authorization: AUTH });
    assert.strictEqual(del.status, 200, `delete failed: ${del.text}`);
    const after = await request('GET', `/api/expenses/${id}`, null, { authorization: AUTH });
    assert.strictEqual(after.status, 404, `expected 404 after delete, got ${after.status}`);
    console.log('✓ DELETE /api/expenses/:id removes the expense (subsequent GET -> 404)');

    console.log('Dashboard expense CRUD integration test passed.');
  } catch (err) {
    console.error('::error::expense integration test failed:', err.message);
    failed = true;
  } finally {
    cleanup();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
