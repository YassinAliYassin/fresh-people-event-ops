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
  const publicPaths = ['/login.html', '/api/auth/login', '/api/auth/register', '/api/auth/setup', '/ws'];
  if (publicPaths.includes(req.path)) return next();
  if (req.path === '/manifest.json' || req.path === '/sw.js') return next();
  if (req.path.startsWith('/icon')) return next();
  if (req.path.startsWith('/uploads/')) return next();
  // Public check-in routes (no auth required)
  if (req.path.startsWith('/checkin/')) return next();
  if (req.path.startsWith('/api/checkin/')) return next();
  // Public feedback submission (no auth required)
  if (req.method === 'POST' && /^\/api\/events\/[^\/]+\/feedback$/.test(req.path)) return next();

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

// Add check-in columns to events table (migration)
db.run(`ALTER TABLE events ADD COLUMN check_in_enabled INTEGER DEFAULT 0`, () => {});
db.run(`ALTER TABLE events ADD COLUMN check_in_code TEXT DEFAULT ''`, () => {});
db.run(`ALTER TABLE events ADD COLUMN check_in_count INTEGER DEFAULT 0`, () => {});

// Create event_check_ins table for tracking individual check-ins
db.run(`CREATE TABLE IF NOT EXISTS event_check_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  person_type TEXT DEFAULT 'guest',
  check_in_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes TEXT DEFAULT '',
  FOREIGN KEY (event_id) REFERENCES events(id)
)`);

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

// Create event_reviews table for post-event internal reviews
db.run(`CREATE TABLE IF NOT EXISTS event_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  reviewer TEXT DEFAULT '',
  overall_rating INTEGER DEFAULT 0,
  staff_rating INTEGER DEFAULT 0,
  venue_rating INTEGER DEFAULT 0,
  client_rating INTEGER DEFAULT 0,
  logistics_rating INTEGER DEFAULT 0,
  highlights TEXT DEFAULT '',
  issues TEXT DEFAULT '',
  recommendations TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id)
)`);

// Create attendee_feedback table for collecting feedback from event attendees
db.run(`CREATE TABLE IF NOT EXISTS attendee_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  attendee_name TEXT DEFAULT '',
  attendee_email TEXT DEFAULT '',
  rating INTEGER DEFAULT 0,
  feedback TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  is_public INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id)
)`);

// Add review columns to events table (migration)
db.run(`ALTER TABLE events ADD COLUMN review_completed INTEGER DEFAULT 0`, () => {});
db.run(`ALTER TABLE events ADD COLUMN avg_rating REAL DEFAULT 0`, () => {});

// Create clients table for client management
db.run(`CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  vat_number TEXT DEFAULT '',
  payment_terms TEXT DEFAULT '30 days',
  notes TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  is_active INTEGER DEFAULT 1,
  total_events INTEGER DEFAULT 0,
  total_revenue REAL DEFAULT 0,
  last_event_date TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Add client_id to events table (migration)
db.run(`ALTER TABLE events ADD COLUMN client_id INTEGER DEFAULT 0`, () => {});

// Create client_communications log table
db.run(`CREATE TABLE IF NOT EXISTS client_communications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  event_id TEXT DEFAULT '',
  type TEXT DEFAULT 'email',
  direction TEXT DEFAULT 'outbound',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  status TEXT DEFAULT 'sent',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
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

// ==================== INVENTORY / EQUIPMENT MANAGEMENT ====================

// Create equipment inventory table
db.run(`CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  description TEXT DEFAULT '',
  serial_number TEXT DEFAULT '',
  purchase_date TEXT DEFAULT '',
  purchase_cost REAL DEFAULT 0,
  condition TEXT DEFAULT 'good',
  status TEXT DEFAULT 'available',
  location TEXT DEFAULT '',
  quantity INTEGER DEFAULT 1,
  quantity_available INTEGER DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Create event_equipment table for tracking equipment assigned to events
db.run(`CREATE TABLE IF NOT EXISTS event_equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  equipment_id INTEGER NOT NULL,
  quantity INTEGER DEFAULT 1,
  checked_out INTEGER DEFAULT 0,
  checked_out_at TIMESTAMP,
  checked_out_by TEXT DEFAULT '',
  checked_in INTEGER DEFAULT 0,
  checked_in_at TIMESTAMP,
  checked_in_by TEXT DEFAULT '',
  condition_before TEXT DEFAULT 'good',
  condition_after TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (equipment_id) REFERENCES equipment(id)
)`);

// Seed default equipment if table is empty
db.get(`SELECT COUNT(*) as count FROM equipment`, (err, row) => {
  if (row && row.count === 0) {
    const defaultEquipment = [
      ['PA System (Large)', 'audio', 'JBL EON615 15" PA system with mixer', '', '', 8500, 'good', 'available', 'Store Room A', 2, 2, 'Main stage PA'],
      ['PA System (Small)', 'audio', 'JBL EON6110 10" portable PA', '', '', 4500, 'good', 'available', 'Store Room A', 3, 3, 'Small events & speeches'],
      ['Wireless Microphone', 'audio', 'Shure SM58 wireless handheld mic', '', '', 2800, 'good', 'available', 'Store Room A', 6, 6, ''],
      ['Wired Microphone', 'audio', 'Shure SM58 wired mic with XLR cable', '', '', 800, 'good', 'available', 'Store Room A', 8, 8, ''],
      ['Projector (HD)', 'visual', 'Epson EB-2247U 4500 lumen WUXGA projector', '', '', 12000, 'good', 'available', 'Store Room B', 2, 2, ''],
      ['Projector Screen (120")', 'visual', '120" tripod projection screen', '', '', 1500, 'good', 'available', 'Store Room B', 3, 3, ''],
      ['LED Stage Lighting Kit', 'lighting', '4x LED par cans with DMX controller', '', '', 3500, 'good', 'available', 'Store Room C', 4, 4, ''],
      ['Fog Machine', 'lighting', '1500W fog machine with remote', '', '', 1200, 'good', 'available', 'Store Room C', 2, 2, ''],
      ['Round Table (6-seater)', 'furniture', '1.5m round banquet table', '', '', 450, 'good', 'available', 'Warehouse', 30, 30, ''],
      ['Rectangular Table (8-seater)', 'furniture', '1.8m x 0.75m rectangular table', '', '', 380, 'good', 'available', 'Warehouse', 20, 20, ''],
      ['Banquet Chair', 'furniture', 'Padded banquet chair (gold)', '', '', 120, 'good', 'available', 'Warehouse', 200, 200, ''],
      ['Glassware Set (wine)', 'catering', 'Crystal wine glasses (red & white)', '', '', 35, 'good', 'available', 'Kitchen Store', 100, 100, 'Per glass'],
      ['Glassware Set (champagne)', 'catering', 'Crystal champagne flutes', '', '', 40, 'good', 'available', 'Kitchen Store', 80, 80, 'Per glass'],
      ['Cutlery Set', 'catering', 'Stainless steel 3-piece cutlery set', '', '', 25, 'good', 'available', 'Kitchen Store', 200, 200, 'Per set'],
      ['Charger Plate (gold)', 'catering', '12" gold charger plate', '', '', 65, 'good', 'available', 'Kitchen Store', 100, 100, ''],
      ['Tablecloth (white)', 'linens', 'White satin tablecloth 220x220cm', '', '', 180, 'good', 'available', 'Linen Store', 50, 50, ''],
      ['Tablecloth (black)', 'linens', 'Black satin tablecloth 220x220cm', '', '', 180, 'good', 'available', 'Linen Store', 30, 30, ''],
      ['Napkins (white)', 'linens', 'White linen napkins', '', '', 12, 'good', 'available', 'Linen Store', 500, 500, 'Per napkin'],
      ['Tent/Marquee (6x6m)', 'structures', '6x6m frame tent with sidewalls', '', '', 15000, 'good', 'available', 'Outdoor Yard', 2, 2, 'Weather dependent'],
      ['Tent/Marquee (3x3m)', 'structures', '3x3m pop-up gazebo', '', '', 2500, 'good', 'available', 'Outdoor Yard', 4, 4, ''],
      ['Portable Bar', 'structures', '2.4m portable bar counter with skirt', '', '', 3500, 'good', 'available', 'Warehouse', 2, 2, ''],
      ['Cable Extension (10m)', 'power', '10m heavy-duty extension cable', '', '', 180, 'good', 'available', 'Store Room A', 10, 10, ''],
      ['Power Distribution Box', 'power', '32A distro box with RCD', '', '', 2200, 'good', 'available', 'Store Room A', 3, 3, ''],
      ['Walkie-Talkie Set', 'comms', 'Motorola T600 two-way radios', '', '', 1200, 'good', 'available', 'Store Room A', 10, 10, 'Per pair'],
      ['First Aid Kit', 'safety', 'Comprehensive first aid kit (SANS compliant)', '', '', 650, 'good', 'available', 'Store Room A', 3, 3, ''],
      ['Fire Extinguisher', 'safety', '4kg dry powder fire extinguisher', '', '', 350, 'good', 'available', 'Store Room A', 4, 4, 'Monthly inspection required'],
      ['Bollard (retractable)', 'safety', 'Stainless steel retractable bollard', '', '', 1800, 'good', 'available', 'Warehouse', 20, 20, ''],
      ['Red Carpet (per meter)', 'decor', 'Red carpet runner', '', '', 85, 'good', 'available', 'Store Room B', 50, 50, 'Per meter'],
      ['Uplight LED (battery)', 'lighting', 'Battery-powered LED uplight RGBWA+UV', '', '', 950, 'good', 'available', 'Store Room C', 12, 12, 'Wireless DMX'],
    ];
    const stmt = db.prepare(`INSERT INTO equipment (name, category, description, serial_number, purchase_date, purchase_cost, condition, status, location, quantity, quantity_available, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    defaultEquipment.forEach(e => stmt.run(e));
    stmt.finalize();
    console.log(`Seeded ${defaultEquipment.length} equipment items`);
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

// ==================== INVENTORY / EQUIPMENT API ENDPOINTS ====================

// GET /api/equipment - List all equipment with optional filters
app.get('/api/equipment', (req, res) => {
  const { category, status, search, available } = req.query;
  let sql = `SELECT * FROM equipment WHERE 1=1`;
  const params = [];
  if (category) { sql += ` AND category = ?`; params.push(category); }
  if (status) { sql += ` AND status = ?`; params.push(status); }
  if (search) { sql += ` AND (name LIKE ? OR description LIKE ? OR serial_number LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (available === 'true') { sql += ` AND quantity_available > 0 AND status = 'available'`; }
  sql += ` ORDER BY category, name`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// GET /api/equipment/categories - Get distinct categories
app.get('/api/equipment/categories', (req, res) => {
  db.all(`SELECT DISTINCT category FROM equipment ORDER BY category`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map(r => r.category));
  });
});

// GET /api/equipment/:id - Get single equipment
app.get('/api/equipment/:id', (req, res) => {
  db.get(`SELECT * FROM equipment WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    res.json(row);
  });
});

// POST /api/equipment - Create new equipment
app.post('/api/equipment', (req, res) => {
  const { name, category, description, serial_number, purchase_date, purchase_cost, condition, status, location, quantity, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Equipment name required' });
  const qty = quantity || 1;
  db.run(
    `INSERT INTO equipment (name, category, description, serial_number, purchase_date, purchase_cost, condition, status, location, quantity, quantity_available, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, category || 'general', description || '', serial_number || '', purchase_date || '', purchase_cost || 0, condition || 'good', status || 'available', location || '', qty, qty, notes || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM equipment WHERE id = ?`, [this.lastID], (err2, row) => {
        res.json({ success: true, equipment: row });
      });
    }
  );
});

// PUT /api/equipment/:id - Update equipment
app.put('/api/equipment/:id', (req, res) => {
  const { name, category, description, serial_number, purchase_date, purchase_cost, condition, status, location, quantity, quantity_available, notes } = req.body;
  db.run(
    `UPDATE equipment SET name=COALESCE(?,name), category=COALESCE(?,category), description=COALESCE(?,description), serial_number=COALESCE(?,serial_number), purchase_date=COALESCE(?,purchase_date), purchase_cost=COALESCE(?,purchase_cost), condition=COALESCE(?,condition), status=COALESCE(?,status), location=COALESCE(?,location), quantity=COALESCE(?,quantity), quantity_available=COALESCE(?,quantity_available), notes=COALESCE(?,notes), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [name, category, description, serial_number, purchase_date, purchase_cost, condition, status, location, quantity, quantity_available, notes, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM equipment WHERE id = ?`, [req.params.id], (err2, row) => {
        res.json({ success: true, equipment: row });
      });
    }
  );
});

// DELETE /api/equipment/:id - Delete equipment
app.delete('/api/equipment/:id', (req, res) => {
  db.run(`DELETE FROM event_equipment WHERE equipment_id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM equipment WHERE id = ?`, [req.params.id], function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

// GET /api/equipment/stats/summary - Equipment statistics
app.get('/api/equipment/stats/summary', (req, res) => {
  db.get(`SELECT COUNT(*) as total_items, SUM(quantity) as total_units, SUM(purchase_cost * quantity) as total_value, SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available_count, SUM(CASE WHEN status='maintenance' THEN 1 ELSE 0 END) as maintenance_count, SUM(CASE WHEN status='retired' THEN 1 ELSE 0 END) as retired_count FROM equipment`, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(`SELECT category, COUNT(*) as count, SUM(quantity) as units FROM equipment GROUP BY category ORDER BY count DESC`, [], (err2, cats) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ...row, categories: cats || [] });
    });
  });
});

// ==================== EVENT-EQUIPMENT ASSIGNMENT API ====================

// GET /api/events/:id/equipment - Get equipment assigned to an event
app.get('/api/events/:id/equipment', (req, res) => {
  db.all(
    `SELECT ee.*, e.name as equipment_name, e.category, e.condition as current_condition, e.location as storage_location
     FROM event_equipment ee JOIN equipment e ON ee.equipment_id = e.id
     WHERE ee.event_id = ? ORDER BY e.category, e.name`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// POST /api/events/:id/equipment - Assign equipment to an event
app.post('/api/events/:id/equipment', (req, res) => {
  const { equipment_id, quantity, notes } = req.body;
  if (!equipment_id) return res.status(400).json({ error: 'equipment_id required' });
  const qty = quantity || 1;

  // Check availability
  db.get(`SELECT quantity_available, name FROM equipment WHERE id = ?`, [equipment_id], (err, eq) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    if (eq.quantity_available < qty) return res.status(400).json({ error: `Only ${eq.quantity_available} of ${eq.name} available` });

    db.run(
      `INSERT INTO event_equipment (event_id, equipment_id, quantity, condition_before, notes) VALUES (?, ?, ?, 'good', ?)`,
      [req.params.id, equipment_id, qty, notes || ''],
      function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        // Decrease available quantity
        db.run(`UPDATE equipment SET quantity_available = quantity_available - ? WHERE id = ?`, [qty, equipment_id]);
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

// DELETE /api/events/:id/equipment/:eeid - Remove equipment from event
app.delete('/api/events/:id/equipment/:eeid', (req, res) => {
  db.get(`SELECT equipment_id, quantity, checked_out FROM event_equipment WHERE id = ?`, [req.params.eeid], (err, ee) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!ee) return res.status(404).json({ error: 'Assignment not found' });
    // Restore available quantity
    db.run(`UPDATE equipment SET quantity_available = quantity_available + ? WHERE id = ?`, [ee.quantity, ee.equipment_id]);
    db.run(`DELETE FROM event_equipment WHERE id = ?`, [req.params.eeid], function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ success: true, deleted: this.changes });
    });
  });
});

// POST /api/event-equipment/:id/checkout - Check out equipment for an event
app.post('/api/event-equipment/:id/checkout', (req, res) => {
  const { checked_out_by } = req.body;
  db.run(
    `UPDATE event_equipment SET checked_out = 1, checked_out_at = CURRENT_TIMESTAMP, checked_out_by = ? WHERE id = ? AND checked_out = 0`,
    [checked_out_by || 'system', req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(400).json({ error: 'Already checked out or not found' });
      res.json({ success: true, message: 'Equipment checked out' });
    }
  );
});

// POST /api/event-equipment/:id/checkin - Check in equipment after an event
app.post('/api/event-equipment/:id/checkin', (req, res) => {
  const { condition_after, checked_in_by } = req.body;
  db.get(`SELECT * FROM event_equipment WHERE id = ?`, [req.params.id], (err, ee) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!ee) return res.status(404).json({ error: 'Assignment not found' });
    if (!ee.checked_out) return res.status(400).json({ error: 'Equipment not checked out' });

    db.run(
      `UPDATE event_equipment SET checked_in = 1, checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ?, condition_after = ? WHERE id = ?`,
      [checked_in_by || 'system', condition_after || 'good', req.params.id],
      function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        // Restore available quantity
        db.run(`UPDATE equipment SET quantity_available = quantity_available + ? WHERE id = ?`, [ee.quantity, ee.equipment_id]);
        // Update equipment condition if changed
        if (condition_after && condition_after !== 'good') {
          db.run(`UPDATE equipment SET condition = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [condition_after, ee.equipment_id]);
        }
        res.json({ success: true, message: 'Equipment checked in' });
      }
    );
  });
});

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

// PUT /api/auth/users/:id - update user (admin only)
app.put('/api/auth/users/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { username, display_name, role, active, password } = req.body;
  const userId = req.params.id;

  // Build dynamic update
  const updates = [];
  const params = [];

  if (username !== undefined) { updates.push('username = ?'); params.push(username); }
  if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
  if (role !== undefined) { updates.push('role = ?'); params.push(role); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    updates.push('password_hash = ?'); params.push(bcrypt.hashSync(password, 10));
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(userId);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, message: 'User updated' });
  });
});

// DELETE /api/auth/users/:id - delete user (admin only, prevent self-delete)
app.delete('/api/auth/users/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const userId = req.params.id;

  // Prevent self-deletion
  db.get(`SELECT username FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.username === req.user.username) return res.status(400).json({ error: 'Cannot delete your own account' });

    // Prevent deleting the last admin
    db.get(`SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1`, [], (err, countRow) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT role FROM users WHERE id = ?`, [userId], (err, userRow) => {
        if (err) return res.status(500).json({ error: err.message });
        if (userRow && userRow.role === 'admin' && countRow.count <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last active admin' });
        }
        db.run(`DELETE FROM users WHERE id = ?`, [userId], function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, message: 'User deleted' });
        });
      });
    });
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
    const { event, date, time, location, client, client_id, client_email, services, staff, notes, estimated_cost, actual_cost, currency, budget, guests, end_time } = req.body;
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
    const cliId = client_id || 0;
    const guestCount = guests || 0;
    const endTime = end_time || '';
    
    db.run(
      `INSERT INTO events (id, event, date, time, end_time, location, client, client_id, client_email, services, staff, notes, estimated_cost, actual_cost, currency, budget, guests) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, event, date, time, endTime, location, client, cliId, cliEmail, services, staffJSON, fullNotes, estCost, actCost, curr, evtBudget, guestCount],
      async function(err) {
        if (err) return res.status(500).json({error: err.message});
        const newEvent = {id, event, date, time, end_time: endTime, location, client, client_id: cliId, client_email: cliEmail, services, staff: staffList, notes: fullNotes, warnings, estimated_cost: estCost, actual_cost: actCost, currency: curr, budget: evtBudget, guests: guestCount};
        const icsContent = generateICS(newEvent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
        await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(newEvent, null, 2));
        // Auto-backup on event creation
        try { await backupDatabase(); } catch(e) { console.error('Backup failed:', e); }
        // Auto-notify client and staff via email
        try { await autoNotifyEvent(newEvent, staffList); } catch(e) { console.error('Auto-notify failed:', e); }
        // Update client stats if linked
        if (cliId > 0) {
          try {
            db.run(`UPDATE clients SET total_events = total_events + 1, last_event_date = ?, updated_at = ? WHERE id = ?`,
              [date, new Date().toISOString(), cliId]);
          } catch(e) { console.error('Client stats update failed:', e); }
        }
        // Send push notification
        try { sendPushNotification(`New Event: ${event}`, `${date} at ${time} - ${location}`, '/'); } catch(e) { console.error('Push notify failed:', e); }
        // Broadcast real-time update
        try { broadcast({ type: 'event_created', event: newEvent }); } catch(e) { console.error('Broadcast failed:', e); }
        res.json(newEvent);
      }
    );
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// PUT /api/events/:id
app.put('/api/events/:id', (req, res) => {
  const { event, date, time, location, client, client_id, client_email, services, staff, notes, estimated_cost, actual_cost, currency, budget, guests, end_time } = req.body;
  const id = req.params.id;
  const staffJSON = JSON.stringify(staff || []);
  const estCost = estimated_cost || 0;
  const actCost = actual_cost || 0;
  const curr = currency || 'ZAR';
  const evtBudget = budget || 0;
  const cliId = client_id || 0;
  const guestCount = guests || 0;
  const endTime = end_time || '';
  db.run(
    `UPDATE events SET event=?, date=?, time=?, end_time=?, location=?, client=?, client_id=?, client_email=?, services=?, staff=?, notes=?, estimated_cost=?, actual_cost=?, currency=?, budget=?, guests=? WHERE id=?`,
    [event, date, time, endTime, location, client, cliId, client_email || '', services, staffJSON, notes, estCost, actCost, curr, evtBudget, guestCount, id],
    async function(err) {
      if (err) return res.status(500).json({error: err.message});
      if (this.changes === 0) return res.status(404).json({error: 'Event not found'});
      const updatedEvent = {id, event, date, time, end_time: endTime, location, client, client_id: cliId, services, staff: JSON.parse(staffJSON), notes, estimated_cost: estCost, actual_cost: actCost, currency: curr, budget: evtBudget, guests: guestCount};
      const icsContent = generateICS(updatedEvent);
      await fs.writeFile(path.join(CALENDAR_DIR, `${id}.ics`), icsContent);
      await fs.writeFile(path.join(CALENDAR_DIR, `${id}.json`), JSON.stringify(updatedEvent, null, 2));
      // Broadcast real-time update
      try { broadcast({ type: 'event_updated', event: updatedEvent }); } catch(e) { console.error('Broadcast failed:', e); }
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
    try { broadcast({ type: 'event_status_changed', eventId: id, status }); } catch(e) { console.error('Broadcast failed:', e); }
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
  res.json({ status: 'ok', service: 'Fresh People Event Ops', version: '4.16.0', timestamp: new Date().toISOString() });
});

// POST /api/events/recurring - create recurring events
app.post('/api/events/recurring', async (req, res) => {
  try {
    const { event, startDate, endDate, time, location, client, client_id, services, staff, notes, frequency } = req.body;
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

      const cliId = client_id || 0;
      const estCost = estimated_cost || 0;
      const actCost = actual_cost || 0;
      const curr = currency || 'ZAR';

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO events (id, event, date, time, location, client, client_id, services, staff, notes, estimated_cost, actual_cost, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, event, dateStr, time, location, client, cliId, services, staffJSON, fullNotes, estCost, actCost, curr],
          function(err) {
            if (err) return reject(err);
            createdEvents.push({ id, event, date: dateStr, time, location, client, client_id: cliId, services, staff: staffList, notes: fullNotes });
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

    // Broadcast real-time update for batch creation
    try { broadcast({ type: 'events_created', events: createdEvents }); } catch(e) { console.error('Broadcast failed:', e); }
     res.json({ success: true, count: createdEvents.length, events: createdEvents });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== QR CODE CHECK-IN SYSTEM ====================

const QRCode = require('qrcode');

// POST /api/events/:id/checkin-toggle - Enable/disable check-in for an event
app.post('/api/events/:id/checkin-toggle', (req, res) => {
  const { id } = req.params;
  const { enable } = req.body;

  if (enable) {
    // Generate a unique check-in code
    const checkInCode = `CHK-${id}-${uuidv4().slice(0, 8).toUpperCase()}`;
    db.run(
      `UPDATE events SET check_in_enabled = 1, check_in_code = ? WHERE id = ?`,
      [checkInCode, id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        broadcast({ type: 'checkin_toggled', eventId: id, enabled: true });
        res.json({ success: true, enabled: true, check_in_code: checkInCode });
      }
    );
  } else {
    db.run(
      `UPDATE events SET check_in_enabled = 0 WHERE id = ?`,
      [id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        broadcast({ type: 'checkin_toggled', eventId: id, enabled: false });
        res.json({ success: true, enabled: false });
      }
    );
  }
});

// GET /api/events/:id/checkin-code - Get QR code for event
app.get('/api/events/:id/checkin-code', async (req, res) => {
  const { id } = req.params;
  const { format } = req.query; // 'png' or 'dataurl'

  db.get(`SELECT * FROM events WHERE id = ?`, [id], async (err, event) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.check_in_enabled || !event.check_in_code) {
      return res.status(400).json({ error: 'Check-in not enabled for this event' });
    }

    const checkInUrl = `${req.protocol}://${req.get('host')}/checkin/${event.check_in_code}`;

    try {
      if (format === 'png') {
        const pngBuffer = await QRCode.toBuffer(checkInUrl, {
          type: 'png',
          width: 400,
          margin: 2,
          color: { dark: '#1f2937', light: '#ffffff' }
        });
        res.setHeader('Content-Type', 'image/png');
        res.send(pngBuffer);
      } else {
        const dataUrl = await QRCode.toDataURL(checkInUrl, {
          width: 400,
          margin: 2,
          color: { dark: '#1f2937', light: '#ffffff' }
        });
        res.json({ success: true, data_url: dataUrl, url: checkInUrl });
      }
    } catch (e) {
      res.status(500).json({ error: 'QR generation failed: ' + e.message });
    }
  });
});

// GET /api/events/:id/checkins - List check-ins for an event
app.get('/api/events/:id/checkins', (req, res) => {
  const { id } = req.params;
  db.all(
    `SELECT * FROM event_check_ins WHERE event_id = ? ORDER BY check_in_time DESC`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, check_ins: rows, count: rows.length });
    }
  );
});

// POST /api/checkin/:checkCode - Public check-in (no auth required)
app.post('/api/checkin/:checkCode', (req, res) => {
  const { checkCode } = req.params;
  const { person_name, person_type, notes } = req.body;

  if (!person_name) {
    return res.status(400).json({ error: 'Person name is required' });
  }

  // Find event by check-in code
  db.get(`SELECT * FROM events WHERE check_in_code = ? AND check_in_enabled = 1`, [checkCode], (err, event) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!event) return res.status(404).json({ error: 'Invalid or expired check-in code' });

    // Insert check-in record
    db.run(
      `INSERT INTO event_check_ins (event_id, person_name, person_type, notes) VALUES (?, ?, ?, ?)`,
      [event.id, person_name, person_type || 'guest', notes || ''],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Update check-in count
        db.run(`UPDATE events SET check_in_count = check_in_count + 1 WHERE id = ?`, [event.id]);

        broadcast({
          type: 'checkin_new',
          eventId: event.id,
          eventName: event.event,
          personName: person_name,
          personType: person_type || 'guest',
          checkInTime: new Date().toISOString()
        });

        res.json({
          success: true,
          id: this.lastID,
          event: event.event,
          event_date: event.date,
          event_time: event.time,
          location: event.location,
          person_name,
          check_in_time: new Date().toISOString()
        });
      }
    );
  });
});

// GET /api/checkin/:checkCode/event - Get event info for a check-in code (public, no auth)
app.get('/api/checkin/:checkCode/event', (req, res) => {
  const { checkCode } = req.params;
  db.get(
    `SELECT id, event, date, time, location, check_in_enabled, check_in_count FROM events WHERE check_in_code = ? AND check_in_enabled = 1`,
    [checkCode],
    (err, event) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!event) return res.status(404).json({ error: 'Invalid or expired check-in code' });
      res.json({ success: true, event });
    }
  );
});

// DELETE /api/checkins/:id - Remove a check-in record (admin only)
app.delete('/api/checkins/:id', (req, res) => {
  const { id } = req.params;
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin required' });
  }

  db.get(`SELECT * FROM event_check_ins WHERE id = ?`, [id], (err, checkin) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!checkin) return res.status(404).json({ error: 'Check-in not found' });

    db.run(`DELETE FROM event_check_ins WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run(`UPDATE events SET check_in_count = MAX(0, check_in_count - 1) WHERE id = ?`, [checkin.event_id]);
      res.json({ success: true });
    });
  });
});

// GET /api/checkin-stats - Overall check-in statistics
app.get('/api/checkin-stats', (req, res) => {
  db.get(`SELECT COUNT(*) as total_checkins FROM event_check_ins`, (err, total) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT COUNT(*) as events_with_checkin FROM events WHERE check_in_enabled = 1`, (err2, events) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.all(
        `SELECT e.id, e.event, e.date, e.check_in_count
         FROM events e
         WHERE e.check_in_enabled = 1
         ORDER BY e.date DESC
         LIMIT 10`,
        (err3, recent) => {
          if (err3) return res.status(500).json({ error: err3.message });
          db.all(
            `SELECT DATE(check_in_time) as date, COUNT(*) as count
             FROM event_check_ins
             WHERE check_in_time >= datetime('now', '-7 days')
             GROUP BY DATE(check_in_time)
             ORDER BY date`,
            (err4, daily) => {
              if (err4) return res.status(500).json({ error: err4.message });
              res.json({
                success: true,
                total_checkins: total?.total_checkins || 0,
                events_with_checkin: events?.events_with_checkin || 0,
                recent_events: recent || [],
                daily_checkins: daily || []
              });
            }
          );
        }
      );
    });
  });
});

// Public check-in page - no auth required
app.get('/checkin/:checkCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

// ==================== EVENT REVIEWS & FEEDBACK ====================

// POST /api/events/:id/review - Submit a post-event review
app.post('/api/events/:id/review', (req, res) => {
  const { id } = req.params;
  const {
    reviewer, overall_rating, staff_rating, venue_rating,
    client_rating, logistics_rating, highlights, issues, recommendations
  } = req.body;

  db.run(
    `INSERT INTO event_reviews
     (event_id, reviewer, overall_rating, staff_rating, venue_rating, client_rating, logistics_rating, highlights, issues, recommendations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, reviewer || req.user?.username || 'anonymous',
      overall_rating || 0, staff_rating || 0, venue_rating || 0,
      client_rating || 0, logistics_rating || 0,
      highlights || '', issues || '', recommendations || ''
    ],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Update event review status
      db.run(`UPDATE events SET review_completed = 1 WHERE id = ?`, [id]);

      // Calculate average rating for the event
      db.get(
        `SELECT AVG(overall_rating) as avg FROM event_reviews WHERE event_id = ? AND overall_rating > 0`,
        [id],
        (err2, row) => {
          if (!err2 && row) {
            db.run(`UPDATE events SET avg_rating = ? WHERE id = ?`, [Math.round(row.avg * 10) / 10, id]);
          }
        }
      );

      // Broadcast review submission
      app.broadcast({ type: 'event_reviewed', eventId: id, reviewer: reviewer || req.user?.username });

      res.json({ success: true, id: this.lastID, message: 'Review submitted successfully' });
    }
  );
});

// GET /api/events/:id/reviews - Get all reviews for an event
app.get('/api/events/:id/reviews', (req, res) => {
  const { id } = req.params;
  db.all(
    `SELECT * FROM event_reviews WHERE event_id = ? ORDER BY created_at DESC`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, reviews: rows || [] });
    }
  );
});

// DELETE /api/reviews/:id - Delete a review (admin only)
app.delete('/api/reviews/:id', (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { id } = req.params;
  db.get(`SELECT event_id FROM event_reviews WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Review not found' });

    db.run(`DELETE FROM event_reviews WHERE id = ?`, [id], function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });

      // Recalculate avg rating
      db.get(
        `SELECT AVG(overall_rating) as avg FROM event_reviews WHERE event_id = ? AND overall_rating > 0`,
        [row.event_id],
        (err3, avgRow) => {
          db.run(`UPDATE events SET avg_rating = ? WHERE id = ?`,
            [avgRow && avgRow.avg ? Math.round(avgRow.avg * 10) / 10 : 0, row.event_id]);
        }
      );

      res.json({ success: true });
    });
  });
});

// POST /api/events/:id/feedback - Submit attendee feedback (public, no auth)
app.post('/api/events/:id/feedback', (req, res) => {
  const { id } = req.params;
  const { attendee_name, attendee_email, rating, feedback, category } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  db.run(
    `INSERT INTO attendee_feedback (event_id, attendee_name, attendee_email, rating, feedback, category)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, attendee_name || 'Anonymous', attendee_email || '', rating, feedback || '', category || 'general'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, message: 'Feedback submitted successfully' });
    }
  );
});

// GET /api/events/:id/feedback - Get feedback for an event
app.get('/api/events/:id/feedback', (req, res) => {
  const { id } = req.params;
  db.all(
    `SELECT * FROM attendee_feedback WHERE event_id = ? ORDER BY created_at DESC`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, feedback: rows || [] });
    }
  );
});

// GET /api/reviews/summary - Get review summary statistics
app.get('/api/reviews/summary', (req, res) => {
  db.get(
    `SELECT
      COUNT(*) as total_reviews,
      AVG(overall_rating) as avg_overall,
      AVG(staff_rating) as avg_staff,
      AVG(venue_rating) as avg_venue,
      AVG(client_rating) as avg_client,
      AVG(logistics_rating) as avg_logistics
     FROM event_reviews`,
    (err, reviewStats) => {
      if (err) return res.status(500).json({ error: err.message });

      db.get(
        `SELECT COUNT(*) as total_feedback, AVG(rating) as avg_attendee_rating
         FROM attendee_feedback`,
        (err2, feedbackStats) => {
          if (err2) return res.status(500).json({ error: err2.message });

          db.all(
            `SELECT e.id, e.event, e.date, e.avg_rating, e.review_completed,
                    COUNT(r.id) as review_count
             FROM events e
             LEFT JOIN event_reviews r ON e.id = r.event_id
             WHERE e.status = 'completed'
             GROUP BY e.id
             ORDER BY e.date DESC
             LIMIT 20`,
            (err3, completedEvents) => {
              if (err3) return res.status(500).json({ error: err3.message });

              db.all(
                `SELECT category, COUNT(*) as count, AVG(rating) as avg_rating
                 FROM attendee_feedback
                 GROUP BY category
                 ORDER BY count DESC`,
                (err4, categories) => {
                  if (err4) return res.status(500).json({ error: err4.message });

                  res.json({
                    success: true,
                    reviews: {
                      total: reviewStats?.total_reviews || 0,
                      avg_overall: reviewStats?.avg_overall ? Math.round(reviewStats.avg_overall * 10) / 10 : 0,
                      avg_staff: reviewStats?.avg_staff ? Math.round(reviewStats.avg_staff * 10) / 10 : 0,
                      avg_venue: reviewStats?.avg_venue ? Math.round(reviewStats.avg_venue * 10) / 10 : 0,
                      avg_client: reviewStats?.avg_client ? Math.round(reviewStats.avg_client * 10) / 10 : 0,
                      avg_logistics: reviewStats?.avg_logistics ? Math.round(reviewStats.avg_logistics * 10) / 10 : 0,
                    },
                    attendee_feedback: {
                      total: feedbackStats?.total_feedback || 0,
                      avg_rating: feedbackStats?.avg_attendee_rating ? Math.round(feedbackStats.avg_attendee_rating * 10) / 10 : 0,
                      categories: categories || []
                    },
                    completed_events: completedEvents || []
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// ==================== EVENT RUN SHEET ====================

// GET /api/events/:id/runsheet - Generate event run sheet data
app.get('/api/events/:id/runsheet', (req, res) => {
  const { id } = req.params;

  db.get(
    `SELECT * FROM events WHERE id = ?`,
    [id],
    (err, event) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!event) return res.status(404).json({ error: 'Event not found' });

      // Parse staff JSON array and resolve staff details
      let staffNames = [];
      try {
        staffNames = JSON.parse(event.staff || '[]');
      } catch(e) {
        staffNames = [];
      }

      if (staffNames.length === 0) {
        // No staff assigned - return event data only
        return res.json({
          success: true,
          runSheet: {
            event: {
              id: event.id,
              name: event.event,
              date: event.date,
              time: event.time || '',
              location: event.location || '',
              client: event.client || '',
              client_email: event.client_email || '',
              services: event.services || '',
              notes: event.notes || '',
              status: event.status || 'pending',
              estimated_cost: event.estimated_cost || 0,
              actual_cost: event.actual_cost || 0,
              budget: event.budget || 0,
              guests: event.guests || 0,
              },
              staff: [],
              previousEvents: [],
              nextEvent: null,
            generatedAt: new Date().toISOString(),
          }
        });
      }

      // Resolve staff details from staff table by name
      const placeholders = staffNames.map(() => '?').join(',');
      db.all(
        `SELECT name, role, phone, email, skills FROM staff WHERE name IN (${placeholders})`,
        staffNames,
        (err2, staffDetails) => {
          if (err2) return res.status(500).json({ error: err2.message });

          // Get previous events at same location for reference
          db.all(
            `SELECT id, event, date, status FROM events
             WHERE location = ? AND id != ? AND date <= ?
             ORDER BY date DESC LIMIT 3`,
            [event.location || '', id, event.date || ''],
            (err3, prevEvents) => {
              if (err3) return res.status(500).json({ error: err3.message });

              // Get next event (if any)
              db.get(
                `SELECT id, event, date FROM events
                 WHERE date >= ? AND id != ?
                 ORDER BY date ASC LIMIT 1`,
                [event.date || '', id],
                (err4, nextEvent) => {
                  if (err4) return res.status(500).json({ error: err4.message });

                  res.json({
                    success: true,
                    runSheet: {
                      event: {
                        id: event.id,
                        name: event.event,
                        date: event.date,
                        time: event.time || '',
                        location: event.location || '',
                        client: event.client || '',
                        client_email: event.client_email || '',
                        services: event.services || '',
                        notes: event.notes || '',
                        status: event.status || 'pending',
                        estimated_cost: event.estimated_cost || 0,
                        actual_cost: event.actual_cost || 0,
                        budget: event.budget || 0,
                        guests: event.guests || 0,
                      },
                      staff: staffDetails || [],
                      previousEvents: prevEvents || [],
                      nextEvent: nextEvent || null,
                      generatedAt: new Date().toISOString(),
                    }
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// GET /api/todays-events - Get today's events for dashboard widget
app.get('/api/todays-events', (req, res) => {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  db.all(
    `SELECT id, event, time, end_time, location, status, client, staff
     FROM events
     WHERE date = ?
     ORDER BY time ASC`,
    [today],
    (err, events) => {
      if (err) return res.status(500).json({ error: err.message });

      // Parse staff counts from JSON array
      events = events.map(e => {
        let staffCount = 0;
        try {
          staffCount = JSON.parse(e.staff || '[]').length;
        } catch(_) {}
        return { ...e, staff_count: staffCount };
      });

      // Get upcoming 7 days count
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const nextWeekStr = nextWeek.toISOString().split('T')[0];

      db.get(
        `SELECT COUNT(*) as count FROM events
         WHERE date >= ? AND date <= ? AND status != 'cancelled'`,
        [today, nextWeekStr],
        (err2, upcoming) => {
          if (err2) return res.status(500).json({ error: err2.message });

          res.json({
            success: true,
            date: today,
            events: events || [],
            upcomingWeek: upcoming?.count || 0,
          });
        }
      );
    }
  );
});

// ==================== CLIENT MANAGEMENT API ====================

// GET /api/clients - List all clients with search and filter
app.get('/api/clients', (req, res) => {
  const { search, tag, status, sort = 'name', order = 'ASC', limit = 100, offset = 0 } = req.query;

  let sql = `SELECT * FROM clients WHERE 1=1`;
  const params = [];

  if (search) {
    sql += ` AND (name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  if (tag) {
    sql += ` AND tags LIKE ?`;
    params.push(`%${tag}%`);
  }

  if (status === 'active') {
    sql += ` AND is_active = 1`;
  } else if (status === 'inactive') {
    sql += ` AND is_active = 0`;
  }

  const allowedSorts = ['name', 'company', 'total_events', 'total_revenue', 'last_event_date', 'created_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'name';
  const sortOrder = order === 'DESC' ? 'DESC' : 'ASC';

  sql += ` ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Parse tags JSON for each client
    const clients = rows.map(r => ({
      ...r,
      tags: JSON.parse(r.tags || '[]'),
    }));

    // Get total count
    db.get(`SELECT COUNT(*) as total FROM clients WHERE 1=1${search ? ` AND (name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ?)` : ''}${tag ? ` AND tags LIKE ?` : ''}${status === 'active' ? ` AND is_active = 1` : ''}${status === 'inactive' ? ` AND is_active = 0` : ''}`, search ? [ `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%` ] : [], (err2, countRow) => {
      res.json({
        success: true,
        clients,
        total: countRow?.total || clients.length,
      });
    });
  });
});

// GET /api/clients/:id - Get single client with event history
app.get('/api/clients/:id', (req, res) => {
  const { id } = req.params;

  db.get(`SELECT * FROM clients WHERE id = ?`, [id], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Parse tags
    client.tags = JSON.parse(client.tags || '[]');

    // Get event history
    db.all(
      `SELECT id, event, date, time, location, status, estimated_cost, actual_cost, guests, end_time
       FROM events
       WHERE client_id = ? OR client = ?
       ORDER BY date DESC
       LIMIT 50`,
      [id, client.name],
      (err2, events) => {
        if (err2) return res.status(500).json({ error: err2.message });

        // Get communication history
        db.all(
          `SELECT * FROM client_communications
           WHERE client_id = ?
           ORDER BY created_at DESC
           LIMIT 30`,
          [id],
          (err3, communications) => {
            if (err3) return res.status(500).json({ error: err3.message });

            // Calculate stats
            const totalEvents = events.length;
            const completedEvents = events.filter(e => e.status === 'completed').length;
            const totalRevenue = events.reduce((sum, e) => sum + (e.actual_cost || e.estimated_cost || 0), 0);

            res.json({
              success: true,
              client,
              events: events || [],
              communications: communications || [],
              stats: {
                totalEvents,
                completedEvents,
                totalRevenue,
              },
            });
          }
        );
      }
    );
  });
});

// POST /api/clients - Create new client
app.post('/api/clients', (req, res) => {
  const { name, company, email, phone, address, vat_number, payment_terms, notes, tags } = req.body;

  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]');
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO clients (name, company, email, phone, address, vat_number, payment_terms, notes, tags, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, company || '', email || '', phone || '', address || '', vat_number || '', payment_terms || '30 days', notes || '', tagsJson, now],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Auto-link existing events with matching client name
      db.all(`SELECT id FROM events WHERE client = ? AND client_id = 0`, [name], (err2, events) => {
        if (!err2 && events.length > 0) {
          const stmt = db.prepare(`UPDATE events SET client_id = ? WHERE id = ?`);
          events.forEach(e => stmt.run([this.lastID, e.id]));
          stmt.finalize();

          // Update client stats
          db.run(`UPDATE clients SET total_events = ?, last_event_date = (SELECT MAX(date) FROM events WHERE client_id = ?) WHERE id = ?`,
            [events.length, this.lastID, this.lastID]);
        }
      });

      res.json({
        success: true,
        id: this.lastID,
        message: `Client "${name}" created successfully`,
      });
    }
  );
});

// PUT /api/clients/:id - Update client
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const { name, company, email, phone, address, vat_number, payment_terms, notes, tags, is_active } = req.body;

  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]');
  const now = new Date().toISOString();

  db.run(
    `UPDATE clients SET name = ?, company = ?, email = ?, phone = ?, address = ?,
     vat_number = ?, payment_terms = ?, notes = ?, tags = ?, is_active = ?, updated_at = ?
     WHERE id = ?`,
    [name, company || '', email || '', phone || '', address || '', vat_number || '', payment_terms || '30 days', notes || '', tagsJson, is_active !== undefined ? (is_active ? 1 : 0) : 1, now, id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Client not found' });

      res.json({ success: true, message: `Client "${name}" updated successfully` });
    }
  );
});

// DELETE /api/clients/:id - Delete client
app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;

  db.get(`SELECT name FROM clients WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Client not found' });

    // Unlink events first
    db.run(`UPDATE events SET client_id = 0 WHERE client_id = ?`, [id], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.run(`DELETE FROM client_communications WHERE client_id = ?`, [id], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });

        db.run(`DELETE FROM clients WHERE id = ?`, [id], (err4) => {
          if (err4) return res.status(500).json({ error: err4.message });
          res.json({ success: true, message: `Client "${row.name}" deleted` });
        });
      });
    });
  });
});

// POST /api/clients/:id/communications - Log communication
app.post('/api/clients/:id/communications', (req, res) => {
  const { id } = req.params;
  const { event_id, type, direction, subject, body, status } = req.body;

  db.run(
    `INSERT INTO client_communications (client_id, event_id, type, direction, subject, body, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, event_id || '', type || 'email', direction || 'outbound', subject || '', body || '', status || 'sent'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, message: 'Communication logged' });
    }
  );
});

// GET /api/clients/stats/summary - Client statistics
app.get('/api/clients/stats/summary', (req, res) => {
  db.get(`SELECT COUNT(*) as total_clients FROM clients WHERE is_active = 1`, [], (err, active) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`SELECT COUNT(*) as total_clients FROM clients`, [], (err2, all) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.get(`SELECT SUM(total_revenue) as total_revenue FROM clients`, [], (err3, revenue) => {
        if (err3) return res.status(500).json({ error: err3.message });

        db.get(`SELECT SUM(total_events) as total_events FROM clients`, [], (err4, events) => {
          if (err4) return res.status(500).json({ error: err4.message });

          // Get top clients by revenue
          db.all(
            `SELECT id, name, company, total_events, total_revenue FROM clients
             WHERE is_active = 1 ORDER BY total_revenue DESC LIMIT 5`,
            [],
            (err5, topClients) => {
              if (err5) return res.status(500).json({ error: err5.message });

              res.json({
                success: true,
                activeClients: active?.total_clients || 0,
                totalClients: all?.total_clients || 0,
                totalRevenue: revenue?.total_revenue || 0,
                totalClientEvents: events?.total_events || 0,
                topClients: topClients || [],
              });
            }
          );
        });
      });
    });
  });
});

// ==================== WEBSOCKET SERVER ====================

const { WebSocketServer } = require('ws');
const http = require('http');

// Create HTTP server from express app
const server = http.createServer(app);

// WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

// Track connected clients
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  // Authenticate WebSocket connection via token query param
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  let authenticated = false;
  let username = 'anonymous';

  if (token && sessions.has(token)) {
    const session = sessions.get(token);
    if (session.expires > Date.now()) {
      authenticated = true;
      username = session.username;
    }
  }

  ws.authenticated = authenticated;
  ws.username = username;
  wsClients.add(ws);
  console.log(`WebSocket connected: ${username} (${authenticated ? 'auth' : 'unauth'})`);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`WebSocket disconnected: ${username}`);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${username}:`, err.message);
    wsClients.delete(ws);
  });
});

// Broadcast to all authenticated clients
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.authenticated && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(payload);
    }
  }
}

// Make broadcast available via app for use in routes
app.broadcast = broadcast;

// Override server start to use HTTP server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Fresh People Event Ops v4.16 running on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket server listening on ws://0.0.0.0:${PORT}`);
});
