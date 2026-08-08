const path = require('path');
const express = require('express');

const db = require('./db');
const jobs = require('./jobs');
const catalog = require('./catalog');
const worker = require('./worker');
const classifier = require('./classifier');
const z = require('./zerops');

const PORT = Number(process.env.PORT) || 3000;

// Step 4 runs with the archetype hard-coded and no LLM. Step 5 replaces this
// constant with the structured classification call — keeping them separate means a
// broken LLM response can never be mistaken for a broken pipeline.
const HARDCODED_ARCHETYPE = process.env.ZEPIT_ARCHETYPE || 'realtime-chat';

const app = express();
app.use(express.json());

// On Zerops the UI is its own `static` service on a different subdomain, so every
// call from it is cross-origin. Locally the backend serves the UI itself and this is
// a no-op. Wide open because Zepit's API is a public demo with no user data — the
// real credential is the server-side PAT, which never leaves the container.
app.use((_req, res, next) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', 'content-type');
  res.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

// In local dev the backend serves Zepit's own UI so there is one thing to run. On
// Zerops the UI is its own `static` service and this is simply never hit.
if (process.env.ZEPIT_SERVE_UI !== 'false') {
  app.use(express.static(path.resolve(__dirname, '../../frontend')));
}

app.get('/healthz', async (_req, res) => {
  try {
    await db.pool.query('select 1');
    res.json({
      status: 'ok',
      service: 'zepit-backend',
      db: 'up',
      archetype: HARDCODED_ARCHETYPE,
      zeropsToken: (process.env.ZEPIT_ZEROPS_TOKEN || process.env.ZEROPS_TOKEN) ? 'set' : 'MISSING',
      zeropsProjectId: process.env.ZEPIT_ZEROPS_PROJECT_ID || process.env.ZEROPS_PROJECT_ID || 'MISSING',
      llm: classifier.describe(),
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: err.message });
  }
});

app.get('/api/archetypes', async (_req, res, next) => {
  try {
    const loaded = await catalog.load();
    res.json(
      Object.values(loaded).map((m) => ({
        id: m.id,
        description: m.description,
        fields: m.fields,
        services: m.services.map((s) => ({ role: s.role, type: s.type })),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Classify a description without deploying anything, so the UI can show the match
// and let the user correct it before committing real infrastructure.
app.post('/api/classify', async (req, res, next) => {
  try {
    const loaded = await catalog.load();
    const result = await classifier.classify(req.body.description, loaded);
    // Validate the model's field values against the manifest before returning them:
    // the schema constrains shape and enums, not string lengths.
    result.fields = catalog.validateFields(loaded[result.archetype], result.fields);
    res.json(result);
  } catch (err) {
    if (err instanceof classifier.ClassificationError) return res.status(400).json({ error: err.message });
    if (err instanceof catalog.ValidationError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.post('/api/deploy', async (req, res, next) => {
  try {
    const loaded = await catalog.load();

    // Three sources for the archetype, in order: an explicit choice from the caller,
    // the LLM classifier when only a description was sent, and the hard-coded default
    // as a last resort. The explicit path is what the demo drives, so a broken or
    // unconfigured LLM can never take the deploy path down with it.
    let archetype = req.body.archetype;
    let fields = req.body.fields || {};
    let classification = null;

    if (!archetype && req.body.description && classifier.isConfigured()) {
      try {
        classification = await classifier.classify(req.body.description, loaded);
        archetype = classification.archetype;
        // Caller-supplied fields still win — the classifier only fills the gaps.
        fields = { ...classification.fields, ...fields };
      } catch (err) {
        console.error('classification failed, falling back:', err.message);
      }
    }

    archetype = archetype || HARDCODED_ARCHETYPE;
    const manifest = loaded[archetype];
    if (!manifest) return res.status(400).json({ error: `unknown archetype: ${archetype}` });

    const validated = catalog.validateFields(manifest, fields);
    const job = await jobs.create(archetype, validated);
    res.status(202).json({
      id: job.id,
      status: job.status,
      archetype,
      fields: validated,
      classification: classification && {
        reasoning: classification.reasoning,
        match: classification.match,
        requested: classification.requested,
        model: classification.model,
      },
    });
  } catch (err) {
    if (err instanceof catalog.ValidationError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.get('/api/jobs', async (_req, res, next) => {
  try {
    res.json(await jobs.list());
  } catch (err) {
    next(err);
  }
});

app.get('/api/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'no such job' });
    res.json(job);
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
  await db.init();

  const orphaned = await jobs.failOrphans();
  if (orphaned) console.log(`marked ${orphaned} orphaned job(s) failed after restart`);

  // zcli keeps credentials on disk; on a fresh container it has none. Log in once
  // at boot so the first job doesn't pay for it — and so a bad token fails loudly
  // here rather than halfway through a deploy.
  if (process.env.ZEPIT_ZEROPS_TOKEN || process.env.ZEROPS_TOKEN) {
    try {
      await z.login();
      console.log('zcli authenticated');
    } catch (err) {
      console.error('zcli login failed — deploys will fail:', err.message, err.detail || '');
    }
  } else {
    console.error('ZEPIT_ZEROPS_TOKEN not set — deploys will fail');
  }

  worker.start();
  app.listen(PORT, '0.0.0.0', () => console.log(`zepit backend listening on ${PORT}`));
}

start().catch((err) => {
  console.error('startup failed', err);
  process.exit(1);
});
