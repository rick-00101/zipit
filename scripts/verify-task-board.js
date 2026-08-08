// Per-archetype behavior health check for task-board.
// Proves: api is up and personalized, a card persists, a column move persists, and
// a delete really removes it — all read back through fresh requests, not from the
// response body of the write that created them.
const API = process.argv[2];

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const marker = 'zepit-verify-' + Date.now();

async function json(path, init) {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok && res.status !== 204) fail(`${init?.method || 'GET'} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const health = await json('/healthz');
  if (health.archetype !== 'task-board') fail(`wrong archetype: ${health.archetype}`);
  if (health.db !== 'up') fail(`db not up: ${health.db}`);
  console.log(`PASS: /healthz ok (board "${health.boardTitle}", owner "${health.owner}")`);

  const created = await json('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: marker, author: 'verifier' }),
  });
  if (!created.id) fail('create returned no id');
  console.log(`PASS: card created (id ${created.id}, col ${created.col})`);

  const afterCreate = await json('/api/tasks');
  if (!afterCreate.some((t) => t.id === created.id && t.title === marker)) {
    fail('created card did not come back from a fresh read');
  }
  console.log(`PASS: card persisted in postgres (${afterCreate.length} cards on board)`);

  await json(`/api/tasks/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ col: 'doing' }),
  });
  const afterMove = await json('/api/tasks');
  const moved = afterMove.find((t) => t.id === created.id);
  if (!moved || moved.col !== 'doing') fail(`column move did not persist (col=${moved && moved.col})`);
  console.log('PASS: column move persisted (todo -> doing)');

  await json(`/api/tasks/${created.id}`, { method: 'DELETE' });
  const afterDelete = await json('/api/tasks');
  if (afterDelete.some((t) => t.id === created.id)) fail('deleted card still present');
  console.log('PASS: delete removed the card');

  console.log('\nALL CHECKS PASSED');
}

const timer = setTimeout(() => fail('timed out'), 25000);
main().then(() => { clearTimeout(timer); process.exit(0); }).catch((e) => fail(e.message));
