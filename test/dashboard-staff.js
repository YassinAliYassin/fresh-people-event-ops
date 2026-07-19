#!/usr/bin/env node
// Integration test for the dashboard's Staff CRUD API (web-dashboard/server-v4.js).
// Runs against an ISOLATED temporary SQLite DB (via EVENTS_DB env) so it never
// touches the real events.db. Exercises the staff entity: auth, validation,
// create -> list -> update -> delete.
//
// Self-contained (Node built-ins only). Usage: node test/dashboard-staff.js

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3016;
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
    req.setTimeout(60000, () => req.destroy(new Error('request socket timeout')));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-staff-'));
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
        const r = await request('GET', '/api/staff');
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
    const unauth = await request('GET', '/api/staff');
    assert.strictEqual(unauth.status, 401, `expected 401 unauth, got ${unauth.status}`);
    console.log('✓ GET /api/staff without auth -> 401');

    // 2) Create the admin user (seed path) and build a Basic auth header.
    const setup = await request('POST', '/api/auth/setup', {
      username: 'admin', password: 'test-pass-123', fullName: 'Test Admin',
    });
    assert.strictEqual(setup.status, 200, `auth/setup failed: ${setup.text}`);
    const AUTH = 'Basic ' + Buffer.from('admin:test-pass-123').toString('base64');
    console.log('✓ POST /api/auth/setup creates admin user');

    // 3) Validation: missing name -> 400.
    const bad = await request('POST', '/api/staff', { role: 'coordinator' }, { authorization: AUTH });
    assert.strictEqual(bad.status, 400, `expected 400 for missing name, got ${bad.status}`);
    console.log('✓ POST /api/staff rejects missing name with 400');

    // 4) Create a staff member.
    const created = await request('POST', '/api/staff', {
      name: 'Thabo Mokoena', phone: '+27821234567', role: 'coordinator',
      email: 'thabo@example.co.za', skills: ['sound', 'lighting'],
      pay_type: 'hourly', hourly_rate: 350, overtime_rate: 500,
    }, { authorization: AUTH });
    assert.strictEqual(created.status, 200, `create failed: ${created.text}`);
    assert.ok(created.json && created.json.id > 0, 'create should return numeric id');
    const id = created.json.id;
    assert.strictEqual(created.json.name, 'Thabo Mokoena', 'name should echo');
    console.log(`✓ POST /api/staff creates staff id=${id}`);

    // 5) Read it back via the list endpoint.
    const list = await request('GET', '/api/staff', null, { authorization: AUTH });
    assert.strictEqual(list.status, 200, `list failed: ${list.text}`);
    const found = (list.json || []).find((s) => s.id === id);
    assert.ok(found, `created staff ${id} not present in GET /api/staff`);
    assert.strictEqual(found.name, 'Thabo Mokoena', 'read-back name mismatch');
    console.log('✓ GET /api/staff returns the created staff member');

    // 6) Update it.
    const updated = await request('PUT', `/api/staff/${id}`, {
      name: 'Thabo Mokoena', role: 'lead', hourly_rate: 400,
    }, { authorization: AUTH });
    assert.strictEqual(updated.status, 200, `update failed: ${updated.text}`);
    assert.strictEqual(updated.json.role, 'lead', 'update role not applied');
    assert.strictEqual(updated.json.hourly_rate, 400, 'update rate not applied');
    console.log('✓ PUT /api/staff/:id updates the staff member');

    // 7) Updating a non-existent id -> 404.
    const missing = await request('PUT', '/api/staff/999999', { name: 'Ghost' }, { authorization: AUTH });
    assert.strictEqual(missing.status, 404, `expected 404 for missing id, got ${missing.status}`);
    console.log('✓ PUT /api/staff/:id on unknown id -> 404');

    // 8) Delete it.
    const del = await request('DELETE', `/api/staff/${id}`, null, { authorization: AUTH });
    assert.strictEqual(del.status, 200, `delete failed: ${del.text}`);
    const listAfter = await request('GET', '/api/staff', null, { authorization: AUTH });
    const gone = (listAfter.json || []).find((s) => s.id === id);
    assert.strictEqual(gone, undefined, `staff ${id} should be gone after delete`);
    console.log('✓ DELETE /api/staff/:id removes the staff member');

    console.log('Dashboard staff CRUD integration test passed.');
  } catch (err) {
    console.error('::error::staff integration test failed:', err.message);
    failed = true;
  } finally {
    cleanup();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
