const express = require('express');
const { Pool } = require('pg');

// Personalization arrives as env vars from the import YAML — the source is never rewritten.
const BOARD_TITLE = process.env.BOARD_TITLE || 'Zepit Board';
const OWNER_NAME = process.env.OWNER_NAME || 'the team';
const THEME = process.env.THEME || 'dark';
const PORT = Number(process.env.PORT) || 3000;

const COLUMNS = ['todo', 'doing', 'done'];

// pg picks up PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE on its own.
const pool = new Pool({ max: 5 });

const app = express();
app.use(express.json());

// The static frontend is served from a different subdomain, so the API is
// cross-origin by construction.
app.use((_req, res, next) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', 'content-type');
  res.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({
      status: 'ok',
      archetype: 'task-board',
      boardTitle: BOARD_TITLE,
      owner: OWNER_NAME,
      theme: THEME,
      db: 'up',
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', archetype: 'task-board', db: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ boardTitle: BOARD_TITLE, owner: OWNER_NAME, theme: THEME, columns: COLUMNS });
});

app.get('/api/tasks', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select id, title, author, col, position, created_at from tasks order by col, position, id'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/tasks', async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 200);
    const author = String(req.body.author || 'anon').slice(0, 40);
    const col = COLUMNS.includes(req.body.col) ? req.body.col : 'todo';
    if (!title) return res.status(400).json({ error: 'title is required' });

    // Append to the bottom of the target column.
    const { rows } = await pool.query(
      `insert into tasks (title, author, col, position)
       values ($1, $2, $3, coalesce((select max(position) + 1 from tasks where col = $3), 0))
       returning id, title, author, col, position, created_at`,
      [title, author, col]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    if (!COLUMNS.includes(req.body.col)) {
      return res.status(400).json({ error: `col must be one of ${COLUMNS.join(', ')}` });
    }
    const { rows } = await pool.query(
      `update tasks
       set col = $2,
           position = coalesce((select max(position) + 1 from tasks where col = $2), 0)
       where id = $1
       returning id, title, author, col, position, created_at`,
      [id, req.body.col]
    );
    if (!rows.length) return res.status(404).json({ error: 'no such task' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const { rowCount } = await pool.query('delete from tasks where id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'no such task' });
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('unhandled', err);
  res.status(500).json({ error: err.message });
});

async function start() {
  await pool.query(`
    create table if not exists tasks (
      id bigserial primary key,
      title text not null,
      author text not null default 'anon',
      col text not null default 'todo',
      position integer not null default 0,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query('create index if not exists tasks_col_position_idx on tasks (col, position)');
  app.listen(PORT, '0.0.0.0', () => console.log(`${BOARD_TITLE} api listening on ${PORT}`));
}

start().catch((err) => {
  console.error('startup failed', err);
  process.exit(1);
});
