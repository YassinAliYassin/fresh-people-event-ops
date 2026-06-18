const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const webPush = require('web-push');

const app = express();
const PORT = 3004;
const DB_PATH = path.join(__dirname, '..', 'events.db');
const CALENDAR_DIR = path.join(__dirname, '..', 'calendar-events');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Ensure upload directory exists
fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype) || true); // Allow all for flexibility
  }
});

app.use(bodyParser.json());

// ==================== USER AUTHENTICATION ====================

// In-memory session store (token -> { username, role, expires })
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of sessions) {
    if (data.expires < now) sessions.delete(token);
  }
}, 60 * 60 * 1000); // Every hour

// Auth middleware - checks session token or allows public paths
function authMiddleware(req, res, next) {
  // Public paths that don't require auth
  const publicPaths = ['/login.html', '/api/auth/login', '/api/auth/register', '/api/auth/setup'];
  if (publicPaths.includes(req.path)) return next();
  if (req.path === '/manifest.json' || req.path === '/sw.js') return next();
  if (req.path.startsWith('/icon')) return next();
  if (req.path.startsWith('/uploads/')) return next();

  // Check session token from header or cookie
  const token = req.headers['x-session-token'] || req.cookies?.sessionToken;
  if (token && sessions.has(token)) {
    const session = sessions.get(token);
    if (session.expires > Date.now()) {
      req.user = { username: session.username, role: session.role };
      // Extend session on activity
      session.expires = Date.now() + SESSION_TTL;
      return next();
    }
    sessions.delete(token);
  }

  // Check basic auth header as fallback (for API clients)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const [user, pass] = decoded.split(':');
    // Allow fallback basic auth for backward compat
    db.get(`SELECT * FROM users WHERE username = ? AND active = 1`, [user], (err, row) => {
      if (row && bcrypt.compareSync(pass, row.password_hash)) {
        req.user = { username: row.username, role: row.role };
        return next();
      }
      res.status(401).json({ error: 'Unauthorized', loginUrl: '/login.html' });
    });
    return;
  }

  // For API requests, return JSON 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized', loginUrl: '/login.html' });
  }
  // For page requests, redirect to login
  res.redirect('/login.html');
}

app.use(authMiddleware);

// Serve PWA public assets
app.use('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'), {
        headers: { 'Content-Type': 'application/manifest+json' }
    });
});
app.use('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sw.js'), {
        headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' }
    });
});
app.use('/icon.svg', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'icon.svg'), {
        headers: { 'Content-Type': 'image/svg+xml' }
    });
});

// Serve static files - manifest and service worker need special handling
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.json') && filePath.includes('manifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
        }
        if (filePath.endsWith('.js') && filePath.includes('sw')) {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Service-Worker-Allowed', '/');
        }
    }
}));

// Initialize DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err);
  else console.log('Connected to SQLite DB');
});

// Ensure backup and upload directories exist
fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});

// ==================== DB MIGRATIONS ====================

// Create users table for multi-user auth
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  role TEXT DEFAULT 'user',
  active INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
)`);

// Create event_attachments table
db.run(`CREATE TABLE IF NOT EXISTS event_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  uploaded_by TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id)
)`);

// Create push_subscriptions table
db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT DEFAULT 'admin',
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Create staff_availability table if not exists
db.run(`CREATE TABLE IF NOT EXISTS staff_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  UNIQUE(staff_id, date)
)`);

// Add cost columns to events table (migration)
db.run(`ALTER TABLE events ADD COLUMN estimated_cost REAL DEFAULT 0`, () => {});
db.run(`ALTER TABLE events ADD COLUMN actual_cost REAL DEFAULT 0`, () => {});
db.run(`ALTER TABLE events ADD COLUMN currency TEXT DEFAULT 'ZAR'`, () => {});
db.run(`ALTER TABLE events ADD COLUMN budget REAL DEFAULT 0`, () => {});
db.run(`ALTER TABLE events ADD COLUMN client_email TEXT DEFAULT ''`, () => {});

// Add email column to staff table (migration)
db.run(`ALTER TABLE staff ADD COLUMN email TEXT DEFAULT ''`, () => {});

// Create budgets table for monthly/annual budget tracking
db.run(`CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  period TEXT DEFAULT 'monthly',
  category TEXT DEFAULT 'general',
  start_date TEXT,
  end_date TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Create email_notifications log table
db.run(`CREATE TABLE IF NOT EXISTS email_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Create email_settings table for SMTP configuration
db.run(`CREATE TABLE IF NOT EXISTS email_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smtp_host TEXT DEFAULT '',
  smtp_port INTEGER DEFAULT 587,
  smtp_secure INTEGER DEFAULT 0,
  smtp_user TEXT DEFAULT '',
  smtp_pass TEXT DEFAULT '',
  from_name TEXT DEFAULT 'Fresh People Events',
  from_email TEXT DEFAULT '',
  auto_notify_client INTEGER DEFAULT 1,
  auto_notify_staff INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Insert default email settings if not exists
db.get(`SELECT id FROM email_settings WHERE id = 1`, (err, row) => {
  if (!row) {
    db.run(`INSERT INTO email_settings (id) VALUES (1)`);
  }
});

// ==================== VAPID / PUSH NOTIFICATIONS ====================

// VAPID keys storage
let vapidKeys = { publicKey: '', privateKey: '' };

// Load or generate VAPID keys
async function initVapidKeys() {
  try {
    const keysData = await fs.readFile(path.join(__dirname, '..', 'vapid-keys.json'), 'utf8');
    vapidKeys = JSON.parse(keysData);
    console.log('Loaded existing VAPID keys');
  } catch {
    vapidKeys = webPush.generateVAPIDKeys();
    await fs.writeFile(path.join(__dirname, '..', 'vapid-keys.json'), JSON.stringify(vapidKeys, null, 2));
    console.log('Generated new VAPID keys');
  }
  webPush.setVapidDetails(
    'mailto:admin@fresh-people.co.za',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}
initVapidKeys().catch(console.error);

// ==================== AUTH API ENDPOINTS ====================

// POST /api/auth/setup - create initial admin user (only works when no users exist)
app.post('/api/auth/setup', (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  db.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row.count > 0) return res.status(403).json({ error: 'Setup already completed. Use login.' });

    const hash = bcrypt.hashSync(password, 10);
    db.run(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'admin')`,
      [username, hash, display_name || username],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const token = uuidv4();
        sessions.set(token, { username, role: 'admin', expires: Date.now() + SESSION_TTL });
        res.json({ success: true, token, username, role: 'admin', message: 'Admin account created' });
      }
    );
  });
});

// POST /api/auth/register - register new user (admin only can create users)
app.post('/api/auth/register', (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  // Check if any users exist - if not, allow first user as admin
  db.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const isFirstUser = row.count === 0;
    const userRole = isFirstUser ? 'admin' : (role || 'user');

    const hash = bcrypt.hashSync(password, 10);
    db.run(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)`,
      [username, hash, display_name || username, userRole],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID, username, role: userRole, message: 'User registered' });
      }
    );
  });
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  db.get(`SELECT * FROM users WHERE username = ? AND active = 1`, [username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = uuidv4();
    sessions.set(token, { username: user.username, role: user.role, expires: Date.now() + SESSION_TTL });

    // Update last login
    db.run(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);

    res.json({
      success: true,
      token,
      username: user.username,
      display_name: user.display_name,
      role: user.role
    });
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ success: true, message: 'Logged out' });
});

// GET /api/auth/me - get current user info
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  db.get(`SELECT id, username, display_name, role, created_at, last_login FROM users WHERE username = ?`, [req.user.username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(user);
  });
});

// GET /api/auth/users - list users (admin only)
app.get('/api/auth/users', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  db.all(`SELECT id, username, display_name, role, active, created_at, last_login FROM users ORDER BY created_at`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET /api/auth/vapid-public-key - get VAPID public key for push subscription
app.get('/api/auth/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// ==================== PUSH NOTIFICATION API ====================

// POST /api/push/subscribe - save push subscription
app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription data' });
  }
  db.run(
    `INSERT OR REPLACE INTO push_subscriptions (username, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)`,
    [req.user?.username || 'admin', endpoint, keys.p256dh, keys.auth],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// POST /api/push/unsubscribe - remove push subscription
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
  db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// POST /api/push/send - send push notification to all subscribers
async function sendPushNotification(title, body, url = '/') {
  if (!vapidKeys.publicKey) return { error: 'VAPID keys not ready' };
  db.all(`SELECT * FROM push_subscriptions`, [], async (err, subs) => {
    if (err) return;
    const payload = JSON.stringify({ title, body, icon: '/icon-192.png', badge: '/icon-192.png', url });
    for (const sub of subs) {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [sub.id]);
        }
      }
    }
  });
}

// ==================== EVENT ATTACHMENTS API ====================

// POST /api/events/:id/attachments - upload file(s) for an event
app.post('/api/events/:id/attachments', upload.array('files', 10), (req, res) => {
  const eventId = req.params.id;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = [];
  let completed = 0;
  req.files.forEach(file => {
    db.run(
      `INSERT INTO event_attachments (event_id, filename, original_name, mimetype, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [eventId, file.filename, file.originalname, file.mimetype, file.size, req.user?.username || 'system'],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        results.push({
          id: this.lastID,
          event_id: eventId,
          filename: file.filename,
          original_name: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: `/uploads/${file.filename}`
        });
        completed++;
        if (completed === req.files.length) res.json({ success: true, files: results });
      }
    );
  });
});

// GET /api/events/:id/attachments - list attachments for an event
app.get('/api/events/:id/attachments', (req, res) => {
  db.all(
    `SELECT id, event_id, filename, original_name, mimetype, size, uploaded_by, created_at FROM event_attachments WHERE event_id = ? ORDER BY created_at DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map(r => ({ ...r, url: `/uploads/${r.filename}` })));
    }
  );
});

// DELETE /api/attachments/:id - delete an attachment
app.delete('/api/attachments/:id', (req, res) => {
  db.get(`SELECT * FROM event_attachments WHERE id = ?`, [req.params.id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    db.run(`DELETE FROM event_attachments WHERE id = ?`, [req.params.id], async function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      try { await fs.unlink(path.join(UPLOAD_DIR, row.filename)); } catch {}
      res.json({ success: true, id: req.params.id });
    });
  });
});

// Helper: Get unavailable staff for a date
async function getUnavailableStaff(dateStr) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT sa.staff_id, s.name, sa.reason FROM staff_availability sa JOIN staff s ON s.id = sa.staff_id WHERE sa.date = ?`, [dateStr], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Helper: Generate event ID
async function generateEventID(dateStr) {
  const dateObj = new Date(dateStr);
  const yyyymmdd = dateObj.toISOString().slice(0,10).replace(/-/g,'');
  return new Promise((resolve, reject) => {
    db.all(`SELECT id FROM events WHERE id LIKE ? ORDER BY id DESC LIMIT 1`, [`FP-${yyyymmdd}-%`], (err, rows) => {
      if (err) return reject(err);
      let num = 1;
      if (rows.length) {
        const last = rows[0].id;
        num = parseInt(last.split('-')[2]) + 1;
      }
      resolve(`FP-${yyyymmdd}-${String(num).padStart(3,'0')}`);
    });
  });
}

// Helper: Get active staff count
async function getActiveStaffCount() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as count FROM staff WHERE active=1`, (err, row) => {
      if (err) return reject(err);
      resolve(row.count);
    });
  });
}

// Helper: Generate ICS
function generateICS(event) {
  const dtStart = new Date(`${event.date}T${event.time}`).toISOString().replace(/[-:]/g,'').slice(0,15);
  const endTime = new Date(`${event.date}T${event.time}`);
  endTime.setHours(endTime.getHours() + 4);
  const dtEnd = endTime.toISOString().replace(/[-:]/g,'').slice(0,15);
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Fresh People//Event//EN\nBEGIN:VEVENT\nUID:${event.id}@fresh-people.co.za\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}\nDTSTART:${dtStart}\nDTEND:${dtEnd}\nSUMMARY:${event.event}\nLOCATION:${event.location}\nDESCRIPTION:Client: ${event.client}\\nServices: ${event.services}\\nTeam: ${(event.staff || []).join(', ')}\\nNotes: ${event.notes}\nEND:VEVENT\nEND:VCALENDAR`;
}

// Helper: Backup database
async function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `events-backup-${timestamp}.db`);
  await fs.copyFile(DB_PATH, backupPath);
  // Keep only last 30 backups
  const files = (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('events-backup-')).sort();
  while (files.length > 30) {
    await fs.unlink(path.join(BACKUP_DIR, files.shift()));
  }
  return backupPath;
}

// Helper: Get email settings
async function getEmailSettings() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM email_settings WHERE id = 1`, (err, row) => {
      if (err) return reject(err);
      resolve(row || {});
    });
  });
}

// Helper: Create transporter from settings
function createTransporter(settings) {
  if (!settings.smtp_host || !settings.smtp_user) return null;
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port || 587,
    secure: !!settings.smtp_secure,
    auth: { user: settings.smtp_user, pass: settings.smtp_pass }
  });
}

// Helper: Send email
async function sendEmail(to, subject, htmlBody, textBody) {
  const settings = await getEmailSettings();
  const transporter = createTransporter(settings);
  if (!transporter) return { success: false, error: 'SMTP not configured' };
  const from = `"${settings.from_name || 'Fresh People Events'}" <${settings.from_email || settings.smtp_user}>`;
  try {
    const info = await transporter.sendMail({ from, to, subject, html: htmlBody, text: textBody || htmlBody.replace(/<[^>]+>/g, '') });
    return { success: true, messageId: info.messageId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Helper: Auto-notify on event creation
async function autoNotifyEvent(event, staffList) {
  const settings = await getEmailSettings();
  const results = [];

  // Notify client
  if (settings.auto_notify_client && event.client_email) {
    const subject = `Event Confirmation: ${event.event} on ${event.date}`;
    const html = `<h2>Event Confirmation</h2><p>Dear ${event.client},</p><p>Your event <strong>${event.event}</strong> has been scheduled.</p><ul><li><strong>Date:</strong> ${event.date}</li><li><strong>Time:</strong> ${event.time}</li><li><strong>Location:</strong> ${event.location}</li><li><strong>Services:</strong> ${event.services}</li></ul><p>Thank you for choosing Fresh People Events!</p>`;
    const r = await sendEmail(event.client_email, subject, html);
    db.run(`INSERT INTO email_notifications (event_id, recipient, subject, body, status, sent_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, event.client_email, subject, html, r.success ? 'sent' : 'failed', r.success ? new Date().toISOString() : null]);
    results.push({ type: 'client', ...r });
  }

  // Notify staff
  if (settings.auto_notify_staff && staffList && staffList.length > 0) {
    const subject = `New Assignment: ${event.event} on ${event.date}`;
    for (const staffName of staffList) {
      db.get(`SELECT * FROM staff WHERE name = ? AND active = 1`, [staffName], (err, staffRow) => {
        if (err || !staffRow || !staffRow.email) return;
        const html = `<h2>New Event Assignment</h2><p>Hi ${staffName},</p><p>You've been assigned to <strong>${event.event}</strong>.</p><ul><li><strong>Date:</strong> ${event.date}</li><li><strong>Time:</strong> ${event.time}</li><li><strong>Location:</strong> ${event.location}</li></ul>`;
        sendEmail(staffRow.email, subject, html).then(r => {
          db.run(`INSERT INTO email_notifications (event_id, recipient, subject, body, status, sent_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [event.id, staffRow.email, subject, html, r.success ? 'sent' : 'failed', r.success ? new Date().toISOString() : null]);
        });
        results.push({ type: 'staff', name: staffName });
      });
    }
  }

  return results;
}

// GET /api/events
app.get('/api/events', (req, res) => {
  db.all(`SELECT * FROM events ORDER BY date DESC, time DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// POST /api/events (with staff shortage warning)
app.post('/api/events', async (req, res) => {
  try {
    const { event, date, time, location, client, client_email, services, staff, notes, estimated_cost, actual_cost, currency, budget } = req.body;
    const id = await generateEventID(date);
    const staffList = staff || [];
    const activeStaffCount = await getActiveStaffCount();
    const warnings = [];
    
    if (staffList.length > activeStaffCount) {
      warnings.push(`Staff shortage: ${staffList.length} requested but only ${activeStaffCount} active`);
    }
    
    const staffJSON = JSON.stringify(staffList);
    const notesText = notes || `Dress Code: All Black\nArrival Time: ${parseInt(time.split(':')[0])-1}:${time.split(':')[1]}`;
    const fullNotes = warnings.length > 0 ? `${notesText}\n\n⚠️ WARNINGS:\n${warnings.join('\n')}` : notesText;
    
    const estCost = estimated_cost || 0;
    const actCost = actual_cost || 0;
    const curr = currency || 'ZAR';
    const evtBudget = budget || 0;
    const cliEmail = client_email || '';
    
    db.run(
      `INSERT INTO events (id, event, date, time, location, client, client_email, services, staff, notes, estimated_cost, actual_cost, currency, budget) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, event, date, time, location, client, cliEmail, services, staffJSON, fullNotes, estCost, actCost, curr, evtBudget],
      async function(err) {
        if (err) return res.status(500).json({error: err.message});
        const newEvent = {id, event, date, time, location, client, client_email: cliEmail, services, staff: staffList, notes: fullNotes, warnings, estimated_cost: estCost, actual_cost: actCost, currency: curr, budget: evtBudget};
        const icsContent = generateICS(newEvent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(newEvent, null, 2));
        // Auto-backup on event creation
        try { await backupDatabase(); } catch(e) { console.error('Backup failed:', e); }
        // Auto-notify client and staff via email
        try { await autoNotifyEvent(newEvent, staffList); } catch(e) { console.error('Auto-notify failed:', e); }
        // Send push notification
        try { sendPushNotification(`New Event: ${event}`, `${date} at ${time} - ${location}`, '/'); } catch(e) { console.error('Push notify failed:', e); }
        res.json(newEvent);
      }
    );
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', (req, res) => {
  const { event, date, time, location, client, services, staff, notes, estimated_cost, actual_cost, currency, budget } = req.body;
  const id = req.params.id;
  const staffJSON = JSON.stringify(staff || []);
  const estCost = estimated_cost || 0;
  const actCost = actual_cost || 0;
  const curr = currency || 'ZAR';
  const evtBudget = budget || 0;
  db.run(
    `UPDATE events SET event=?, date=?, time=?, location=?, client=?, services=?, staff=?, notes=?, estimated_cost=?, actual_cost=?, currency=?, budget=? WHERE id=?`,
    [event, date, time, location, client, services, staffJSON, notes, estCost, actCost, curr, evtBudget, id],
    async function(err) {
      if (err) return res.status(500).json({error: err.message});
      if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
      const updatedEvent = {id, event, date, time, location, client, services, staff: JSON.parse(staffJSON), notes, estimated_cost: estCost, actual_cost: actCost, currency: curr, budget: evtBudget};
      const icsContent = generateICS(updatedEvent);
      await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
      await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(updatedEvent, null, 2));
      res.json(updatedEvent);
    }
  );
});

// PATCH /api/events/:id/status - Update event status
app.patch('/api/events/:id/status', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`});
  }
  const id = req.params.id;
  db.run(`UPDATE events SET status=? WHERE id=?`, [status, id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
    res.json({ success: true, id, status });
  });
});

// DELETE /api/events/:id
app.delete('/api/events/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM events WHERE id=?`, [id], async function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
    try { await fs.unlink(path.join(CALENDAR_DIR, `${id}.ics`)); } catch(e) {}
    try { await fs.unlink(path.join(CALENDAR_DIR, `${id}.json`)); } catch(e) {}
    res.json({success: true, id});
  });
});

// GET /api/staff
app.get('/api/staff', (req, res) => {
  db.all(`SELECT * FROM staff ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// POST /api/staff - add new staff member
app.post('/api/staff', (req, res) => {
  const { name, phone, role, email, skills } = req.body;
  if (!name) return res.status(400).json({error: 'Name is required'});
  const skillsJSON = Array.isArray(skills) ? JSON.stringify(skills) : (skills || '[]');
  db.run(`INSERT INTO staff (name, phone, role, email, active, skills) VALUES (?, ?, ?, ?, 1, ?)`, [name, phone || null, role || 'staff', email || '', skillsJSON], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ id: this.lastID, name, phone: phone || null, role: role || 'staff', email: email || '', active: 1, skills: skillsJSON });
  });
});

// PUT /api/staff/:id - update staff (including phone, skills, email)
app.put('/api/staff/:id', (req, res) => {
  const { name, phone, role, email, active, skills } = req.body;
  const id = req.params.id;
  const skillsJSON = Array.isArray(skills) ? JSON.stringify(skills) : (skills || '[]');
  db.run(
    `UPDATE staff SET name=?, phone=?, role=?, email=?, active=?, skills=? WHERE id=?`,
    [name, phone || null, role || 'staff', email || '', active ? 1 : 0, skillsJSON, id],
    function(err) {
      if (err) return res.status(500).json({error: err.message});
      if (this.changes === 0) return res.status(404).json({error: 'Staff not found'});
      res.json({ success: true, id, name, phone, role, email, active: active ? 1 : 0, skills: skillsJSON });
    }
  );
});

// DELETE /api/staff/:id
app.delete('/api/staff/:id', (req, res) => {
  db.run(`DELETE FROM staff WHERE id=?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ success: true, id: req.params.id });
  });
});

// ==================== STAFF AVAILABILITY ====================

// GET /api/availability - get availability for a date range
app.get('/api/availability', (req, res) => {
  const { from, to, staff_id } = req.query;
  let query = `SELECT sa.id, sa.staff_id, s.name, sa.date, sa.reason, sa.created_at 
               FROM staff_availability sa JOIN staff s ON s.id = sa.staff_id WHERE 1=1`;
  const params = [];
  if (from) { query += ` AND sa.date >= ?`; params.push(from); }
  if (to) { query += ` AND sa.date <= ?`; params.push(to); }
  if (staff_id) { query += ` AND sa.staff_id = ?`; params.push(staff_id); }
  query += ` ORDER BY sa.date, s.name`;
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST /api/availability - mark staff unavailable
app.post('/api/availability', (req, res) => {
  const { staff_id, date, reason } = req.body;
  if (!staff_id || !date) return res.status(400).json({ error: 'staff_id and date are required' });
  db.run(
    `INSERT OR REPLACE INTO staff_availability (staff_id, date, reason) VALUES (?, ?, ?)`,
    [staff_id, date, reason || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, staff_id, date, reason: reason || '' });
    }
  );
});

// POST /api/availability/batch - mark staff unavailable for multiple dates
app.post('/api/availability/batch', (req, res) => {
  const { staff_id, dates, reason } = req.body;
  if (!staff_id || !dates || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: 'staff_id and dates array are required' });
  }
  const results = [];
  let completed = 0;
  dates.forEach(date => {
    db.run(
      `INSERT OR REPLACE INTO staff_availability (staff_id, date, reason) VALUES (?, ?, ?)`,
      [staff_id, date, reason || ''],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        results.push({ staff_id, date, reason: reason || '' });
        completed++;
        if (completed === dates.length) {
          res.json({ success: true, count: results.length, entries: results });
        }
      }
    );
  });
});

// DELETE /api/availability/:id - remove unavailability entry
app.delete('/api/availability/:id', (req, res) => {
  db.run(`DELETE FROM staff_availability WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true, id: req.params.id });
  });
});

// GET /api/availability/check/:date - check who's unavailable on a date
app.get('/api/availability/check/:date', async (req, res) => {
  try {
    const unavailable = await getUnavailableStaff(req.params.date);
    res.json({ date: req.params.date, unavailable, count: unavailable.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendar (simple calendar view data)
app.get('/api/calendar', (req, res) => {
  db.all(`SELECT id, event, date, time, location, status FROM events ORDER BY date, time`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// GET /api/templates - list all event templates
app.get('/api/templates', (req, res) => {
  db.all(`SELECT * FROM event_templates ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// GET /api/templates/:id - get single template
app.get('/api/templates/:id', (req, res) => {
  db.get(`SELECT * FROM event_templates WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({error: err.message});
    if (!row) return res.status(404).json({error: 'Template not found'});
    res.json(row);
  });
});

// POST /api/templates - create new template
app.post('/api/templates', (req, res) => {
  const { name, description, default_duration_hours, pre_arrival_hours, dress_code, default_services, default_staff_count } = req.body;
  if (!name) return res.status(400).json({error: 'Name is required'});
  db.run(
    `INSERT INTO event_templates (name, description, default_duration_hours, pre_arrival_hours, dress_code, default_services, default_staff_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, description || '', default_duration_hours || 4, pre_arrival_hours || 1, dress_code || 'All Black', default_services || '', default_staff_count || 8],
    function(err) {
      if (err) return res.status(500).json({error: err.message});
      res.json({ id: this.lastID, name, description, default_duration_hours, pre_arrival_hours, dress_code, default_services, default_staff_count });
    }
  );
});

// GET /api/conflicts - check for booking conflicts
app.get('/api/conflicts', (req, res) => {
  db.all(`SELECT id, event, date, time, location, staff, status FROM events WHERE status != 'cancelled' OR status IS NULL`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    const eventsByDate = {};
    const conflicts = [];
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      if (!eventsByDate[r.date]) eventsByDate[r.date] = [];
      eventsByDate[r.date].push({ id: r.id, event: r.event, time: r.time, location: r.location, staff: staffList });
    });
    Object.entries(eventsByDate).forEach(([date, events]) => {
      if (events.length > 1) {
        const staffCounts = {};
        events.forEach(e => e.staff.forEach(s => { staffCounts[s] = (staffCounts[s] || 0) + 1; }));
        const doubleBooked = Object.entries(staffCounts).filter(([_, c]) => c > 1);
        if (doubleBooked.length > 0) {
          conflicts.push({ date, events, doubleBooked: Object.fromEntries(doubleBooked) });
        }
      }
    });
    res.json({ conflicts, hasConflicts: conflicts.length > 0 });
  });
});

// GET /api/alerts - get all alerts (conflicts + shortages + upcoming)
app.get('/api/alerts', (req, res) => {
  db.all(`SELECT * FROM events WHERE status != 'cancelled' OR status IS NULL ORDER BY date, time`, [], (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    
    const alerts = [];
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    
    // Check for staff shortages
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      if (r.notes && r.notes.includes('Staff shortage')) {
        alerts.push({
          type: 'shortage',
          severity: 'warning',
          eventId: r.id,
          event: r.event,
          date: r.date,
          time: r.time,
          message: `Staff shortage for "${r.event}" on ${r.date}`
        });
      }
      // Upcoming events (within 24h)
      if (r.date <= tomorrowStr && r.date >= now.toISOString().slice(0, 10)) {
        alerts.push({
          type: 'upcoming',
          severity: 'info',
          eventId: r.id,
          event: r.event,
          date: r.date,
          time: r.time,
          message: `Upcoming: "${r.event}" on ${r.date} at ${r.time}`
        });
      }
    });
    
    // Check for conflicts
    const eventsByDate = {};
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      if (!eventsByDate[r.date]) eventsByDate[r.date] = [];
      eventsByDate[r.date].push({ id: r.id, event: r.event, time: r.time, location: r.location, staff: staffList });
    });
    Object.entries(eventsByDate).forEach(([date, events]) => {
      if (events.length > 1) {
        const staffCounts = {};
        events.forEach(e => e.staff.forEach(s => { staffCounts[s] = (staffCounts[s] || 0) + 1; }));
        const doubleBooked = Object.entries(staffCounts).filter(([_, c]) => c > 1);
        if (doubleBooked.length > 0) {
          alerts.push({
            type: 'conflict',
            severity: 'critical',
            date,
            events,
            doubleBooked: Object.fromEntries(doubleBooked),
            message: `Conflict on ${date}: Staff ${doubleBooked.map(([s]) => s).join(', ')} double-booked`
          });
        }
      }
    });
    
    // Sort: critical first, then warning, then info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    
    res.json({ alerts, total: alerts.length, critical: alerts.filter(a => a.severity === 'critical').length });
  });
});

// POST /api/backup - manual backup trigger
app.post('/api/backup', async (req, res) => {
  try {
    const backupPath = await backupDatabase();
    res.json({ success: true, path: backupPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backups - list available backups
app.get('/api/backups', async (req, res) => {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter(f => f.startsWith('events-backup-')).sort().reverse();
    const backups = await Promise.all(files.map(async f => {
      const stat = await fs.stat(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, created: stat.mtime.toISOString() };
    }));
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics - comprehensive analytics
app.get('/api/analytics', (req, res) => {
  db.all(`SELECT * FROM events`, [], (err, events) => {
    if (err) return res.status(500).json({error: err.message});

    // Status breakdown
    const statusCounts = { pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
    events.forEach(e => { const s = e.status || 'pending'; if (statusCounts[s] !== undefined) statusCounts[s]++; });

    // Events by month
    const byMonth = {};
    events.forEach(e => { const m = e.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });

    // Events by week (current 12 weeks)
    const now = new Date();
    const weeks = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i * 7);
      const weekStart = new Date(d); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      weeks[key] = 0;
    }
    events.forEach(e => {
      const eDate = new Date(e.date);
      const weekStart = new Date(eDate); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      if (weeks[key] !== undefined) weeks[key]++;
    });

    // Location frequency
    const locationCounts = {};
    events.forEach(e => { locationCounts[e.location] = (locationCounts[e.location] || 0) + 1; });
    const topLocations = Object.entries(locationCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Client frequency
    const clientCounts = {};
    events.forEach(e => { if (e.client) clientCounts[e.client] = (clientCounts[e.client] || 0) + 1; });
    const topClients = Object.entries(clientCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Staff utilization (events per staff member)
    const staffEventCounts = {};
    events.forEach(e => {
      const staffList = JSON.parse(e.staff || '[]');
      staffList.forEach(s => { staffEventCounts[s] = (staffEventCounts[s] || 0) + 1; });
    });
    const staffUtilization = Object.entries(staffEventCounts).sort((a, b) => b[1] - a[1]);

    // Average events per week (last 4 weeks)
    const recentWeekCounts = Object.entries(weeks).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 4).map(v => v[1]);
    const avgPerWeek = recentWeekCounts.length > 0 ? (recentWeekCounts.reduce((a, b) => a + b, 0) / recentWeekCounts.length).toFixed(1) : 0;

    // Upcoming count (next 7 days)
    const today = now.toISOString().slice(0, 10);
    const nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().slice(0, 10);
    const upcomingCount = events.filter(e => e.date >= today && e.date <= nextWeekStr && (e.status !== 'cancelled')).length;

    res.json({
      summary: {
        total: events.length,
        upcoming7days: upcomingCount,
        avgEventsPerWeek: parseFloat(avgPerWeek),
        statusCounts,
        topLocation: topLocations[0] ? topLocations[0][0] : 'N/A',
        topClient: topClients[0] ? topClients[0][0] : 'N/A',
      },
      byMonth: Object.entries(byMonth).sort((a, b) => a[0] < b[0] ? -1 : 1),
      byWeek: Object.entries(weeks).sort((a, b) => a[0] < b[0] ? -1 : 1),
      topLocations,
      topClients,
      staffUtilization,
    });
  });
});

// DELETE /api/templates/:id
app.delete('/api/templates/:id', (req, res) => {
  db.run(`DELETE FROM event_templates WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    if (this.changes === 0) return res.status(404).json({error: 'Template not found'});
    res.json({ success: true, id: req.params.id });
  });
});

// GET /api/export/csv - Export events as CSV
app.get('/api/export/csv', (req, res) => {
  const { status, from, to } = req.query;
  let query = `SELECT * FROM events WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { query += ` AND (status = ? OR (status IS NULL AND ? = 'pending'))`; params.push(status, status); }
  if (from) { query += ` AND date >= ?`; params.push(from); }
  if (to) { query += ` AND date <= ?`; params.push(to); }
  query += ` ORDER BY date, time`;
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const headers = ['ID', 'Event', 'Date', 'Time', 'Location', 'Client', 'Services', 'Staff', 'Status', 'Notes'];
    const csvRows = [headers.join(',')];
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]').join('; ');
      const cols = [
        r.id,
        `"${(r.event || '').replace(/"/g, '""')}"`,
        r.date,
        r.time,
        `"${(r.location || '').replace(/"/g, '""')}"`,
        `"${(r.client || '').replace(/"/g, '""')}"`,
        `"${(r.services || '').replace(/"/g, '""')}"`,
        `"${staffList.replace(/"/g, '""')}"`,
        r.status || 'pending',
        `"${(r.notes || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
      ];
      csvRows.push(cols.join(','));
    });
    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="fresh-people-events-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  });
});

// GET /api/export/pdf - Export event(s) as PDF
app.get('/api/export/pdf', (req, res) => {
  const { id, status, from, to } = req.query;
  let query = `SELECT * FROM events WHERE 1=1`;
  const params = [];

  if (id) { query += ` AND id = ?`; params.push(id); }
  if (status && status !== 'all') { query += ` AND (status = ? OR (status IS NULL AND ? = 'pending'))`; params.push(status, status); }
  if (from) { query += ` AND date >= ?`; params.push(from); }
  if (to) { query += ` AND date <= ?`; params.push(to); }
  query += ` ORDER BY date, time`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows.length === 0) return res.status(404).json({ error: 'No events found' });

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const isSingle = !!id;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${isSingle ? 'event-' + id : 'fresh-people-events'}-${new Date().toISOString().slice(0,10)}.pdf"`);
    doc.pipe(res);

    // Title
    doc.fontSize(24).font('Helvetica-Bold').text('Fresh People Event Ops', { align: 'center' });
    doc.fontSize(14).font('Helvetica').text(isSingle ? 'Event Details' : 'Events Report', { align: 'center' });
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    // Summary for multi-event
    if (!isSingle) {
      doc.fontSize(12).font('Helvetica-Bold').text(`Total Events: ${rows.length}`);
      const statusCounts = { pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
      rows.forEach(r => { const s = r.status || 'pending'; if (statusCounts[s] !== undefined) statusCounts[s]++; });
      doc.fontSize(10).font('Helvetica').text(`Pending: ${statusCounts.pending} | Confirmed: ${statusCounts.confirmed} | Cancelled: ${statusCounts.cancelled} | Completed: ${statusCounts.completed}`);
      doc.moveDown(2);
    }

    // Events
    rows.forEach((r, idx) => {
      if (idx > 0) doc.addPage();

      const staffList = JSON.parse(r.staff || '[]');
      const statusLabel = (r.status || 'pending').toUpperCase();

      // Event header with status color
      doc.fontSize(16).font('Helvetica-Bold').text(`${r.event}`, { continued: false });
      doc.fontSize(9).font('Helvetica').fillColor(statusLabel === 'CONFIRMED' ? '#10b981' : statusLabel === 'CANCELLED' ? '#ef4444' : statusLabel === 'COMPLETED' ? '#3b82f6' : '#f59e0b').text(`Status: ${statusLabel}`);
      doc.fillColor('#000000');
      doc.moveDown(0.5);

      // Details table
      doc.fontSize(11).font('Helvetica');
      const details = [
        ['Event ID', r.id],
        ['Date', r.date],
        ['Time', r.time],
        ['Location', r.location],
        ['Client', r.client || 'N/A'],
        ['Services', r.services || 'N/A'],
        ['Assigned Staff', staffList.join(', ') || 'None'],
      ];

      details.forEach(([label, value]) => {
        doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
        doc.font('Helvetica').text(String(value || 'N/A'));
      });

      if (r.notes) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').text('Notes:', { continued: true });
        doc.font('Helvetica').text(r.notes);
      }

      // Staff list box
      if (staffList.length > 0) {
        doc.moveDown(1);
        doc.fontSize(12).font('Helvetica-Bold').text('Staff Assignment');
        doc.moveDown(0.5);
        staffList.forEach(s => {
          doc.fontSize(10).font('Helvetica').text(`• ${s}`);
        });
      }
    });

    doc.end();
  });
});

// GET /api/staff-timeline - Staff allocation timeline
app.get('/api/staff-timeline', (req, res) => {
  db.all(`SELECT id, event, date, time, location, staff, status FROM events WHERE status != 'cancelled' ORDER BY date, time`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const staffMap = {};
    rows.forEach(r => {
      const staffList = JSON.parse(r.staff || '[]');
      staffList.forEach(name => {
        if (!staffMap[name]) staffMap[name] = [];
        staffMap[name].push({
          eventId: r.id,
          event: r.event,
          date: r.date,
          time: r.time,
          location: r.location,
          status: r.status || 'pending'
        });
      });
    });
    // Sort each staff's events by date/time
    Object.keys(staffMap).forEach(name => {
      staffMap[name].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    });
    res.json(staffMap);
  });
});

// POST /api/auto-assign - auto-assign staff based on required skills + availability
app.post('/api/auto-assign', (req, res) => {
  const { count, requiredSkills, eventDate, excludeStaff } = req.body;
  const needed = count || 8;
  const skills = Array.isArray(requiredSkills) ? requiredSkills : [];
  const exclude = Array.isArray(excludeStaff) ? excludeStaff : [];

  // If eventDate provided, also exclude unavailable staff
  const dateFilter = eventDate;

  db.all(`SELECT * FROM staff WHERE active = 1 ORDER BY name`, [], (err, allStaff) => {
    if (err) return res.status(500).json({ error: err.message });

    // Filter out excluded staff
    let candidates = allStaff.filter(s => !exclude.includes(s.name));

    // If eventDate provided, filter out unavailable staff
    if (dateFilter) {
      db.all(`SELECT staff_id FROM staff_availability WHERE date = ?`, [dateFilter], (err2, unavailable) => {
        if (err2) return res.status(500).json({ error: err2.message });
        const unavailableIds = unavailable.map(u => u.staff_id);
        candidates = candidates.filter(s => !unavailableIds.includes(s.id));
        performScoring(candidates, skills, needed, dateFilter);
      });
    } else {
      performScoring(candidates, skills, needed, dateFilter);
    }
  });

  function performScoring(candidates, skills, needed, dateFilter) {
    // Score each candidate based on skill match
    const scored = candidates.map(s => {
      let skillList = [];
      try { skillList = JSON.parse(s.skills || '[]'); } catch(e) { skillList = []; }
      let score = 0;
      skills.forEach(reqSkill => {
        if (skillList.some(cs => cs.toLowerCase() === reqSkill.toLowerCase())) {
          score += 10;
        }
      });
      if (skillList.length > 0 && skills.length === 0) score += 1;
      return { ...s, skillList, score };
    });

    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    let selected = [];
    if (skills.length > 0) {
      const withSkills = scored.filter(s => s.score > 0);
      const withoutSkills = scored.filter(s => s.score === 0);
      selected = [...withSkills, ...withoutSkills].slice(0, needed);
    } else {
      selected = scored.slice(0, needed);
    }

    const assigned = selected.map(s => s.name);
    const matchedSkills = selected.map(s => ({ name: s.name, skills: s.skillList }));

    const unavailableNote = dateFilter ? ' (unavailable staff excluded)' : '';
    res.json({
      assigned,
      count: assigned.length,
      matchedSkills,
      requestedSkills: skills,
      requestedCount: needed,
      message: assigned.length < needed
        ? `Only ${assigned.length} of ${needed} requested staff available${unavailableNote}`
        : `Successfully assigned ${assigned.length} staff members${unavailableNote}`,
      excludedUnavailable: dateFilter ? true : false
    });
  }
});

// POST /api/events/:id/duplicate - duplicate an event
app.post('/api/events/:id/duplicate', async (req, res) => {
  try {
    const eventId = req.params.id;
    const { date, count } = req.body;

    // Get original event
    const original = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Event not found'));
        resolve(row);
      });
    });

    const duplicateCount = count || 1;
    const createdEvents = [];
    let currentDate = date ? new Date(date) : new Date(original.date);

    for (let i = 0; i < duplicateCount; i++) {
      const dateStr = currentDate.toISOString().slice(0, 10);
      const id = await generateEventID(dateStr);
      const staffJSON = original.staff || '[]';
      const estCost = original.estimated_cost || 0;
      const actCost = original.actual_cost || 0;
      const curr = original.currency || 'ZAR';

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO events (id, event, date, time, location, client, services, staff, notes, estimated_cost, actual_cost, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, original.event, dateStr, original.time, original.location, original.client, original.services, staffJSON, original.notes || '', estCost, actCost, curr],
          function(err) {
            if (err) return reject(err);
            createdEvents.push({
              id, event: original.event, date: dateStr, time: original.time,
              location: original.location, client: original.client,
              services: original.services, staff: JSON.parse(staffJSON),
              notes: original.notes
            });
            resolve();
          }
        );
      });

      // Advance date by 7 days for each subsequent duplicate
      currentDate.setDate(currentDate.getDate() + 7);
    }

    // Create calendar files
    for (const evt of createdEvents) {
      try {
        const icsContent = generateICS(evt);
        await fs.writeFile(path.join(CALENDAR_DIR, `${evt.id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${evt.id}.json`), JSON.stringify(evt, null, 2));
      } catch (e) { console.error('Calendar file error:', e); }
    }

    // Auto-backup after duplication
    try { await backupDatabase(); } catch (e) { console.error('Backup failed:', e); }

    res.json({
      success: true,
      originalId: eventId,
      count: createdEvents.length,
      events: createdEvents,
      message: `Duplicated "${original.event}" ${createdEvents.length} time${createdEvents.length > 1 ? 's' : ''}`
    });
  } catch (err) {
    if (err.message === 'Event not found') return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ==================== BUDGET / COST TRACKING ====================

// GET /api/budgets - list all budgets
app.get('/api/budgets', (req, res) => {
  db.all(`SELECT * FROM budgets ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST /api/budgets - create a budget
app.post('/api/budgets', (req, res) => {
  const { name, amount, period, category, start_date, end_date } = req.body;
  if (!name || !amount) return res.status(400).json({ error: 'Name and amount are required' });
  db.run(
    `INSERT INTO budgets (name, amount, period, category, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)`,
    [name, amount, period || 'monthly', category || 'general', start_date || null, end_date || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, amount, period: period || 'monthly', category: category || 'general', start_date, end_date });
    }
  );
});

// DELETE /api/budgets/:id
app.delete('/api/budgets/:id', (req, res) => {
  db.run(`DELETE FROM budgets WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Budget not found' });
    res.json({ success: true, id: req.params.id });
  });
});

// GET /api/budget/summary - budget vs actual spending summary
app.get('/api/budget/summary', (req, res) => {
  db.all(`SELECT * FROM events`, [], (err, events) => {
    if (err) return res.status(500).json({ error: err.message });

    // Total estimated vs actual
    let totalEstimated = 0;
    let totalActual = 0;
    const byMonth = {};
    const byClient = {};

    events.forEach(e => {
      const est = parseFloat(e.estimated_cost) || 0;
      const act = parseFloat(e.actual_cost) || 0;
      totalEstimated += est;
      totalActual += act;

      const month = e.date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { estimated: 0, actual: 0, count: 0 };
      byMonth[month].estimated += est;
      byMonth[month].actual += act;
      byMonth[month].count++;

      const client = e.client || 'Unknown';
      if (!byClient[client]) byClient[client] = { estimated: 0, actual: 0, count: 0 };
      byClient[client].estimated += est;
      byClient[client].actual += act;
      byClient[client].count++;
    });

    // Budgets
    db.all(`SELECT * FROM budgets`, [], (err2, budgets) => {
      if (err2) return res.status(500).json({ error: err2.message });

      res.json({
        totalEstimated: totalEstimated.toFixed(2),
        totalActual: totalActual.toFixed(2),
        variance: (totalActual - totalEstimated).toFixed(2),
        variancePercent: totalEstimated > 0 ? (((totalActual - totalEstimated) / totalEstimated) * 100).toFixed(1) : '0',
        eventCount: events.length,
        avgCostPerEvent: events.length > 0 ? (totalActual / events.length).toFixed(2) : '0',
        byMonth: Object.entries(byMonth).sort((a, b) => a[0] < b[0] ? -1 : 1),
        byClient: Object.entries(byClient).sort((a, b) => b[1].actual - a[1].actual).slice(0, 10),
        budgets
      });
    });
  });
});

// ==================== EMAIL NOTIFICATIONS ====================

// GET /api/settings/email - get SMTP settings (password hidden)
app.get('/api/settings/email', (req, res) => {
  db.get(`SELECT id, smtp_host, smtp_port, smtp_secure, smtp_user, from_name, from_email, auto_notify_client, auto_notify_staff, updated_at FROM email_settings WHERE id = 1`, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || {});
  });
});

// PUT /api/settings/email - update SMTP settings
app.put('/api/settings/email', (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_name, from_email, auto_notify_client, auto_notify_staff } = req.body;
  db.run(
    `UPDATE email_settings SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass=?, from_name=?, from_email=?, auto_notify_client=?, auto_notify_staff=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`,
    [smtp_host || '', smtp_port || 587, smtp_secure ? 1 : 0, smtp_user || '', smtp_pass || '', from_name || 'Fresh People Events', from_email || '', auto_notify_client ? 1 : 0, auto_notify_staff ? 1 : 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Email settings updated' });
    }
  );
});

// POST /api/settings/email/test - send test email
app.post('/api/settings/email/test', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  const r = await sendEmail(to, 'Fresh People Events - Test Email', '<h2>Test Email</h2><p>This is a test email from Fresh People Event Ops. If you received this, your SMTP configuration is working correctly!</p>', 'Test email from Fresh People Event Ops. SMTP is working!');
  if (r.success) res.json({ success: true, message: 'Test email sent successfully' });
  else res.status(500).json({ success: false, error: r.error });
});

// POST /api/notifications/email - queue an email notification
app.post('/api/notifications/email', (req, res) => {
  const { event_id, recipient, subject, body } = req.body;
  if (!recipient || !subject || !body) {
    return res.status(400).json({ error: 'recipient, subject, and body are required' });
  }
  db.run(
    `INSERT INTO email_notifications (event_id, recipient, subject, body, status) VALUES (?, ?, ?, ?, 'pending')`,
    [event_id || null, recipient, subject, body],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, status: 'pending', message: 'Email notification queued' });
    }
  );
});

// GET /api/notifications - list notification log
app.get('/api/notifications', (req, res) => {
  const { status, limit } = req.query;
  let query = `SELECT * FROM email_notifications`;
  const params = [];
  if (status) { query += ` WHERE status = ?`; params.push(status); }
  query += ` ORDER BY created_at DESC`;
  if (limit) { query += ` LIMIT ?`; params.push(parseInt(limit)); }
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST /api/notifications/send-pending - actually send pending emails via SMTP
app.post('/api/notifications/send-pending', async (req, res) => {
  db.all(`SELECT * FROM email_notifications WHERE status = 'pending' LIMIT 10`, [], async (err, pending) => {
    if (err) return res.status(500).json({ error: err.message });

    const settings = await getEmailSettings();
    const transporter = createTransporter(settings);
    if (!transporter) return res.status(400).json({ error: 'SMTP not configured. Set up email settings first.' });

    const results = [];
    for (const n of pending) {
      const from = `"${settings.from_name || 'Fresh People Events'}" <${settings.from_email || settings.smtp_user}>`;
      try {
        const info = await transporter.sendMail({
          from,
          to: n.recipient,
          subject: n.subject,
          html: n.body,
          text: n.body.replace(/<[^>]+>/g, '')
        });
        db.run(`UPDATE email_notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`, [n.id]);
        results.push({ id: n.id, recipient: n.recipient, subject: n.subject, status: 'sent', messageId: info.messageId });
      } catch (e) {
        db.run(`UPDATE email_notifications SET status = 'failed' WHERE id = ?`, [n.id]);
        results.push({ id: n.id, recipient: n.recipient, subject: n.subject, status: 'failed', error: e.message });
      }
    }
    res.json({ processed: results.length, results });
  });
});

// POST /api/notifications/:id/retry - retry a failed email
app.post('/api/notifications/:id/retry', async (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM email_notifications WHERE id = ?`, [id], async (err, n) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!n) return res.status(404).json({ error: 'Notification not found' });

    const settings = await getEmailSettings();
    const transporter = createTransporter(settings);
    if (!transporter) return res.status(400).json({ error: 'SMTP not configured' });

    const from = `"${settings.from_name || 'Fresh People Events'}" <${settings.from_email || settings.smtp_user}>`;
    try {
      const info = await transporter.sendMail({ from, to: n.recipient, subject: n.subject, html: n.body, text: n.body.replace(/<[^>]+>/g, '') });
      db.run(`UPDATE email_notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
      res.json({ success: true, messageId: info.messageId });
    } catch (e) {
      db.run(`UPDATE email_notifications SET status = 'failed' WHERE id = ?`, [id]);
      res.status(500).json({ success: false, error: e.message });
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Fresh People Event Ops', version: '4.10.0', timestamp: new Date().toISOString() });
});

// POST /api/events/recurring - create recurring events
app.post('/api/events/recurring', async (req, res) => {
  try {
    const { event, startDate, endDate, time, location, client, services, staff, notes, frequency } = req.body;
    if (!event || !startDate || !endDate || !time) {
      return res.status(400).json({ error: 'Event name, startDate, endDate, and time are required' });
    }

    const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly'];
    const freq = frequency || 'weekly';
    if (!validFrequencies.includes(freq)) {
      return res.status(400).json({ error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}` });
    }

    const createdEvents = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    const staffList = staff || [];

    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      const id = await generateEventID(dateStr);
      const activeStaffCount = await getActiveStaffCount();
      const warnings = [];
      if (staffList.length > activeStaffCount) {
        warnings.push(`Staff shortage: ${staffList.length} requested but only ${activeStaffCount} active`);
      }
      const staffJSON = JSON.stringify(staffList);
      const notesText = notes || `Dress Code: All Black\nArrival Time: ${parseInt(time.split(':')[0]) - 1}:${time.split(':')[1]}`;
      const fullNotes = warnings.length > 0 ? `${notesText}\n\n⚠️ WARNINGS:\n${warnings.join('\n')}` : notesText;

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO events (id, event, date, time, location, client, services, staff, notes, estimated_cost, actual_cost, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, event, dateStr, time, location, client, services, staffJSON, fullNotes, estimated_cost || 0, actual_cost || 0, currency || 'ZAR'],
          function(err) {
            if (err) return reject(err);
            createdEvents.push({ id, event, date: dateStr, time, location, client, services, staff: staffList, notes: fullNotes });
            resolve();
          }
        );
      });

      // Advance to next occurrence
      if (freq === 'daily') current.setDate(current.getDate() + 1);
      else if (freq === 'weekly') current.setDate(current.getDate() + 7);
      else if (freq === 'biweekly') current.setDate(current.getDate() + 14);
      else if (freq === 'monthly') current.setMonth(current.getMonth() + 1);
    }

    // Create calendar files for each
    for (const evt of createdEvents) {
      try {
        const icsContent = generateICS(evt);
        await fs.writeFile(path.join(CALENDAR_DIR, `${evt.id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${evt.id}.json`), JSON.stringify(evt, null, 2));
      } catch (e) { console.error('Calendar file error:', e); }
    }

    // Auto-backup after batch creation
    try { await backupDatabase(); } catch (e) { console.error('Backup failed:', e); }

    res.json({ success: true, count: createdEvents.length, events: createdEvents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fresh People Event Ops v4.10 running on http://0.0.0.0:${PORT}`);
});
