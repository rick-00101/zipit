#!/usr/bin/env node
// Behavior check for the archetype classifier — the same golden rule as every other
// verify script: the LLM step is not trusted until this passes against the real API.
//
//   node scripts/verify-classifier.js
//   node scripts/verify-classifier.js "a kanban board for my design team"
//
// Reads backend/.env, so it exercises exactly the configuration the server will use.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader: the backend is started with `--env-file` in dev, but a bare
// `node scripts/...` has no such luxury.
const envPath = path.join(ROOT, 'backend', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const catalog = require(path.join(ROOT, 'backend/src/catalog'));
const classifier = require(path.join(ROOT, 'backend/src/classifier'));
const llm = require(path.join(ROOT, 'backend/src/llm'));

// Each case states the archetype a human would pick. A mismatch is not automatically
// a bug — it is a prompt problem worth seeing — so it is reported, not thrown.
const CASES = [
  { description: 'a live chat room for my study group', expect: 'realtime-chat' },
  { description: 'somewhere my team can track what everyone is working on, in columns', expect: 'task-board' },
  { description: 'a dark-themed message board for the Rust community called rustaceans', expect: 'realtime-chat' },
  { description: 'shorten long marketing URLs and count how many people click them', expect: 'link-shortener' },
];

async function main() {
  const custom = process.argv[2];
  const cases = custom ? [{ description: custom, expect: null }] : CASES;

  console.log(`provider: ${llm.describe()}`);
  if (!llm.isConfigured()) {
    console.error('\nno API key found. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) in backend/.env');
    process.exit(1);
  }

  const catalogue = await catalog.load();
  console.log(`archetypes: ${Object.keys(catalogue).join(', ')}\n`);

  let failures = 0;
  for (const c of cases) {
    process.stdout.write(`> ${c.description}\n`);
    const started = Date.now();
    try {
      const result = await classifier.classify(c.description, catalogue);
      // The server validates before deploying; do the same here or the check would
      // pass on field values that the deploy path would reject.
      const fields = catalog.validateFields(catalogue[result.archetype], result.fields);

      const ok = !c.expect || result.archetype === c.expect;
      if (!ok) failures++;
      console.log(`  ${ok ? 'OK  ' : 'MISS'} ${result.archetype}${c.expect && !ok ? ` (expected ${c.expect})` : ''}`);
      console.log(`  fields    ${JSON.stringify(fields)}`);
      console.log(`  reasoning ${result.reasoning}`);
      console.log(
        `  model     ${result.model}  ${Date.now() - started}ms  ` +
          `in=${result.usage.input} out=${result.usage.output}\n`
      );
    } catch (err) {
      failures++;
      console.log(`  FAIL ${err.message}\n`);
    }
  }

  if (failures) {
    console.error(`${failures}/${cases.length} case(s) did not pass`);
    process.exit(1);
  }
  console.log(`all ${cases.length} case(s) passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
