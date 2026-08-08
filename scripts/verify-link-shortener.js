// Per-archetype behavior health check for link-shortener.
// Proves the thing that makes this archetype worth having: that the Valkey service is
// really in the request path. A cache that is provisioned but unused would pass every
// check that only looked at links, so the MISS-then-HIT transition is asserted
// explicitly, and deletion is checked against BOTH stores.
const API = process.argv[2];

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const target = 'https://zerops.io/?zepit-verify=' + Date.now();

async function req(path, init) {
  const res = await fetch(`${API}${path}`, init);
  return res;
}

async function json(path, init) {
  const res = await req(path, init);
  if (!res.ok && res.status !== 204) fail(`${init?.method || 'GET'} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const health = await json('/healthz');
  if (health.archetype !== 'link-shortener') fail(`wrong archetype: ${health.archetype}`);
  if (health.db !== 'up') fail(`db not up: ${health.db}`);
  if (health.cache !== 'up') fail(`valkey not up: ${health.cache}`);
  console.log(`PASS: /healthz ok (site "${health.siteTitle}", db up, cache up)`);

  const created = await json('/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: target, createdBy: 'verifier' }),
  });
  if (!created.slug) fail('create returned no slug');
  console.log(`PASS: link created (/${created.slug})`);

  // First resolve: nothing is cached yet, so this must read Postgres.
  const first = await json(`/api/resolve/${created.slug}`);
  if (first.url !== target) fail(`resolve returned the wrong url: ${first.url}`);
  if (first.cache !== 'miss') fail(`first resolve should be a cache miss, got "${first.cache}"`);
  console.log(`PASS: first resolve is a cache MISS (${first.lookupMs}ms, from postgres)`);

  // Second resolve: the miss above warmed the cache, so Valkey must answer this one.
  // If the cache were decorative, this would still say "miss" and the check fails.
  const second = await json(`/api/resolve/${created.slug}`);
  if (second.cache !== 'hit') fail(`second resolve should be a cache hit, got "${second.cache}"`);
  if (second.url !== target) fail('cached url does not match the original');
  console.log(`PASS: second resolve is a cache HIT (${second.lookupMs}ms, from valkey)`);

  // The short link itself — a real 302 to the real target.
  const redirect = await req(`/${created.slug}`, { redirect: 'manual' });
  if (redirect.status !== 302) fail(`short link returned ${redirect.status}, expected 302`);
  if (redirect.headers.get('location') !== target) {
    fail(`302 pointed at ${redirect.headers.get('location')}`);
  }
  console.log(`PASS: /${created.slug} redirects 302 -> target (x-zepit-cache: ${redirect.headers.get('x-zepit-cache')})`);

  // Three resolves happened above; the counter lives in Valkey and is merged on read.
  const listed = (await json('/api/links')).find((l) => l.slug === created.slug);
  if (!listed) fail('created link missing from a fresh list read');
  if (listed.hits < 3) fail(`expected at least 3 clicks counted, got ${listed.hits}`);
  console.log(`PASS: clicks counted through valkey and merged on read (${listed.hits})`);

  await json(`/api/links/${created.slug}`, { method: 'DELETE' });
  const afterDelete = await req(`/api/resolve/${created.slug}`);
  if (afterDelete.status !== 404) {
    fail(`deleted link still resolves (${afterDelete.status}) — cache was not invalidated`);
  }
  console.log('PASS: delete removed it from postgres AND invalidated the cache');

  console.log('\nALL CHECKS PASSED');
}

const timer = setTimeout(() => fail('timed out'), 30000);
main().then(() => { clearTimeout(timer); process.exit(0); }).catch((e) => fail(e.message));
