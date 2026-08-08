const fs = require('fs/promises');
const path = require('path');

const TEMPLATES_DIR = process.env.ZEPIT_TEMPLATES_DIR || path.resolve(__dirname, '../../templates');
const JOBS_DIR = process.env.ZEPIT_JOBS_DIR || path.resolve(__dirname, '../../.jobs');

async function load() {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
  const out = {};
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = path.join(TEMPLATES_DIR, e.name, 'manifest.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      out[manifest.id] = { ...manifest, dir: path.join(TEMPLATES_DIR, e.name) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return out;
}

class ValidationError extends Error {}

// Fields are user input that ends up inside a YAML document and inside env vars on
// a real machine. Validate against the manifest and reject anything that isn't a
// plain single-line string; do not try to sanitize it into shape.
function validateFields(manifest, input = {}) {
  const spec = manifest.fields || {};
  const unknown = Object.keys(input).filter((k) => !(k in spec));
  if (unknown.length) throw new ValidationError(`unknown field(s): ${unknown.join(', ')}`);

  const out = {};
  for (const [name, rule] of Object.entries(spec)) {
    const raw = input[name] === undefined || input[name] === '' ? rule.default : input[name];
    if (raw === undefined) throw new ValidationError(`missing required field: ${name}`);
    const value = String(raw);

    if (rule.type === 'enum') {
      if (!rule.values.includes(value)) {
        throw new ValidationError(`${name} must be one of: ${rule.values.join(', ')}`);
      }
    } else {
      if (rule.maxLength && value.length > rule.maxLength) {
        throw new ValidationError(`${name} exceeds maxLength ${rule.maxLength}`);
      }
      // Reject control characters: they survive into env vars and YAML unpredictably.
      if (/[\x00-\x1f\x7f]/.test(value)) {
        throw new ValidationError(`${name} may not contain control characters or newlines`);
      }
    }
    out[name] = value;
  }
  return out;
}

// The rendered value always lands inside a double-quoted YAML scalar, so escaping
// backslash and quote is sufficient and keeps the output readable.
const yamlEscape = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new ValidationError(`template placeholder {{${key}}} has no value`);
    return yamlEscape(values[key]);
  });
}

// Rule 1 of PIPELINE.md: never mutate the template. Each job gets its own copy and
// every generated file (import.yaml, config.js) is written only into that copy.
async function prepareJobDir(jobId, manifest) {
  const dir = path.join(JOBS_DIR, jobId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(manifest.dir, dir, { recursive: true });
  return dir;
}

module.exports = {
  TEMPLATES_DIR,
  JOBS_DIR,
  ValidationError,
  load,
  validateFields,
  render,
  prepareJobDir,
};
