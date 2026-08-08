const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');

// Personalization arrives as env vars from the import YAML — the source is never rewritten.
const SITE_TITLE = process.env.SITE_TITLE || 'Zepit Links';
const OWNER_NAME = process.env.OWNER_NAME || 'the team';
const THEME = process.env.THEME || 'dark';
const PORT = Number(process.env.PORT) || 3000;

// How long a slug->url mapping stays cached. Short enough that a stale entry can
// never outlive a demo, long enough that the second click is obviously a hit.
const CACHE_TTL_SECONDS = 300;

// Slugs are typed by hand and read aloud, so the alphabet drops the characters people
// confuse: 0/O, 1/l/I.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const SLUG_LENGTH = 6;

// Paths the API itself owns. A link on one of these would be unreachable.
const RESERVED = new Set(['api', 'healthz', 'favicon.ico', 'config.js', 'index.html', 'robots.txt']);

// pg picks up PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE on its own.
const pool = new Pool({ max: 5 });

// The cache is deliberately a soft dependency: every read falls back to Postgres and
// every write is best-effort. A shortener that 500s because its cache is warming up
// would be a worse product than one that is briefly slower.
const cache = createClient({
  url: process.env.VALKEY_URL,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
});
let cacheErrorLogged = false;
cache.on('error', (err) => {
  // node-redis emits on every reconnect attempt; one line is enough to diagnose.
  if (!cacheErrorLogged) {
    console.error('valkey error (continuing without cache):', err.message);
    cacheErrorLogged = true;
  }
});
cache.on('ready', () => {
  cacheErrorLogged = false;
  console.log('valkey connected');
});

const cacheUp = () => cache.isReady;

async function cacheGet(key) {
  if (!cacheUp()) return null;
  try {
    return await cache.get(key);
  } catch (err) {
    console.error('cache get failed:', err.message);
    return null;
  }
}

async function cacheSet(key, value, ttl) {
  if (!cacheUp()) return;
  try {
    await cache.set(key, value, { EX: ttl });
  } catch (err) {
    console.error('cache set failed:', err.message);
  }
}

async function cacheDel(keys) {
  if (!cacheUp()) return;
  try {
    await cache.del(keys);
  } catch (err) {
    console.error('cache del failed:', err.message);
  }
}

// Clicks are counted in Valkey so that a cache hit never has to touch Postgres — that
// is the whole point of the cache being here. The durable baseline lives in the
// `hits` column and the two are summed on read.
async function bumpHits(slug) {
  if (cacheUp()) {
    try {
      await cache.incr(`hits:${slug}`);
      return 'cache';
    } catch (err) {
      console.error('cache incr failed:', err.message);
    }
  }
  try {
    await pool.query('update links set hits = hits + 1 where slug = $1', [slug]);
  } catch (err) {
    console.error('hit counter update failed:', err.message);
  }
  return 'db';
}

const app = express();
app.use(express.json());

// The static frontend is served from a different subdomain, so the API is
// cross-origin by construction. The cache headers are exposed so the UI can show
// whether a resolve was served by Valkey or by Postgres.
app.use((_req, res, next) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', 'content-type');
  res.set('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.set('access-control-expose-headers', 'x-zepit-cache,x-zepit-lookup-ms');
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({
      status: 'ok',
      archetype: 'link-shortener',
      siteTitle: SITE_TITLE,
      owner: OWNER_NAME,
      theme: THEME,
      db: 'up',
      cache: cacheUp() ? 'up' : 'down',
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', archetype: 'link-shortener', db: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ siteTitle: SITE_TITLE, owner: OWNER_NAME, theme: THEME, cacheTtl: CACHE_TTL_SECONDS });
});

function randomSlug() {
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// Only http(s) — a shortener that will emit `javascript:` or `data:` URLs is a
// redirect gadget, not a product.
function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'url is required' };
  if (text.length > 2048) return { error: 'url is too long (max 2048)' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: 'url must be absolute, e.g. https://example.com/page' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'only http and https urls can be shortened' };
  }
  return { url: parsed.toString() };
}

app.get('/api/links', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select id, slug, url, created_by, hits, created_at from links order by created_at desc limit 200'
    );
    for (const row of rows) row.hits = Number(row.hits);

    // Fold in the Valkey counters. If the cache is down the durable baseline is still
    // correct, just missing the clicks counted since it went away.
    if (cacheUp() && rows.length) {
      try {
        const counts = await cache.mGet(rows.map((r) => `hits:${r.slug}`));
        rows.forEach((row, i) => { row.hits += Number(counts[i] || 0); });
      } catch (err) {
        console.error('cache mGet failed:', err.message);
      }
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/links', async (req, res, next) => {
  try {
    const { url, error } = normalizeUrl(req.body.url);
    if (error) return res.status(400).json({ error });

    const createdBy = String(req.body.createdBy || 'anon').slice(0, 40);
    const custom = String(req.body.slug || '').trim();

    if (custom) {
      if (!/^[A-Za-z0-9_-]{3,32}$/.test(custom)) {
        return res.status(400).json({ error: 'custom slug must be 3-32 chars: letters, digits, - or _' });
      }
      if (RESERVED.has(custom.toLowerCase())) {
        return res.status(409).json({ error: `"${custom}" is reserved` });
      }
      try {
        const { rows } = await pool.query(
          `insert into links (slug, url, created_by) values ($1, $2, $3)
           returning id, slug, url, created_by, hits, created_at`,
          [custom, url, createdBy]
        );
        return res.status(201).json({ ...rows[0], hits: Number(rows[0].hits) });
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: `"${custom}" is taken` });
        throw err;
      }
    }

    // Random slugs collide vanishingly rarely, but "vanishingly" is not "never" and
    // the unique index is the only thing that actually decides.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await pool.query(
          `insert into links (slug, url, created_by) values ($1, $2, $3)
           returning id, slug, url, created_by, hits, created_at`,
          [randomSlug(), url, createdBy]
        );
        return res.status(201).json({ ...rows[0], hits: Number(rows[0].hits) });
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    res.status(500).json({ error: 'could not allocate a free slug' });
  } catch (err) {
    next(err);
  }
});

// Look a slug up, reporting where the answer came from. This is the demo endpoint:
// the redirect below cannot show its own cache header to a browser, because a
// cross-origin redirect is opaque to fetch().
async function lookup(slug) {
  const started = process.hrtime.bigint();
  const cached = await cacheGet(`link:${slug}`);
  if (cached) {
    return { url: cached, source: 'hit', ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }
  const { rows } = await pool.query('select url from links where slug = $1', [slug]);
  if (!rows.length) {
    return { url: null, source: 'miss', ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }
  await cacheSet(`link:${slug}`, rows[0].url, CACHE_TTL_SECONDS);
  return { url: rows[0].url, source: 'miss', ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

app.get('/api/resolve/:slug', async (req, res, next) => {
  try {
    const result = await lookup(req.params.slug);
    if (!result.url) return res.status(404).json({ error: 'no such link' });
    await bumpHits(req.params.slug);
    res.set('x-zepit-cache', result.source);
    res.set('x-zepit-lookup-ms', result.ms.toFixed(2));
    res.json({ slug: req.params.slug, url: result.url, cache: result.source, lookupMs: Number(result.ms.toFixed(2)) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/links/:slug', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('delete from links where slug = $1', [req.params.slug]);
    if (!rowCount) return res.status(404).json({ error: 'no such link' });
    // Both keys, or a deleted link keeps redirecting until its TTL expires.
    await cacheDel([`link:${req.params.slug}`, `hits:${req.params.slug}`]);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// The actual short link. Registered last so it can never shadow an /api route.
app.get('/:slug', async (req, res, next) => {
  try {
    if (RESERVED.has(req.params.slug.toLowerCase())) return res.status(404).json({ error: 'not found' });
    const result = await lookup(req.params.slug);
    if (!result.url) return res.status(404).json({ error: 'no such link' });
    await bumpHits(req.params.slug);
    res.set('x-zepit-cache', result.source);
    res.set('x-zepit-lookup-ms', result.ms.toFixed(2));
    res.redirect(302, result.url);
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
    create table if not exists links (
      id bigserial primary key,
      slug text not null unique,
      url text not null,
      created_by text not null default 'anon',
      hits bigint not null default 0,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query('create index if not exists links_created_at_idx on links (created_at desc)');

  // Not awaited: the API must serve requests even if Valkey is still coming up, and
  // node-redis reconnects on its own once it does.
  cache.connect().catch((err) => console.error('initial valkey connect failed:', err.message));

  app.listen(PORT, '0.0.0.0', () => console.log(`${SITE_TITLE} api listening on ${PORT}`));
}

start().catch((err) => {
  console.error('startup failed', err);
  process.exit(1);
});
