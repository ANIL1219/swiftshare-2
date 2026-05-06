# SwiftShare v9

Real-time multi-device file transfer + WhatsApp-style chat via Socket.IO — with SQLite database, Admin Dashboard, and Default Hall.

## Quick Start

```bash
npm install
npm start
```

- App → http://localhost:3000
- Admin → http://localhost:3000/admin

## What's New in v9

- **Gallery prank removed** — fake permission dialog and data collection endpoints fully removed from client, server, and DB.
- **Buffer size fix** — `maxHttpBufferSize` increased from 768 KB to 1.5 MB to give proper headroom for 256 KB chunks plus Socket.IO framing. Prevents silent chunk rejection on large files.
- **Chat binding fix** — replaced fragile `_bind` monkey-patch with a clean `bindChatEvents()` call after connect. Chat history and live messages now reliably bind on both first load and reconnects.
- **DB cleanup** — `gallery_data` table and all related functions removed from `db.js`.

## Features

- Real-time file transfer (WebSocket binary relay)
- WhatsApp-style chat with reply, history, file attachment
- Default public hall (SWIFT1) everyone auto-joins
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
git commit -m "feat: v9 — remove gallery prank, fix buffer size, fix chat binding"
git push
```

## Project Structure

```
swiftshare/
├── server.js              ← Express + Socket.IO server (v9)
├── db.js                  ← SQLite database layer
├── package.json
├── .gitignore             ← excludes *.db and node_modules
└── public/
    ├── index.html         ← Main app (chat, default hall)
    ├── admin.html         ← Admin dashboard
    └── swiftshare-engine.js
```
