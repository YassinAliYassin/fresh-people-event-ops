#!/usr/bin/env node
// Integration test for the Fresh People Event Ops API.
// Boots the root API (server.js) on an ephemeral port, then exercises the
// core booking flow end-to-end: POST /process-booking -> event_processor.py.
//
// Uses only Node built-ins (http + assert) so it adds no dependencies.
// Exits non-zero on any failure.

'use strict';
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const path = require('path');

const PORT = process.env.TEST_PORT || 3123;
const ROOT = path.dirname(__dirname); // project root (parent of /test)
const SERVER = path.join(ROOT, 'server.js');

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: route,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* plain text */ }
          resolve({ status: res.statusCode, json, text: raw });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const SAMPLE = `EVENT: Corporate Gala
CLIENT: Sarah M
DATE: 2026-07-20
TIME: 18:00
LOCATION: Johannesburg Convention Centre
GUESTS: 200
STAFF_REQUIRED: 5
SERVICES: Waiters, Baristas
NOTES: VIP Section needed`;

(async () => {
  // Boot the API server.
  const srv = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let booted = false;
  srv.stdout.on('data', (d) => { if (/running on port/.test(d.toString())) booted = true; });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // Wait for the listen banner (or bail after timeout).
  const deadline = Date.now() + 8000;
  while (!booted && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!booted) {
    console.error('::error::API server did not boot for integration test');
    srv.kill();
    process.exit(1);
  }

  let failed = false;
  try {
    // 1) Happy path: a valid booking is parsed and an Event ID is produced.
    const res = await request('POST', '/process-booking', { message: SAMPLE });
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
    assert.ok(res.json && res.json.success === true, 'expected success:true');
    assert.ok(res.json.result && /FP-\d{8}-[A-Z0-9]{4}/.test(res.json.result),
      `expected an FP- event ID in result, got: ${res.json && res.json.result}`);
    assert.ok(/Corporate Gala/.test(res.json.result), 'result should echo the event name');
    assert.ok(/Sarah M/.test(res.json.result), 'result should echo the client');
    console.log('✓ POST /process-booking parses a valid booking and emits an FP- event ID');

    // 2) Validation path: empty message -> 400.
    const bad = await request('POST', '/process-booking', { message: '' });
    assert.strictEqual(bad.status, 400, `expected 400 for empty message, got ${bad.status}`);
    console.log('✓ POST /process-booking rejects an empty message with 400');

    // 3) Health endpoint.
    const health = await request('GET', '/health');
    assert.strictEqual(health.status, 200, 'expected /health 200');
    console.log('✓ GET /health responds 200');
  } catch (err) {
    console.error('::error::integration test failed:', err.message);
    failed = true;
  } finally {
    srv.kill();
  }

  if (failed) process.exit(1);
  console.log('Integration test passed.');
})();
