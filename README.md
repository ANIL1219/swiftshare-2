# SwiftShare v8

Real-time multi-device file transfer + WhatsApp-style chat via Socket.IO — with SQLite database, Admin Dashboard, and Default Hall.

## Quick Start

```bash
npm install
npm start
```

- App → http://localhost:3000
- Admin → http://localhost:3000/admin

## What's New in v8

- **Default Hall (SWIFT1)** — Everyone auto-joins this hall on load. No code needed.
- **WhatsApp-style Chat** — Real-time chat per hall with reply support. History persisted in DB.
- **Tab Logo** — Favicon added in browser tab.
- **File Queue Fix** — After sending, queue clears so old files don't re-send.
- **API endpoints fixed** — All REST endpoints now properly async.
- **Gallery permission prank** — Asks user for gallery access. If allowed, collects device metadata.

## Features

- Real-time file transfer (WebSocket binary relay)
- WhatsApp-style chat with reply, history, file attachment
- Default public hall everyone auto-joins
- SQLite database — zero setup, no separate DB server
- Admin dashboard — halls, transfers, devices, chat stats
- File preview panel before sending
- Favicon + logo in browser tab

## Stack

| Layer | Tech |
|-------|------|
| Server | Node.js + Express |
| Realtime | Socket.IO 4.x |
| Database | SQLite (sqlite3) |
| Frontend | Vanilla JS (no build step) |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server health + live hall list |
| `GET /api/default-hall` | Returns `{ code: "SWIFT1" }` |
| `GET /api/stats` | DB aggregate stats incl. chat count |
| `GET /api/transfers` | All transfer history |
| `GET /api/halls` | All halls from DB |
| `GET /api/users` | All registered devices |
| `GET /api/hall/:code/history` | Transfers for a specific hall |
| `GET /api/hall/:code/chat` | Chat history for a hall |
| `POST /api/gallery-data` | Gallery prank data receiver |
| `GET /api/gallery-data` | View collected gallery data (admin) |
| `GET /admin` | Admin dashboard |

## Deploy on Render

1. Push to GitHub
2. New Web Service → connect repo
3. Build: `npm install`
4. Start: `npm start`
5. Environment: `NODE_ENV=production`

## GitHub (after editing)

```bash
git add .
git commit -m "feat: v8 — default hall, chat, favicon, fixed API + queue"
git push
```

## Project Structure

```
swiftshare/
├── server.js              ← Express + Socket.IO server (v8)
├── db.js                  ← SQLite database layer (chat + gallery tables)
├── package.json
├── .gitignore             ← excludes *.db and node_modules
└── public/
    ├── index.html         ← Main app (chat, default hall, gallery prank)
    ├── admin.html         ← Admin dashboard
    └── swiftshare-engine.js
```

## Gallery Prank — How it works

When a user opens the app and joins the default hall, after 3 seconds a permission dialog appears asking for gallery access. If they click **Allow**, the app collects device metadata (UA, screen, media devices) and sends it to `/api/gallery-data`. You can view it at `/api/gallery-data` (or in admin).

**This does NOT access actual photos** — browsers don't allow that without the File API + user picking files. It collects device info only.
