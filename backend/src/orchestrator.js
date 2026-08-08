const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const catalog = require('./catalog');
const jobs = require('./jobs');
const z = require('./zerops');

const PROJECT_ID = process.env.ZEPIT_ZEROPS_PROJECT_ID || process.env.ZEROPS_PROJECT_ID;
const SCRIPTS_DIR = process.env.ZEPIT_SCRIPTS_DIR || path.resolve(__dirname, '../../scripts');
const HEALTHCHECK_TIMEOUT_MS = Number(process.env.ZEPIT_HEALTHCHECK_TIMEOUT_MS) || 60_000;

// Zerops hostnames are short and lowercase-alphanumeric. Four base36 chars keeps
// `chat` + suffix well inside the limit while making collisions between concurrent
// jobs effectively impossible.
function hostnamePrefix(manifest) {
  const suffix = crypto.randomBytes(4).toString('hex').slice(0, 4);
  return `${manifest.hostnamePrefix}${suffix}`;
}

// This is PIPELINE.md, in order, with each gotcha honoured where it was found.
async function run(job) {
  const catalogue = await catalog.load();
  const manifest = catalogue[job.archetype];
  if (!manifest) throw new Error(`unknown archetype: ${job.archetype}`);
  if (!PROJECT_ID) throw new Error('ZEROPS_PROJECT_ID is not set');

  const prefix = hostnamePrefix(manifest);
  const values = { ...job.fields, prefix };

  // 1. Copy the template. The template itself is never touched.
  await jobs.patch(job.id, { step: 'preparing', project_id: PROJECT_ID });
  const jobDir = await catalog.prepareJobDir(job.id, manifest);
  await jobs.log(job.id, `prepared job dir with hostname prefix ${prefix}`);

  // 2. Render the import YAML into the job's copy.
  const template = await fs.readFile(path.join(jobDir, 'import.template.yaml'), 'utf8');
  const importPath = path.join(jobDir, 'import.yaml');
  await fs.writeFile(importPath, catalog.render(template, values));
  await jobs.log(job.id, 'rendered import.yaml');

  // 3. Import. Databases come up ACTIVE; runtime services land READY_TO_DEPLOY.
  await jobs.patch(job.id, { step: 'importing' });
  await z.zcli(['project', 'service-import', importPath, '--project-id', PROJECT_ID]);
  await jobs.log(job.id, 'service-import accepted');

  // Resolve hostname -> serviceStackId once, from the project's own service list.
  // Unambiguous because the prefix is unique to this job.
  const stacks = await z.listProjectServices(PROJECT_ID);
  const services = {};
  for (const svc of manifest.services) {
    const hostname = catalog.render(svc.hostname, values);
    const match = stacks.find((s) => z.hostnameOf(s) === hostname);
    if (!match) throw new Error(`imported service ${hostname} not found in project ${PROJECT_ID}`);
    services[svc.role] = { id: match.id, hostname, role: svc.role };
  }
  await jobs.patch(job.id, { services, step: 'imported' });
  await jobs.log(job.id, `resolved service ids: ${Object.values(services).map((s) => `${s.hostname}=${s.id}`).join(', ')}`);

  // Wait for every managed service — anything with no `dir` to push, so databases and
  // caches alike — before deploying code that connects to it. Keyed on the absence of
  // `dir` rather than on `role === 'database'`, or link-shortener's valkey would be
  // raced by the api push.
  for (const svc of manifest.services.filter((s) => !s.dir)) {
    await z.waitForActive(services[svc.role].id, {
      onTick: (status) => jobs.log(job.id, `${svc.role} status ${status}`),
    });
    await jobs.log(job.id, `${svc.role} (${services[svc.role].hostname}) ACTIVE`);
  }

  // 4-8. Push each deployable service in manifest order — api before frontend,
  // because the frontend's generated config needs the api's resolved URL.
  await jobs.patch(job.id, { status: 'building' });
  const urls = {};

  for (const svc of manifest.services.filter((s) => s.dir)) {
    const svcState = services[svc.role];

    // A generated config file is written into the job copy just before the push,
    // so the same tested source ships every time (PIPELINE.md gotcha 3).
    if (svc.generateConfig) {
      const target = path.join(jobDir, svc.dir, svc.generateConfig);
      await fs.writeFile(target, renderConfigJs(urls.api, job.fields));
      await jobs.log(job.id, `wrote generated ${svc.generateConfig} with apiUrl ${urls.api}`);
    }

    await jobs.patch(job.id, { step: `pushing:${svcState.hostname}` });
    // `--setup` must be explicit: zcli defaults it to the service hostname, and our
    // hostnames now carry a per-job prefix that no zerops.yaml can predict.
    await z.zcli([
      'service', 'push',
      '--project-id', PROJECT_ID,
      '--service-id', svcState.id,
      '--working-dir', path.join(jobDir, svc.dir),
      '--setup', svc.setup,
      '--no-git',
    ], { retry: true });
    await jobs.log(job.id, `pushed ${svcState.hostname}`);

    await z.waitForActive(svcState.id, {
      onTick: (status) => jobs.log(job.id, `${svcState.hostname} status ${status}`),
    });

    // Subdomains only work after a successful deploy — the ports don't exist until
    // zerops.yaml has been applied (PIPELINE.md gotcha 2). Never set it in the YAML.
    if (svc.subdomain) {
      await jobs.patch(job.id, { step: `subdomain:${svcState.hostname}` });
      await z.zcli(
        ['service', 'enable-subdomain', '--project-id', PROJECT_ID, '--service-id', svcState.id],
        { retry: true }
      );
      const url = await resolveSubdomain(job, svcState);
      urls[svc.role] = url;
      await jobs.log(job.id, `${svcState.hostname} public at ${url}`);
      await jobs.patch(job.id, svc.role === 'api' ? { api_url: url } : { app_url: url });
    }
  }

  // 9. Behavior check. The golden rule: the URL is not trusted until this passes.
  await jobs.patch(job.id, { step: 'health-check' });
  await runHealthCheck(job, manifest, urls.api);
  await jobs.log(job.id, 'behavior health check PASSED');

  await jobs.finish(job.id, { status: 'live', step: 'done', error: null });
  return { appUrl: urls.frontend, apiUrl: urls.api };
}

// Archetype-agnostic: the api URL plus every personalization field, verbatim under
// its manifest name. Frontends read what they need and ignore the rest.
function renderConfigJs(apiUrl, fields) {
  const config = { apiUrl, ...fields };
  return [
    '// GENERATED PER DEPLOYMENT by Zepit — do not hand-edit.',
    '// Written into the job copy of the template after the api subdomain resolved.',
    `window.ZEPIT_CONFIG = ${JSON.stringify(config, null, 2)};`,
    '',
  ].join('\n');
}

// enable-subdomain returns before the URL is populated on the service stack, so
// poll userData rather than reading it once.
async function resolveSubdomain(job, svcState, { attempts = 30, intervalMs = 4000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const stack = await z.getServiceStack(svcState.id);
    const url = z.subdomainOf(stack);
    if (url) return url;
    await z.sleep(intervalMs);
  }
  throw new Error(`subdomain for ${svcState.hostname} never appeared in userData`);
}

// Each archetype ships its own check. Run as a child process so a hanging or
// crashing check can't take the orchestrator down with it.
function runHealthCheck(job, manifest, apiUrl) {
  const script = path.join(SCRIPTS_DIR, manifest.healthCheck.script);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, apiUrl],
      {
        timeout: HEALTHCHECK_TIMEOUT_MS,
        // The checks `require('ws')`; resolve it from the backend's own modules.
        env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../node_modules') },
      },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        jobs.log(job.id, `health check output: ${out.replace(/\s+/g, ' ').slice(0, 500)}`);
        if (err) return reject(new Error(`behavior health check failed: ${out || err.message}`));
        resolve(out);
      }
    );
  });
}

module.exports = { run };
