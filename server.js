const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
// Runs a route and sends errors back as JSON
const route = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) {
    const msg = /UNIQUE|constraint/i.test(e.message) ? 'This record already exists' : e.message;
    res.status(400).json({ error: msg });
  }
};

// Checks the login token
function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Please log in again' });
  }
}

// Any admin (view access). The admin must still exist in the database.
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!db.prepare('SELECT 1 FROM admins WHERE username = ?').get(req.user.id))
    return res.status(401).json({ error: 'Please log in again' });
  next();
}

// Only the main (first) admin can add, change or delete anything
function superOnly(req, res, next) {
  const a = req.user.role === 'admin' && db.prepare('SELECT is_super FROM admins WHERE username = ?').get(req.user.id);
  if (a && a.is_super) next();
  else res.status(403).json({ error: 'Only the main admin can do this. You have view-only access.' });
}

// Bills with their items, payments and balance (and flat owner details)
// status: 'paid' | 'partial' | 'unpaid'
function getBills(where, args) {
  const bills = db.prepare(`
    SELECT b.*, f.owner, f.phone FROM bills b
    LEFT JOIN flats f ON f.flat_no = b.flat_no
    ${where} ORDER BY b.month DESC, b.flat_no`).all(...args);
  const items = db.prepare('SELECT name, amount FROM bill_items WHERE bill_id = ?');
  const pays = db.prepare('SELECT id, amount, paid_on FROM payments WHERE bill_id = ? ORDER BY id');
  return bills.map(b => {
    const payments = pays.all(b.id);
    const sum = payments.reduce((s, p) => s + p.amount, 0);
    // old bills marked paid before partial payments existed have no payment rows
    const received = b.paid ? b.total : Math.min(sum, b.total);
    const status = received >= b.total ? 'paid' : received > 0 ? 'partial' : 'unpaid';
    return { ...b, paid: !!b.paid, items: items.all(b.id), payments, received, balance: b.total - received, status };
  });
}

// ---------- login ----------
app.post('/api/login', route((req, res) => {
  const { role, user, pass } = req.body;
  let row, hash, id, isSuper = false;
  if (role === 'admin') {
    row = db.prepare('SELECT * FROM admins WHERE username = ?').get(user);
    hash = row && row.password; id = row && row.username;
    isSuper = !!(row && row.is_super);
  } else {
    row = db.prepare('SELECT * FROM flats WHERE flat_no = ? COLLATE NOCASE').get(user);
    hash = row && row.pin; id = row && row.flat_no;
  }
  if (!hash || !bcrypt.compareSync(String(pass), hash))
    return res.status(401).json({ error: 'Wrong username or password' });
  const token = jwt.sign({ role, id }, SECRET, { expiresIn: '8h' });
  res.json({ token, role, name: id, isSuper });
}));

// ---------- who am I (used by the app to show/hide edit buttons) ----------
app.get('/api/me', auth, route((req, res) => {
  if (req.user.role !== 'admin') return res.json({ role: 'user', isSuper: false });
  const a = db.prepare('SELECT username, is_super FROM admins WHERE username = ?').get(req.user.id);
  if (!a) return res.status(401).json({ error: 'Please log in again' });
  res.json({ role: 'admin', name: a.username, isSuper: !!a.is_super });
}));

// ---------- admins (main admin only) ----------
app.get('/api/admins', auth, superOnly, route((req, res) => {
  res.json(db.prepare('SELECT username, is_super FROM admins ORDER BY rowid').all());
}));

app.post('/api/admins', auth, superOnly, route((req, res) => {
  const username = String(req.body.username || '').trim(), password = String(req.body.password || '');
  if (!username) throw new Error('Username is required');
  if (password.length < 4) throw new Error('Password must be at least 4 characters');
  db.prepare('INSERT INTO admins (username, password, is_super) VALUES (?, ?, 0)').run(username, bcrypt.hashSync(password, 10));
  res.json({ ok: true });
}));

app.put('/api/admins/:username/password', auth, superOnly, route((req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 4) throw new Error('Password must be at least 4 characters');
  const r = db.prepare('UPDATE admins SET password = ? WHERE username = ?').run(bcrypt.hashSync(password, 10), req.params.username);
  if (!r.changes) throw new Error('Admin not found');
  res.json({ ok: true });
}));

app.delete('/api/admins/:username', auth, superOnly, route((req, res) => {
  const a = db.prepare('SELECT is_super FROM admins WHERE username = ?').get(req.params.username);
  if (!a) throw new Error('Admin not found');
  if (a.is_super) throw new Error('The main admin cannot be removed');
  db.prepare('DELETE FROM admins WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
}));

// ---------- bills ----------
// Admin sees all bills, resident sees only their own flat
app.get('/api/bills', auth, route((req, res) => {
  res.json(req.user.role === 'admin' ? getBills('', []) : getBills('WHERE b.flat_no = ?', [req.user.id]));
}));

// Create bills for the chosen flats (or all flats) for the chosen month.
// If a bill already exists for that flat + month, it is regenerated (replaced)
// unless it is already paid or part-paid - those bills are never touched.
app.post('/api/bills/generate', auth, superOnly, route((req, res) => {
  const { month, chargeIds, flatNos } = req.body;
  if (!/^\d{4}-\d{2}$/.test(month) || !chargeIds || !chargeIds.length)
    throw new Error('Select a month and at least one charge');
  if (!Array.isArray(flatNos) || !flatNos.length)
    throw new Error('Select at least one flat');
  const charges = db.prepare(`SELECT * FROM charges WHERE id IN (${chargeIds.map(() => '?').join()})`).all(...chargeIds);
  const total = charges.reduce((s, c) => s + c.amount, 0);
  let created = 0, regenerated = 0, skipped = 0;
  db.transaction(() => {
    for (const no of flatNos) {
      const flat = db.prepare('SELECT flat_no FROM flats WHERE flat_no = ?').get(no);
      if (!flat) continue;
      const old = db.prepare('SELECT id, paid FROM bills WHERE flat_no = ? AND month = ?').get(no, month);
      const hasPay = old && db.prepare('SELECT 1 FROM payments WHERE bill_id = ?').get(old.id);
      if (old && (old.paid || hasPay)) { skipped++; continue; }   // paid / part-paid bill: leave as is
      if (old) { db.prepare('DELETE FROM bills WHERE id = ?').run(old.id); regenerated++; }  // items deleted by cascade
      else created++;
      const r = db.prepare('INSERT INTO bills (flat_no, month, total) VALUES (?, ?, ?)').run(no, month, total);
      for (const c of charges)
        db.prepare('INSERT INTO bill_items (bill_id, name, amount) VALUES (?, ?, ?)').run(r.lastInsertRowid, c.name, c.amount);
    }
  })();
  res.json({ created, regenerated, skipped });
}));

// Record a payment (full or partial) against a bill
app.post('/api/bills/:id/payments', auth, superOnly, route((req, res) => {
  const bill = getBills('WHERE b.id = ?', [req.params.id])[0];
  if (!bill) throw new Error('Bill not found');
  const amount = Math.round(Number(req.body.amount));
  if (!(amount > 0)) throw new Error('Enter an amount above zero');
  if (amount > bill.balance) throw new Error('Amount is more than the balance (Rs ' + bill.balance + ')');
  const today = new Date().toLocaleDateString('en-GB');
  db.prepare('INSERT INTO payments (bill_id, amount, paid_on) VALUES (?, ?, ?)').run(bill.id, amount, today);
  if (amount === bill.balance) db.prepare('UPDATE bills SET paid = 1, paid_on = ? WHERE id = ?').run(today, bill.id);
  res.json({ ok: true });
}));

// Mark paid = receive the whole remaining balance; mark unpaid = clear all payments
app.put('/api/bills/:id/paid', auth, superOnly, route((req, res) => {
  const bill = getBills('WHERE b.id = ?', [req.params.id])[0];
  if (!bill) throw new Error('Bill not found');
  const today = new Date().toLocaleDateString('en-GB');
  db.transaction(() => {
    if (req.body.paid) {
      if (bill.balance > 0) db.prepare('INSERT INTO payments (bill_id, amount, paid_on) VALUES (?, ?, ?)').run(bill.id, bill.balance, today);
      db.prepare('UPDATE bills SET paid = 1, paid_on = ? WHERE id = ?').run(today, bill.id);
    } else {
      db.prepare('DELETE FROM payments WHERE bill_id = ?').run(bill.id);
      db.prepare('UPDATE bills SET paid = 0, paid_on = NULL WHERE id = ?').run(bill.id);
    }
  })();
  res.json({ ok: true });
}));

app.delete('/api/bills/:id', auth, superOnly, route((req, res) => {
  db.prepare('DELETE FROM bills WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- flats ----------
app.get('/api/flats', auth, adminOnly, route((req, res) => {
  res.json(db.prepare('SELECT flat_no, owner, phone FROM flats ORDER BY flat_no').all());
}));

app.post('/api/flats', auth, superOnly, route((req, res) => {
  const { flat_no, owner, phone, pin } = req.body;
  if (!flat_no || !owner || !pin) throw new Error('Flat number, name and PIN are required');
  db.prepare('INSERT INTO flats VALUES (?, ?, ?, ?)').run(flat_no.trim(), owner.trim(), phone || '', bcrypt.hashSync(String(pin), 10));
  res.json({ ok: true });
}));

// Admin resets a resident's PIN
app.put('/api/flats/:no/pin', auth, superOnly, route((req, res) => {
  if (!req.body.pin) throw new Error('PIN is required');
  db.prepare('UPDATE flats SET pin = ? WHERE flat_no = ?').run(bcrypt.hashSync(String(req.body.pin), 10), req.params.no);
  res.json({ ok: true });
}));

app.delete('/api/flats/:no', auth, superOnly, route((req, res) => {
  db.prepare('DELETE FROM flats WHERE flat_no = ?').run(req.params.no);
  res.json({ ok: true });
}));

// ---------- charges ----------
app.get('/api/charges', auth, adminOnly, route((req, res) => {
  res.json(db.prepare('SELECT * FROM charges').all());
}));

app.post('/api/charges', auth, superOnly, route((req, res) => {
  const amount = Number(req.body.amount);
  if (!req.body.name || !(amount > 0)) throw new Error('Enter a name and an amount above zero');
  db.prepare('INSERT INTO charges (name, amount) VALUES (?, ?)').run(req.body.name.trim(), amount);
  res.json({ ok: true });
}));

app.put('/api/charges/:id', auth, superOnly, route((req, res) => {
  db.prepare('UPDATE charges SET amount = ? WHERE id = ?').run(Math.max(0, Number(req.body.amount) || 0), req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/charges/:id', auth, superOnly, route((req, res) => {
  db.prepare('DELETE FROM charges WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- change own password (admin) or PIN (resident) ----------
app.post('/api/password', auth, route((req, res) => {
  const { oldPass, newPass } = req.body;
  if (!newPass || String(newPass).length < 4) throw new Error('New password must be at least 4 characters');
  const admin = req.user.role === 'admin';
  const row = admin
    ? db.prepare('SELECT password AS h FROM admins WHERE username = ?').get(req.user.id)
    : db.prepare('SELECT pin AS h FROM flats WHERE flat_no = ?').get(req.user.id);
  if (!row || !bcrypt.compareSync(String(oldPass), row.h)) throw new Error('Current password is wrong');
  const h = bcrypt.hashSync(String(newPass), 10);
  if (admin) db.prepare('UPDATE admins SET password = ? WHERE username = ?').run(h, req.user.id);
  else db.prepare('UPDATE flats SET pin = ? WHERE flat_no = ?').run(h, req.user.id);
  res.json({ ok: true });
}));

app.listen(PORT, () => console.log(`Flat Union app running at http://localhost:${PORT}`));