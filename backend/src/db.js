const { Pool } = require('pg');

// Same convention as the archetype templates: pg self-configures from
// PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE rather than an assembled URL.
const pool = new Pool({ max: 5 });

// One row per deploy request. `status` is the state machine promised in plan.txt
// step 4: queued -> provisioning -> building -> live | failed.
// `step` is the finer-grained PIPELINE.md stage, for the UI in step 6.
const SCHEMA = `
  create table if not exists jobs (
    id          uuid primary key default gen_random_uuid(),
    archetype   text        not null,
    fields      jsonb       not null default '{}',
    status      text        not null default 'queued',
    step        text,
    project_id  text,
    services    jsonb       not null default '{}',
    api_url     text,
    app_url     text,
    error       text,
    log         jsonb       not null default '[]',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    finished_at timestamptz
  );
  create index if not exists jobs_status_created_idx on jobs (status, created_at);
`;

async function init() {
  await pool.query(SCHEMA);
}

module.exports = { pool, init };
