// Database setup: SQLite file "union.db" is created automatically on first run
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database(process.env.DB_PATH || 'union.db');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  is_super INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS flats (
  flat_no TEXT PRIMARY KEY,
  owner   TEXT NOT NULL,
  phone   TEXT,
  pin     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS charges (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  amount INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bills (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  flat_no TEXT NOT NULL,
  month   TEXT NOT NULL,
  total   INTEGER NOT NULL,
  paid    INTEGER DEFAULT 0,
  paid_on TEXT,
  UNIQUE (flat_no, month)
);
CREATE TABLE IF NOT EXISTS payments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount  INTEGER NOT NULL,
  paid_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bill_items (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  amount  INTEGER NOT NULL
);
`);

// First run only: add default admin, charges and 3 demo flats
if (!db.prepare('SELECT 1 FROM admins').get()) {
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', bcrypt.hashSync('admin123', 10));
  const addCharge = db.prepare('INSERT INTO charges (name, amount) VALUES (?, ?)');
  [['Maintenance', 3000], ['Water', 500], ['Security', 800], ['Lift', 300]].forEach(c => addCharge.run(...c));
  const addFlat = db.prepare('INSERT INTO flats VALUES (?, ?, ?, ?)');
  [['A-101', 'Ahmed Khan', '0300-1111111', '1111'],
   ['A-102', 'Sara Ali', '0321-2222222', '2222'],
   ['B-201', 'Bilal Raza', '0333-3333333', '3333']]
    .forEach(f => addFlat.run(f[0], f[1], f[2], bcrypt.hashSync(f[3], 10)));
}

// Old databases: add the is_super column, and make the FIRST admin the main admin
if (!db.prepare('PRAGMA table_info(admins)').all().some(c => c.name === 'is_super'))
  db.exec('ALTER TABLE admins ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0');
if (!db.prepare('SELECT 1 FROM admins WHERE is_super = 1').get())
  db.exec('UPDATE admins SET is_super = 1 WHERE rowid = (SELECT MIN(rowid) FROM admins)');

module.exports = db;
