const { pool } = require('./db');

async function create(archetype, fields) {
  const { rows } = await pool.query(
    'insert into jobs (archetype, fields) values ($1, $2) returning *',
    [archetype, fields]
  );
  return rows[0];
}

async function get(id) {
  const { rows } = await pool.query('select * from jobs where id = $1', [id]);
  return rows[0] || null;
}

async function list(limit = 50) {
  const { rows } = await pool.query(
    'select * from jobs order by created_at desc limit $1',
    [limit]
  );
  return rows;
}

// Claim exactly one queued job. SKIP LOCKED so a second backend replica can never
// hand the same job to two orchestrators — zcli pushes are not safely concurrent.
async function claimNext() {
  const { rows } = await pool.query(`
    update jobs set status = 'provisioning', step = 'claimed', updated_at = now()
    where id = (
      select id from jobs where status = 'queued'
      order by created_at
      for update skip locked
      limit 1
    )
    returning *
  `);
  return rows[0] || null;
}

async function patch(id, patchFields) {
  const keys = Object.keys(patchFields);
  if (!keys.length) return get(id);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `update jobs set ${set}, updated_at = now() where id = $1 returning *`,
    [id, ...keys.map((k) => patchFields[k])]
  );
  return rows[0];
}

// Append-only progress trail. Kept on the row so the step-6 frontend can poll one
// endpoint and render the whole PIPELINE.md sequence without a log service.
async function log(id, message) {
  const entry = JSON.stringify([{ at: new Date().toISOString(), message }]);
  await pool.query(
    `update jobs set log = log || $2::jsonb, updated_at = now() where id = $1`,
    [id, entry]
  );
  console.log(`[job ${id}] ${message}`);
}

async function finish(id, patchFields) {
  return patch(id, { ...patchFields, finished_at: new Date() });
}

// Any job left mid-flight by a crash or redeploy is dead — the zcli child process
// died with the container. Mark them failed at boot rather than leaving them
// spinning forever in the UI.
async function failOrphans() {
  const { rowCount } = await pool.query(`
    update jobs
    set status = 'failed',
        error = 'backend restarted while this job was in flight',
        finished_at = now(),
        updated_at = now()
    where status in ('provisioning', 'building')
  `);
  return rowCount;
}

module.exports = { create, get, list, claimNext, patch, log, finish, failOrphans };
