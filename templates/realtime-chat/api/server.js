const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

// Personalization arrives as env vars from the import YAML — the source is never rewritten.
const APP_TITLE = process.env.APP_TITLE || 'Zepit Chat';
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || 'general';
const THEME = process.env.THEME || 'dark';
const PORT = Number(process.env.PORT) || 3000;

// pg picks up PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE on its own.
const pool = new Pool({ max: 5 });

const app = express();
app.use(express.json());

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({
      status: 'ok',
      archetype: 'realtime-chat',
      appTitle: APP_TITLE,
      room: DEFAULT_ROOM,
      theme: THEME,
      db: 'up',
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', archetype: 'realtime-chat', db: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ appTitle: APP_TITLE, room: DEFAULT_ROOM, theme: THEME });
});

app.get('/api/messages', async (req, res) => {
  const room = String(req.query.room || DEFAULT_ROOM).slice(0, 30);
  const { rows } = await pool.query(
    'select author, body, created_at from messages where room = $1 order by id desc limit 50',
    [room]
  );
  res.json(rows.reverse());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(room, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.room === room) client.send(data);
  }
}

wss.on('connection', (socket) => {
  socket.room = DEFAULT_ROOM;

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return socket.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
    }

    if (msg.type === 'join') {
      socket.room = String(msg.room || DEFAULT_ROOM).slice(0, 30);
      return socket.send(JSON.stringify({ type: 'joined', room: socket.room }));
    }

    const author = String(msg.author || 'anon').slice(0, 40);
    const body = String(msg.body || '').slice(0, 2000);
    if (!body) return;

    const { rows } = await pool.query(
      'insert into messages (room, author, body) values ($1, $2, $3) returning created_at',
      [socket.room, author, body]
    );
    broadcast(socket.room, { type: 'message', room: socket.room, author, body, created_at: rows[0].created_at });
  });
});

async function start() {
  await pool.query(`
    create table if not exists messages (
      id bigserial primary key,
      room text not null,
      author text not null,
      body text not null,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query('create index if not exists messages_room_id_idx on messages (room, id desc)');
  server.listen(PORT, '0.0.0.0', () => console.log(`${APP_TITLE} api listening on ${PORT}`));
}

start().catch((err) => {
  console.error('startup failed', err);
  process.exit(1);
});
