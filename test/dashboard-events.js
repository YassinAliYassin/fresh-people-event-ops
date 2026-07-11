#!/usr/bin/env node
// Integration test for the dashboard's Event CRUD API (web-dashboard/server-v4.js).
// Runs against an ISOLATED temporary SQLite DB (via EVENTS_DB env) so it never
// touches the real events.db. Covers the core domain entity end-to-end:
//   setup admin -> auth -> create -> read -> update -> delete.
//
// Uses only Node built-ins (http + assert + crypto). Exits non-zero on failure.

'use strict';
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.TEST_PORT || 3124;
const ROOT = path.dirname(__dirname); // project root
const SERVER = path.join(ROOT, 'web-dashboard', 'server-v4.js');

// Isolated scratch space.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-dash-test-'));
const EVENTS_DB = path.join(TMP, 'events.db');
const CAL_DIR = path.join(TMP, 'calendar-events');
fs.mkdirSync(CAL_DIR, { recursive: true });

const USER = 'testadmin';
const PASS = 'testpass123';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: route,
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* plain */ }
          resolve({ status: res.statusCode, json, text: raw });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const SAMPLE_EVENT = {
  event: 'Test Gala',
  date: '2026-08-15',
  time: '18:00',
  location: 'Joburg CC',
  client: 'Test Client',
  guests: 100,
  services: 'Waiters',
  staff: ['Mike', 'Alex'],
};

(async () => {
  const srv = spawn('node', [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      EVENTS_DB,
      CALENDAR_EVENTS_DIR: CAL_DIR,
      PROJECT_ROOT: ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let booted = false;
  srv.stdout.on('data', (d) => { if (/v4\.45 running on/.test(d.toString())) booted = true; });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const deadline = Date.now() + 10000;
  while (!booted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
  if (!booted) { console.error('::error::dashboard did not boot'); srv.kill(); process.exit(1); }

  let failed = false;
  try {
    // 1) Unauthenticated request is rejected.
    const anon = await request('GET', '/api/events');
    assert.strictEqual(anon.status, 401, `expected 401 unauth, got ${anon.status}`);
    console.log('✓ GET /api/events without auth -> 401');

    // 2) Create the initial admin user (only possible when no users exist).
    const setup = await request('POST', '/api/auth/setup', { username: USER, password: PASS });
    assert.strictEqual(setup.status, 200, `setup failed: ${setup.text}`);
    assert.ok(setup.json && setup.json.token, 'setup should return a token');
    console.log('✓ POST /api/auth/setup creates admin user');

    // 3) Authenticated list is reachable.
    const list0 = await request('GET', '/api/events', null, { authorization: AUTH });
    assert.strictEqual(list0.status, 200, `authed list failed: ${list0.text}`);
    console.log('✓ GET /api/events with auth -> 200');

    // 4) Create an event.
    const created = await request('POST', '/api/events', SAMPLE_EVENT, { authorization: AUTH });
    assert.strictEqual(created.status, 200, `create failed: ${created.text}`);
    const id = created.json && created.json.id;
    assert.ok(id, `expected generated event id, got: ${created.text}`);
    assert.strictEqual(created.json.event, 'Test Gala', 'event name should echo');
    console.log(`✓ POST /api/events creates event ${id}`);

    // 5) Read it back via the list endpoint (there is no GET /api/events/:id
    //    route in this API — single events are read from the list).
    const list1 = await request('GET', '/api/events', null, { authorization: AUTH });
    assert.strictEqual(list1.status, 200, `list failed: ${list1.text}`);
    const found = (list1.json || []).find((e) => e.id === id);
    assert.ok(found, `created event ${id} not present in GET /api/events`);
    assert.strictEqual(found.event, 'Test Gala', 'read-back event name mismatch');
    console.log('✓ created event appears in GET /api/events');

    // 6) Update it.
    const updated = await request('PUT', `/api/events/${id}`, { ...SAMPLE_EVENT, event: 'Test Gala Updated' }, { authorization: AUTH });
    assert.strictEqual(updated.status, 200, `update failed: ${updated.text}`);
    assert.strictEqual(updated.json.event, 'Test Gala Updated', 'update did not apply');
    const list2 = await request('GET', '/api/events', null, { authorization: AUTH });
    const updatedFound = (list2.json || []).find((e) => e.id === id);
    assert.strictEqual(updatedFound.event, 'Test Gala Updated', 'update not reflected in list');
    console.log('✓ PUT /api/events/:id updates the event');

    // 7) Delete it.
    const del = await request('DELETE', `/api/events/${id}`, null, { authorization: AUTH });
    assert.strictEqual(del.status, 200, `delete failed: ${del.text}`);
    const list3 = await request('GET', '/api/events', null, { authorization: AUTH });
    const after = (list3.json || []).find((e) => e.id === id);
    assert.strictEqual(after, undefined, `event ${id} should be gone after delete`);
    console.log('✓ DELETE /api/events/:id removes the event (absent from GET /api/events)');
  } catch (err) {
    console.error('::error::dashboard integration test failed:', err.message);
    failed = true;
  } finally {
    srv.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  if (failed) process.exit(1);
  console.log('Dashboard event CRUD integration test passed.');
})();
