'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PouchDB = require('pouchdb');
const expressPouchDB = require('express-pouchdb');
const multer = require('multer');
const mm = require('music-metadata');

// Wipe all persisted room data on startup — rooms are ephemeral.
const dataDir = path.join(__dirname, 'data');
if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// PouchDB with LevelDB adapter, persisted in ./data/
const ServerPouchDB = PouchDB.defaults({ prefix: dataDir + path.sep });

// One PouchDB per room, created on first access.
// express-pouchdb serves ALL databases under the prefix, so clients can sync
// to /db/<roomDbName> without any extra configuration.
const roomDbs = new Map(); // roomId → PouchDB instance

function roomDbName(roomId) {
  // Must be stable and the same on client + server.
  // PouchDB names: letters, digits, _, -, $, (, ), +, /
  return 'room_' + roomId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function getRoomDb(roomId) {
  if (!roomDbs.has(roomId)) {
    roomDbs.set(roomId, new ServerPouchDB(roomDbName(roomId)));
  }
  return roomDbs.get(roomId);
}

// Bulk-delete every track document in a room's DB.
// We use soft-delete (not db.destroy) so that express-pouchdb's cached
// instance stays valid and connected clients receive the deletions via their
// live change feed before they disconnect.
async function purgeRoomDb(roomId) {
  const db = roomDbs.get(roomId);
  if (!db) return;
  try {
    const { rows } = await db.allDocs();
    const deletions = rows.map(r => ({ _id: r.id, _rev: r.value.rev, _deleted: true }));
    if (deletions.length) await db.bulkDocs(deletions);
    console.log(`[room ${roomId}] purged ${deletions.length} track(s)`);
  } catch (err) {
    console.error(`[room ${roomId}] purge error:`, err);
  }
  roomDbs.delete(roomId);
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Expose PouchDB HTTP API for client-side sync.
// express-pouchdb serves every DB under the prefix, so /db/room_<name>
// is available automatically as soon as the first document is written.
app.use('/db', expressPouchDB(ServerPouchDB, { mode: 'minimumForPouchDB' }));

// ─── Upload endpoint ────────────────────────────────────────────────────────
// Receives a multipart upload, stores audio as a PouchDB attachment.
// The live PouchDB sync then pushes the new document to all clients.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId is required' });

    // Extract ID3 / Vorbis / AAC tags from the buffer
    let title, artist, album, picture;
    try {
      const meta = await mm.parseBuffer(req.file.buffer, { mimeType: req.file.mimetype });
      title   = meta.common.title;
      artist  = meta.common.artist || (meta.common.artists || []).join(', ');
      album   = meta.common.album;
      picture = meta.common.picture && meta.common.picture[0]; // first embedded image
    } catch (_) { /* metadata unavailable — fall through to filename */ }

    // Fallback to filename (strip extension)
    if (!title) title = req.file.originalname.replace(/\.[^.]+$/, '');
    if (!artist) artist = 'Unknown';

    const id = `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const attachments = {
      audio: {
        content_type: req.file.mimetype,
        data: req.file.buffer.toString('base64'),
      },
    };

    if (picture) {
      attachments.cover = {
        content_type: picture.format,
        data: Buffer.from(picture.data).toString('base64'),
      };
    }

    await getRoomDb(roomId).put({
      _id: id,
      type: 'track',
      title,
      artist,
      album: album || null,
      uploadedAt: new Date().toISOString(),
      hasCover: !!picture,
      _attachments: attachments,
    });

    res.json({ ok: true, id, title, artist });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Room management ─────────────────────────────────────────────────────────
//
// Room state tracks the "source of truth" for synchronized playback.
// When a client emits play/pause/seek/track-change, the server:
//   1. Updates the room state (with a lastUpdate timestamp for drift correction)
//   2. Broadcasts to every OTHER client in the room
//
// New joiners receive the current room state so they can immediately
// catch up to the correct track position.

const rooms = new Map(); // roomId → RoomState

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      currentTrack: null,
      position: 0,
      playing: false,
      lastUpdate: Date.now(),
      listeners: new Map(), // socketId → { id, username }
    });
  }
  return rooms.get(roomId);
}

function currentPosition(room) {
  if (!room.playing) return room.position;
  return room.position + (Date.now() - room.lastUpdate) / 1000;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, username }) => {
    // Leave previous room if any
    if (currentRoom) {
      socket.leave(currentRoom);
      const prev = rooms.get(currentRoom);
      if (prev) {
        prev.listeners.delete(socket.id);
        io.to(currentRoom).emit('listeners', [...prev.listeners.values()]);
        if (prev.listeners.size === 0) {
          rooms.delete(currentRoom);
          purgeRoomDb(currentRoom);
        }
      }
    }

    currentRoom = roomId;
    socket.join(roomId);

    const room = getRoom(roomId);
    room.listeners.set(socket.id, { id: socket.id, username });

    // Send current playback state to the new joiner
    socket.emit('room-state', {
      currentTrack: room.currentTrack,
      position: currentPosition(room),
      playing: room.playing,
      listeners: [...room.listeners.values()],
    });

    // Notify everyone else of the new listener
    io.to(roomId).emit('listeners', [...room.listeners.values()]);
  });

  socket.on('play', ({ trackId, position }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.currentTrack = trackId;
    room.position = position;
    room.playing = true;
    room.lastUpdate = Date.now();
    socket.to(currentRoom).emit('play', { trackId, position, timestamp: room.lastUpdate });
  });

  socket.on('pause', ({ position }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.position = position;
    room.playing = false;
    room.lastUpdate = Date.now();
    socket.to(currentRoom).emit('pause', { position });
  });

  socket.on('seek', ({ trackId, position }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.currentTrack = trackId;
    room.position = position;
    room.lastUpdate = Date.now();
    socket.to(currentRoom).emit('seek', { trackId, position, timestamp: room.lastUpdate });
  });

  socket.on('track-change', ({ trackId }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.currentTrack = trackId;
    room.position = 0;
    room.playing = true;
    room.lastUpdate = Date.now();
    socket.to(currentRoom).emit('track-change', { trackId, timestamp: room.lastUpdate });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.listeners.delete(socket.id);
    io.to(currentRoom).emit('listeners', [...room.listeners.values()]);
    if (room.listeners.size === 0) {
      rooms.delete(currentRoom);
      purgeRoomDb(currentRoom); // fire-and-forget; logs on completion
    }
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`listenTogether running → http://localhost:${PORT}`);
});
