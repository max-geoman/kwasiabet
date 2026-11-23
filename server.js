require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

// SQLite adapter: uses better-sqlite3 if compiled, otherwise native node:sqlite
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  const { DatabaseSync } = require('node:sqlite');
  let txDepth = 0;
  Database = class {
    constructor(file) { this.db = new DatabaseSync(file); }
    exec(sql) { return this.db.exec(sql); }
    pragma(sql) { return this.db.exec('PRAGMA ' + sql); }
    prepare(sql) {
      const stmt = this.db.prepare(sql);
      return {
        run: (...args) => stmt.run(...args),
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args)
      };
    }
    transaction(fn) {
      return (...args) => {
        const isOuter = txDepth === 0;
        txDepth++;
        if (isOuter) this.db.exec('BEGIN');
        try {
          const res = fn(...args);
          if (isOuter) this.db.exec('COMMIT');
          return res;
        } catch (err) {
          if (isOuter) this.db.exec('ROLLBACK');
          throw err;
        } finally {
          txDepth--;
        }
      };
    }
  };
}

const PORT = process.env.PORT || 3001;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'kwasia-bet-pro-jwt-secret-key-2026';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_placeholder';
const DEV_PIN = process.env.DEV_PIN || '1234';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '74445bba3a1a085d05ce01d02d11e59c';

if (!process.env.JWT_SECRET || !process.env.PAYSTACK_SECRET_KEY) {
  console.warn('[WARN] JWT_SECRET or PAYSTACK_SECRET_KEY not set in .env. Using fallback keys.');
}

const MAX_STAKE = +process.env.MAX_STAKE || 500;
const SIGNUP_BONUS = +process.env.SIGNUP_BONUS || 25; // default GH₵ 25 welcome bonus
const MIN_W = +process.env.MIN_WITHDRAW || 10;
const MAX_W = +process.env.MAX_WITHDRAW || 1000;
const DAILY_W = +process.env.DAILY_WITHDRAW || 2000;
const W_FEE = +process.env.WITHDRAW_FEE || 0; // taken from payout, in GHS
const MARGIN = 0.95, SLOT_PAYOUT = 12, DEV_START = 10000;
const DEV_EMAIL = 'dev@kwasiabet.test';
const NETS = ['MTN', 'VOD', 'ATL'];

let LEAGUES;
try {
  LEAGUES = require('./leagues.json');
} catch (e) {
  console.error('Warning: leagues.json failed to load:', e.message);
  LEAGUES = {};
}

const r2 = n => Math.round(n * 100) / 100;
const rnd = n => crypto.randomInt(n);
const rand = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const fail = (res, code, error, extra = {}) => res.status(code).json({ success: false, error, ...extra });
const normPhone = p => {
  let s = String(p || '').replace(/[\s-]/g, '');
  if (s.startsWith('+233')) s = '0' + s.slice(4); else if (s.startsWith('233')) s = '0' + s.slice(3);
  return /^0\d{9}$/.test(s) ? s : null;
};
const ps = (p, method = 'GET', body) => fetch('https://api.paystack.co' + p, {
  method, headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined }).then(r => r.json());

// ---------- database ----------
const db = new Database('database.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, phone TEXT,
    password TEXT NOT NULL, balance REAL DEFAULT 0, initial_balance REAL DEFAULT 0, is_dev INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
    amount REAL NOT NULL, reference TEXT, status TEXT DEFAULT 'SUCCESS', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_ref ON transactions(reference) WHERE reference IS NOT NULL;
  CREATE TABLE IF NOT EXISTS bets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, league TEXT, home TEXT,
    away TEXT, choice TEXT, odds REAL, stake REAL, payout REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL,
    fee REAL DEFAULT 0, phone TEXT, network TEXT, reference TEXT UNIQUE, status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  DROP TABLE IF EXISTS passes;
`);
try { db.exec('ALTER TABLE users ADD COLUMN is_dev INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN full_name TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN username TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN currency TEXT DEFAULT "GHS"'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN theme TEXT DEFAULT "dark"'); } catch {}

const setting = k => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const devOn = () => !!DEV_PIN && setting('dev_mode') === '1';
const balanceOf = id => db.prepare('SELECT balance FROM users WHERE id=?').get(id).balance;
const userPayload = id => db.prepare('SELECT id,email,phone,balance,initial_balance,is_dev,full_name,username,currency,theme,created_at FROM users WHERE id=?').get(id);
const debitCredit = (uid, stake, payout) => db.transaction(() => {
  const u = db.prepare('UPDATE users SET balance=ROUND(balance-?,2) WHERE id=? AND balance>=?').run(stake, uid, stake);
  if (!u.changes) return false;
  if (payout > 0) db.prepare('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?').run(payout, uid);
  return true;
})();

// ---------- money movement helpers ----------
function applyDeposit(ref, d) {
  const tx = db.prepare("SELECT * FROM transactions WHERE reference=? AND type='DEPOSIT'").get(ref);
  if (!tx) return { error: 'Unknown reference.' };
  if (tx.status === 'SUCCESS') return { already: true };
  if (d.status !== 'success' || d.currency !== 'GHS' || d.amount !== Math.round(tx.amount * 100)) return { error: 'Payment not confirmed.' };
  db.transaction(() => {
    const u = db.prepare("UPDATE transactions SET status='SUCCESS' WHERE id=? AND status='PENDING'").run(tx.id);
    if (u.changes) db.prepare('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?').run(tx.amount, tx.user_id);
  })();
  return { ok: true, amount: tx.amount };
}

function settleWithdrawal(ref, outcome) { // outcome: success | failed | reversed
  db.transaction(() => {
    const w = db.prepare('SELECT * FROM withdrawals WHERE reference=?').get(ref);
    if (!w) return;
    if (outcome === 'success') { db.prepare("UPDATE withdrawals SET status='SUCCESS' WHERE id=? AND status='PENDING'").run(w.id); return; }
    const from = outcome === 'reversed' ? "('PENDING','SUCCESS')" : "('PENDING')";
    const u = db.prepare(`UPDATE withdrawals SET status=? WHERE id=? AND status IN ${from}`).run(outcome === 'reversed' ? 'REVERSED' : 'FAILED', w.id);
    if (u.changes) db.prepare('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?').run(w.amount, w.user_id); // refund the hold
  })();
}

async function reconcile(uid) { // asks Paystack about transfers stuck in PENDING
  const rows = db.prepare("SELECT reference, created_at < datetime('now','-10 minutes') AS old FROM withdrawals WHERE user_id=? AND status='PENDING' AND created_at < datetime('now','-3 minutes')").all(uid);
  for (const w of rows) {
    try {
      const j = await ps('/transfer/verify/' + encodeURIComponent(w.reference));
      if (j.status && j.data) { const s = j.data.status; if (['success', 'failed', 'reversed'].includes(s)) settleWithdrawal(w.reference, s); }
      else if (w.old && /not found/i.test(j.message || '')) settleWithdrawal(w.reference, 'failed');
    } catch {}
  }
}

// ---------- app + webhook ----------
const app = express();
app.use(cors());

// Webhook must be parsed as raw buffer before express.json()
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  const got = req.headers['x-paystack-signature'] || '';
  if (got.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(sig))) return res.sendStatus(401);
  const ev = JSON.parse(req.body), ref = ev.data && ev.data.reference;
  if (ev.event === 'charge.success') applyDeposit(ref, ev.data);
  else if (ev.event === 'transfer.success') settleWithdrawal(ref, 'success');
  else if (ev.event === 'transfer.failed') settleWithdrawal(ref, 'failed');
  else if (ev.event === 'transfer.reversed') settleWithdrawal(ref, 'reversed');
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static(__dirname)); // allow serving static assets if needed
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'IndexK.html')));

// ---------- auth ----------
const sign = u => jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: '7d' });
function readToken(req, opts) {
  const t = (req.headers.authorization || '').split(' ')[1];
  try { return t ? jwt.verify(t, JWT_SECRET, opts) : null; } catch { return null; }
}
const auth = (req, res, next) => {
  const t = readToken(req);
  if (!t || !t.id) return fail(res, 401, 'Please log in.');
  const row = db.prepare('SELECT is_dev FROM users WHERE id=?').get(t.id);
  if (!row) return fail(res, 401, 'Please log in.');
  if (row.is_dev && !devOn()) return fail(res, 403, 'Developer mode is off.', { code: 'DEV_OFF' });
  req.user = { id: t.id, email: t.email, is_dev: !!row.is_dev };
  next();
};
const optionalAuth = (req, res, next) => { const t = readToken(req); req.user = t && t.id ? { id: t.id } : null; next(); };

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), { phone, password } = req.body;
  if (!email.includes('@') || email.endsWith('@kwasiabet.test')) return fail(res, 400, 'A valid email is required.');
  if (!password || password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  try {
    const r = db.prepare('INSERT INTO users (email,phone,password,balance,initial_balance) VALUES (?,?,?,?,?)')
      .run(email, phone || null, await bcrypt.hash(password, 10), SIGNUP_BONUS, SIGNUP_BONUS);
    const userId = Number(r.lastInsertRowid);
    res.json({ success: true, token: sign({ id: userId, email }), user: userPayload(userId) });
  } catch (e) {
    fail(res, String(e.message).includes('UNIQUE') ? 400 : 500, String(e.message).includes('UNIQUE') ? 'An account with this email already exists.' : 'Registration failed.');
  }
});
app.post('/api/auth/login', async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || u.is_dev || !(await bcrypt.compare(String(req.body.password || ''), u.password))) return fail(res, 400, 'Invalid email or password.');
  res.json({ success: true, token: sign(u), user: userPayload(u.id) });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, user: userPayload(req.user.id) }));

// ---------- profile settings (persisted to database) ----------
app.post('/api/user/profile', auth, async (req, res) => {
  const uid = req.user.id;
  const fullName = req.body.full_name !== undefined ? String(req.body.full_name).trim() : null;
  const username = req.body.username !== undefined ? String(req.body.username).trim() : null;
  const phone = req.body.phone !== undefined ? normPhone(req.body.phone) : undefined;
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  const currency = req.body.currency ? String(req.body.currency).toUpperCase() : 'GHS';

  if (phone === null && req.body.phone) {
    return fail(res, 400, 'Invalid phone number format. Use Ghana standard (e.g. 024XXXXXXX).');
  }

  // Optional password change
  if (req.body.new_password) {
    if (req.body.new_password.length < 6) return fail(res, 400, 'New password must be at least 6 characters.');
    if (!req.body.current_password) return fail(res, 400, 'Current password is required to change password.');
    const u = db.prepare('SELECT password FROM users WHERE id=?').get(uid);
    if (!u || !(await bcrypt.compare(String(req.body.current_password), u.password))) {
      return fail(res, 400, 'Current password is incorrect.');
    }
    const hash = await bcrypt.hash(req.body.new_password, 10);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, uid);
  }

  const current = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const updatedName = fullName !== null ? fullName : current.full_name;
  const updatedUser = username !== null ? username : current.username;
  const updatedPhone = phone !== undefined ? phone : current.phone;

  db.prepare('UPDATE users SET full_name=?, username=?, phone=?, theme=?, currency=? WHERE id=?')
    .run(updatedName, updatedUser, updatedPhone, theme, currency, uid);

  res.json({ success: true, message: 'Profile updated successfully.', user: userPayload(uid) });
});

// ---------- developer mode (PIN-protected; off = dev account locked out instantly) ----------
const pinMisses = new Map();
const devAuth = (req, res, next) => {
  const t = readToken(req, { audience: 'dev' });
  if (!DEV_PIN || !t || t.dev !== true) return fail(res, 401, 'Dev session required.', { code: 'DEV_AUTH' });
  next();
};
const needDevOn = (req, res, next) => devOn() ? next() : fail(res, 403, 'Developer mode is off.');
const devUser = () => db.prepare('SELECT id FROM users WHERE email=?').get(DEV_EMAIL);

app.get('/api/dev/status', (req, res) => res.json({ success: true, enabled: devOn() }));
app.post('/api/dev/unlock', (req, res) => {
  if (!DEV_PIN) return fail(res, 404, 'Not available.');
  const m = pinMisses.get(req.ip);
  if (m && m.n >= 5 && Date.now() - m.t < 15 * 60e3) return fail(res, 429, 'Too many attempts. Try later.');
  const h = s => crypto.createHash('sha256').update(String(s || '')).digest();
  if (!crypto.timingSafeEqual(h(req.body.pin), h(DEV_PIN))) {
    pinMisses.set(req.ip, { n: (m && Date.now() - m.t < 15 * 60e3 ? m.n : 0) + 1, t: Date.now() });
    return fail(res, 401, 'Wrong PIN.');
  }
  pinMisses.delete(req.ip);
  res.json({ success: true, devToken: jwt.sign({ dev: true }, JWT_SECRET, { expiresIn: '12h', audience: 'dev' }), enabled: devOn() });
});
app.post('/api/dev/toggle', devAuth, (req, res) => { setSetting('dev_mode', req.body.on ? '1' : '0'); res.json({ success: true, enabled: devOn() }); });
app.post('/api/dev/login', devAuth, needDevOn, (req, res) => {
  let u = devUser();
  if (!u) {
    const r = db.prepare('INSERT INTO users (email,password,balance,initial_balance,is_dev) VALUES (?,?,?,?,1)')
      .run(DEV_EMAIL, bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 8), DEV_START, DEV_START);
    u = { id: Number(r.lastInsertRowid) };
  }
  res.json({ success: true, token: sign({ id: u.id, email: DEV_EMAIL }), user: userPayload(u.id) });
});
app.post('/api/dev/topup', devAuth, needDevOn, (req, res) => {
  const u = devUser(); if (!u) return fail(res, 400, 'Log in as the dev account first.');
  db.prepare('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?').run(Math.min(100000, Math.max(0, r2(+req.body.amount || 1000))), u.id);
  res.json({ success: true, balance: balanceOf(u.id) });
});
app.post('/api/dev/reset', devAuth, needDevOn, (req, res) => { // resets ONLY dev account
  const u = devUser();
  if (u) db.transaction(() => {
    ['bets', 'transactions', 'withdrawals'].forEach(t => db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u.id));
    db.prepare('UPDATE users SET balance=?, initial_balance=? WHERE id=?').run(DEV_START, DEV_START, u.id);
  })();
  for (const [k, v] of fixtures) if (u && v.uid === u.id) fixtures.delete(k);
  if (u) rounds.delete(u.id);
  res.json({ success: true, balance: DEV_START });
});
app.post('/api/dev/reset-all', devAuth, needDevOn, (req, res) => { // wipes every user
  if (PAYSTACK_SECRET_KEY.startsWith('sk_live')) return fail(res, 403, 'Full reset is blocked while a live Paystack key is set.');
  if (req.body.confirm !== 'RESET') return fail(res, 400, 'Type RESET to confirm.');
  db.transaction(() => ['bets', 'withdrawals', 'transactions', 'users'].forEach(t => db.exec(`DELETE FROM ${t}`)))();
  fixtures.clear(); rounds.clear();
  res.json({ success: true });
});

// ---------- sportsbook (server sets odds AND decides results) ----------
const fixtures = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of fixtures) if (v.exp < n) fixtures.delete(k); }, 60e3).unref();

function buildFixtures(key, uid) {
  if (!LEAGUES[key]) return [];
  const ratings = LEAGUES[key].teams, names = Object.keys(ratings), out = [];
  for (let i = names.length - 1; i > 0; i--) { const j = rnd(i + 1); [names[i], names[j]] = [names[j], names[i]]; }
  for (let i = 0; i < 8 && i + 1 < names.length; i += 2) {
    const home = names[i], away = names[i + 1], diff = ratings[home] + 4 - ratings[away];
    let ph = Math.max(.1, Math.min(.85, .45 + diff * .012)), pa = Math.max(.1, Math.min(.85, .8 - ph)), pd = Math.max(.1, 1 - ph - pa);
    const t = ph + pa + pd; ph /= t; pa /= t; pd /= t;
    const odds = { home: r2(MARGIN / ph), draw: r2(MARGIN / pd), away: r2(MARGIN / pa) }, id = crypto.randomUUID();
    fixtures.set(id, { uid, league: key, home, away, odds, p: { home: ph, draw: pd, away: pa }, exp: Date.now() + 15 * 60e3 });
    out.push({ id, home, away, odds });
  }
  return out;
}

// Map league keys to The Odds API sport keys
const SPORT_KEYS = {
  epl: 'soccer_epl',
  laliga: 'soccer_spain_la_liga',
  saudi: 'soccer_saudi_arabia_pro_league',
  ucl: 'soccer_uefa_champs_league'
};

const cachedOdds = {};
const cacheExpiry = {};

async function fetchRealOdds(key, uid) {
  const sportKey = SPORT_KEYS[key];
  if (!sportKey || !ODDS_API_KEY) return null;

  const now = Date.now();
  if (cachedOdds[key] && cacheExpiry[key] && now < cacheExpiry[key]) {
    // Re-register cached fixtures into active memory for bets
    cachedOdds[key].forEach(f => {
      fixtures.set(f.id, {
        uid,
        league: key,
        home: f.home,
        away: f.away,
        odds: f.odds,
        p: f.p,
        commence_time: f.commence_time,
        exp: Date.now() + 15 * 60e3
      });
    });
    return cachedOdds[key];
  }

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!Array.isArray(data) || data.length === 0) return null;

    const list = data.slice(0, 8).map(match => {
      const bookmaker = match.bookmakers && match.bookmakers[0];
      const market = bookmaker && bookmaker.markets && bookmaker.markets.find(m => m.key === 'h2h');
      const outcomes = (market && market.outcomes) || [];

      const hOdds = outcomes.find(o => o.name === match.home_team)?.price || 2.10;
      const aOdds = outcomes.find(o => o.name === match.away_team)?.price || 3.20;
      const dOdds = outcomes.find(o => o.name === 'Draw')?.price || 3.10;

      const odds = { home: r2(hOdds), draw: r2(dOdds), away: r2(aOdds) };
      // Probability estimation for server resolution
      const invH = 1 / odds.home, invD = 1 / odds.draw, invA = 1 / odds.away;
      const totalInv = invH + invD + invA;
      const p = { home: invH / totalInv, draw: invD / totalInv, away: invA / totalInv };

      const id = match.id || crypto.randomUUID();
      fixtures.set(id, {
        uid,
        league: key,
        home: match.home_team,
        away: match.away_team,
        odds,
        p,
        commence_time: match.commence_time,
        exp: Date.now() + 15 * 60e3
      });

      return {
        id,
        home: match.home_team,
        away: match.away_team,
        odds,
        p,
        commence_time: match.commence_time
      };
    });

    cachedOdds[key] = list;
    cacheExpiry[key] = now + 10 * 60 * 1000; // cache for 10 minutes to preserve API quota
    return list;
  } catch (err) {
    console.warn(`[WARN] Failed to fetch real odds for ${key}:`, err.message);
    return null;
  }
}

app.get('/api/leagues', (req, res) => res.json({ success: true, leagues: LEAGUES }));

app.get('/api/fixtures/:league', optionalAuth, async (req, res) => {
  const leagueKey = req.params.league;
  if (!LEAGUES[leagueKey]) return fail(res, 404, 'Unknown league.');
  const uid = req.user ? req.user.id : 0;

  // Attempt to fetch real live odds from The Odds API
  const realFixtures = await fetchRealOdds(leagueKey, uid);
  if (realFixtures && realFixtures.length > 0) {
    return res.json({ success: true, live: true, fixtures: realFixtures });
  }

  // Graceful fallback to simulation engine (e.g. for GPL or when API quota is exhausted)
  res.json({ success: true, live: false, fixtures: buildFixtures(leagueKey, uid) });
});
const checkStake = v => { const s = r2(+v); return s >= 1 && s <= MAX_STAKE ? s : 0; };

app.post('/api/bets/place', auth, (req, res) => {
  const { fixtureId, choice } = req.body, uid = req.user.id, stake = checkStake(req.body.stake);
  if (!stake) return fail(res, 400, `Stake must be between 1 and ${MAX_STAKE}.`);
  if (!['home', 'draw', 'away'].includes(choice)) return fail(res, 400, 'Invalid selection.');
  const f = fixtures.get(fixtureId);
  // Allow unauthenticated-generated fixtures to be claimed upon bet
  if (!f || (f.uid !== 0 && f.uid !== uid)) return fail(res, 400, 'Odds expired. Refresh the fixtures.');
  fixtures.delete(fixtureId);
  const x = rand(), outcome = x < f.p.home ? 'home' : x < f.p.home + f.p.draw ? 'draw' : 'away';
  const won = outcome === choice, payout = won ? r2(stake * f.odds[choice]) : 0;
  if (!debitCredit(uid, stake, payout)) return fail(res, 400, 'Insufficient funds.');
  db.prepare('INSERT INTO bets (user_id,league,home,away,choice,odds,stake,payout) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid, f.league, f.home, f.away, choice, f.odds[choice], stake, payout);
  let score;
  if (outcome === 'draw') { const g = rnd(4); score = { h: g, a: g }; }
  else { const w = 1 + rnd(3), l = rnd(w); score = outcome === 'home' ? { h: w, a: l } : { h: l, a: w }; }
  res.json({ success: true, won, payout, score, balance: balanceOf(uid) });
});

// ---------- casino ----------
const SYMBOLS = ['🍒', '🔔', '💎', '⚽'];
app.post('/api/casino/slots', auth, (req, res) => {
  const uid = req.user.id, stake = checkStake(req.body.stake);
  if (!stake) return fail(res, 400, `Stake must be between 1 and ${MAX_STAKE}.`);
  const reels = [SYMBOLS[rnd(4)], SYMBOLS[rnd(4)], SYMBOLS[rnd(4)]];
  const won = reels[0] === reels[1] && reels[1] === reels[2], payout = won ? r2(stake * SLOT_PAYOUT) : 0;
  if (!debitCredit(uid, stake, payout)) return fail(res, 400, 'Insufficient funds.');
  try {
    db.prepare('INSERT INTO bets (user_id,league,home,away,choice,odds,stake,payout) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid, 'Casino', 'Slots', reels.join(' '), won ? 'WIN' : 'LOSS', SLOT_PAYOUT, stake, payout);
  } catch {}
  res.json({ success: true, reels, won, payout, balance: balanceOf(uid) });
});

const rounds = new Map();
const multAt = r => Math.floor((1 + (Date.now() - r.t) / 3000) * 100) / 100;
app.post('/api/casino/crash/start', auth, (req, res) => {
  const uid = req.user.id, stake = checkStake(req.body.stake);
  if (!stake) return fail(res, 400, `Stake must be between 1 and ${MAX_STAKE}.`);
  if (rounds.has(uid)) return fail(res, 400, 'A round is already running.');
  if (!debitCredit(uid, stake, 0)) return fail(res, 400, 'Insufficient funds.');
  rounds.set(uid, { stake, crashAt: Math.min(100, Math.max(1, Math.floor(MARGIN / (1 - rand()) * 100) / 100)), t: Date.now() });
  res.json({ success: true, balance: balanceOf(uid) });
});
app.get('/api/casino/crash/status', auth, (req, res) => {
  const r = rounds.get(req.user.id);
  if (!r) return res.json({ success: true, active: false });
  const m = multAt(r);
  if (m >= r.crashAt) {
    rounds.delete(req.user.id);
    try {
      db.prepare('INSERT INTO bets (user_id,league,home,away,choice,odds,stake,payout) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.user.id, 'Casino', 'Accra Crash', `Crashed @ ${r.crashAt}x`, 'CRASH', 0, r.stake, 0);
    } catch {}
    return res.json({ success: true, crashed: true, mult: r.crashAt });
  }
  res.json({ success: true, active: true, mult: m });
});
app.post('/api/casino/crash/cashout', auth, (req, res) => {
  const uid = req.user.id, r = rounds.get(uid);
  if (!r) return fail(res, 400, 'No active round.');
  const m = multAt(r); rounds.delete(uid);
  if (m >= r.crashAt) {
    try {
      db.prepare('INSERT INTO bets (user_id,league,home,away,choice,odds,stake,payout) VALUES (?,?,?,?,?,?,?,?)')
        .run(uid, 'Casino', 'Accra Crash', `Crashed @ ${r.crashAt}x`, 'CRASH', 0, r.stake, 0);
    } catch {}
    return res.json({ success: true, crashed: true, mult: r.crashAt, balance: balanceOf(uid) });
  }
  const payout = r2(r.stake * m);
  db.prepare('UPDATE users SET balance=ROUND(balance+?,2) WHERE id=?').run(payout, uid);
  try {
    db.prepare('INSERT INTO bets (user_id,league,home,away,choice,odds,stake,payout) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid, 'Casino', 'Accra Crash', `Cashed out @ ${m}x`, 'WIN', m, r.stake, payout);
  } catch {}
  res.json({ success: true, won: true, mult: m, payout, balance: balanceOf(uid) });
});

// ---------- deposits (cash in) ----------
// Primary endpoint + alias for backward compatibility
const initPaymentHandler = async (req, res) => {
  if (req.user.is_dev) return fail(res, 403, 'The developer account uses test credits only.');
  const amount = r2(+req.body.amount);
  if (!(amount >= 1 && amount <= 5000)) return fail(res, 400, 'Deposit must be between GH₵ 1 and GH₵ 5,000.');
  const phone = req.body.phone ? normPhone(req.body.phone) : null, net = String(req.body.network || '').toUpperCase();
  if (req.body.phone && (!phone || !NETS.includes(net))) return fail(res, 400, 'Enter a valid Ghana number (e.g. 024XXXXXXX) and pick the network.');
  const reference = `kb-${req.user.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  db.prepare("INSERT INTO transactions (user_id,type,amount,reference,status) VALUES (?,?,?,?,'PENDING')").run(req.user.id, 'DEPOSIT', amount, reference);
  try {
    if (phone && NETS.includes(net)) { // direct mobile money prompt
      const j = await ps('/charge', 'POST', { email: req.user.email, amount: Math.round(amount * 100), currency: 'GHS', reference,
        mobile_money: { phone, provider: net.toLowerCase() } });
      if (!j.status) return fail(res, 400, j.message || 'Could not start mobile money payment.');
      return res.json({ success: true, mode: 'momo', reference, status: j.data.status, message: j.data.display_text || 'Approve the payment prompt on your phone.' });
    }
    // Determine callback URL dynamically:
    // 1. Client-provided callback_url (matches current browser domain on Railway/Render/localhost)
    // 2. Request Origin / Referer / Host headers
    // 3. Fallback to configured APP_URL
    const reqOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null) || (req.headers.host ? `${req.protocol || 'https'}://${req.headers.host}` : null);
    const callbackUrl = req.body.callback_url || (reqOrigin ? `${reqOrigin}/` : `${APP_URL}/`);

    const j = await ps('/transaction/initialize', 'POST', { email: req.user.email, amount: Math.round(amount * 100), currency: 'GHS', reference,
      callback_url: callbackUrl, channels: ['mobile_money', 'card'] });
    if (!j.status) return fail(res, 400, j.message || 'Payment init failed.');
    res.json({ success: true, mode: 'checkout', reference, authorization_url: j.data.authorization_url });
  } catch { fail(res, 502, 'Payment gateway error.'); }
};

app.post('/api/payments/initialize', auth, initPaymentHandler);
app.post('/api/initialize-payment', auth, initPaymentHandler); // legacy alias

app.post('/api/payments/otp', auth, async (req, res) => {
  const ref = String(req.body.reference || '');
  const tx = db.prepare("SELECT user_id FROM transactions WHERE reference=? AND type='DEPOSIT'").get(ref);
  if (!tx || tx.user_id !== req.user.id) return fail(res, 404, 'Unknown reference.');
  try {
    const j = await ps('/charge/submit_otp', 'POST', { otp: String(req.body.otp || ''), reference: ref });
    if (!j.status) return fail(res, 400, j.message || 'OTP rejected.');
    res.json({ success: true, status: j.data.status, message: j.data.display_text || 'OTP accepted. Confirming payment...' });
  } catch { fail(res, 502, 'Payment gateway error.'); }
});
app.post('/api/payments/verify', auth, async (req, res) => {
  const ref = String(req.body.reference || '');
  const tx = db.prepare("SELECT user_id FROM transactions WHERE reference=? AND type='DEPOSIT'").get(ref);
  if (!tx || tx.user_id !== req.user.id) return fail(res, 404, 'Unknown reference.');
  try {
    const j = await ps('/transaction/verify/' + encodeURIComponent(ref));
    if (!j.status) return fail(res, 400, 'Could not verify payment.');
    const out = applyDeposit(ref, j.data);
    if (out.error) return fail(res, 400, out.error);
    res.json({ success: true, balance: balanceOf(req.user.id), message: out.already ? 'Payment already credited.' : `Deposit of GH₵ ${out.amount.toFixed(2)} credited.` });
  } catch { fail(res, 502, 'Payment gateway error.'); }
});

// Safe stub for legacy balance endpoint (prevent client balance forging)
app.post('/api/user/update-balance', auth, (req, res) => {
  res.json({ success: true, balance: balanceOf(req.user.id), note: 'Balance is managed authoritatively by the server.' });
});

// ---------- cash out (Paystack transfer to mobile money) ----------
app.post('/api/withdraw', auth, async (req, res) => {
  const uid = req.user.id;
  if (req.user.is_dev) return fail(res, 403, 'The developer account uses test credits only.');
  const amount = r2(+req.body.amount), phone = normPhone(req.body.phone), net = String(req.body.network || '').toUpperCase();
  if (!(amount >= MIN_W && amount <= MAX_W)) return fail(res, 400, `Cash out between GH₵ ${MIN_W} and GH₵ ${MAX_W}.`);
  if (amount <= W_FEE) return fail(res, 400, 'Amount is below the fee.');
  if (!phone || !NETS.includes(net)) return fail(res, 400, 'Enter a valid Ghana number (e.g. 024XXXXXXX) and pick the network.');
  if (!db.prepare("SELECT 1 FROM transactions WHERE user_id=? AND type='DEPOSIT' AND status='SUCCESS' LIMIT 1").get(uid))
    return fail(res, 403, 'Make a deposit before cashing out.');
  const today = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE user_id=? AND status IN ('PENDING','SUCCESS') AND created_at > datetime('now','-1 day')").get(uid).s;
  if (today + amount > DAILY_W) return fail(res, 400, `Daily cash-out limit is GH₵ ${DAILY_W}.`);

  const reference = `kbw-${uid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const held = db.transaction(() => { // hold money first
    if (!db.prepare('UPDATE users SET balance=ROUND(balance-?,2) WHERE id=? AND balance>=?').run(amount, uid, amount).changes) return false;
    db.prepare('INSERT INTO withdrawals (user_id,amount,fee,phone,network,reference) VALUES (?,?,?,?,?,?)').run(uid, amount, W_FEE, phone, net, reference);
    return true;
  })();
  if (!held) return fail(res, 400, 'Insufficient funds.');
  try {
    const rc = await ps('/transferrecipient', 'POST', { type: 'mobile_money', name: req.user.email.split('@')[0], account_number: phone, bank_code: net, currency: 'GHS' });
    if (!rc.status) { settleWithdrawal(reference, 'failed'); return fail(res, 400, rc.message || 'Could not set up that number.'); }
    const t = await ps('/transfer', 'POST', { source: 'balance', amount: Math.round((amount - W_FEE) * 100), recipient: rc.data.recipient_code,
      reason: 'KwasiaBet cash out', reference, currency: 'GHS' });
    if (!t.status || t.data.status === 'otp') {
      settleWithdrawal(reference, 'failed');
      return fail(res, 400, t.status ? 'Payouts are temporarily unavailable.' : (t.message || 'Payout failed.'));
    }
    res.json({ success: true, balance: balanceOf(uid), message: `GH₵ ${(amount - W_FEE).toFixed(2)} is on its way to ${phone}.` });
  } catch {
    res.json({ success: true, balance: balanceOf(uid), message: 'Cash out submitted. It will confirm shortly.' });
  }
});

app.get('/api/history', auth, (req, res) => {
  const uid = req.user.id; reconcile(uid);
  const withdrawals = db.prepare('SELECT id,amount,fee,phone,network,reference,status,created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC').all(uid);
  const deposits = db.prepare("SELECT id,amount,reference,status,created_at FROM transactions WHERE user_id=? AND type='DEPOSIT' ORDER BY id DESC").all(uid);
  const bets = db.prepare('SELECT id,league,home,away,choice,odds,stake,payout,created_at FROM bets WHERE user_id=? ORDER BY id DESC').all(uid);

  // Financial summary calculations
  const totalDeposits = db.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM transactions WHERE user_id=? AND type='DEPOSIT' AND status='SUCCESS'").get(uid).s;
  const totalWithdrawals = db.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM withdrawals WHERE user_id=? AND status='SUCCESS'").get(uid).s;
  const totalStaked = db.prepare('SELECT COALESCE(SUM(stake), 0) as s FROM bets WHERE user_id=?').get(uid).s;
  const totalWon = db.prepare('SELECT COALESCE(SUM(payout), 0) as s FROM bets WHERE user_id=?').get(uid).s;
  const netProfit = r2(totalWon - totalStaked);

  res.json({
    success: true,
    summary: {
      totalDeposits,
      totalWithdrawals,
      totalStaked,
      totalWon,
      netProfit,
      currentBalance: balanceOf(uid)
    },
    withdrawals,
    deposits,
    bets
  });
});

app.listen(PORT, '0.0.0.0', () => console.log(`KwasiaBet Server running on ${APP_URL} (port ${PORT})${devOn() ? '  [DEV MODE ON]' : ''}`));
