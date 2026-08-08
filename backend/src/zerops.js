const { execFile } = require('child_process');

const API_BASE = process.env.ZEROPS_API_BASE || 'https://api.app-prg1.zerops.io/api/rest/public';
// Zerops reserves the `ZEROPS_` prefix for its own injected variables and rejects
// any import YAML that defines one, so on Zerops the token must be named
// ZEPIT_ZEROPS_TOKEN. The unprefixed name stays supported for local runs.
const TOKEN = process.env.ZEPIT_ZEROPS_TOKEN || process.env.ZEROPS_TOKEN;
const ZCLI = process.env.ZCLI_BIN || 'zcli';

// The token appears in `zcli login <token>` and so in any error echoing the command
// line. Scrub it everywhere rather than relying on remembering not to log it.
function redact(text) {
  if (!text || !TOKEN) return text;
  return String(text).split(TOKEN).join('<REDACTED-TOKEN>');
}

class ZeropsError extends Error {
  constructor(message, detail) {
    super(redact(message));
    this.detail = redact(detail);
  }
}

// The Zerops API times out intermittently from some networks (observed repeatedly on
// 2026-08-07: `dial tcp 93.185.106.129:443: connect: connection timed out`). A single
// blip mid-job otherwise fails a deploy that was working, which is unacceptable in
// front of a judge. Retry only transient transport failures — never a real rejection.
// `closed pipe` / `unexpected EOF` are how zcli reports an interrupted package
// upload — seen on the first real run, mid-push, on an otherwise healthy job.
const TRANSIENT = /connection timed out|connection refused|no such host|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network is unreachable|TLS handshake|closed pipe|broken pipe|unexpected EOF|502|503|504/i;

async function withRetry(label, fn, { attempts = 4, baseDelayMs = 4000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const text = `${err.message || ''} ${err.detail || ''}`;
      if (!TRANSIENT.test(text) || i === attempts) throw err;
      const wait = baseDelayMs * i;
      console.warn(`${label}: transient failure (attempt ${i}/${attempts}), retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Never build a shell string — args go through execFile as an array so a template
// field containing a quote or a semicolon can't become part of the command.
// `retry` is opt-in per call site, never a default: re-running `service-import`
// after it half-succeeded would create a second set of services. Only commands that
// are safe to repeat (push, enable-subdomain) pass it.
function zcli(args, { timeoutMs = 15 * 60 * 1000, cwd, retry = false } = {}) {
  const once = () => zcliOnce(args, { timeoutMs, cwd });
  return retry ? withRetry(`zcli ${args[0]} ${args[1] || ''}`, once) : once();
}

function zcliOnce(args, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    execFile(ZCLI, args, { timeout: timeoutMs, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err) {
        return reject(new ZeropsError(`zcli ${args[0]} ${args[1] || ''} failed: ${err.message}`, out));
      }
      resolve(out);
    });
  });
}

async function login() {
  if (!TOKEN) throw new ZeropsError('ZEROPS_TOKEN is not set');
  await zcli(['login', TOKEN], { timeoutMs: 60_000 });
}

// Reads are always safe to repeat, so these retry unconditionally.
async function rest(path) {
  if (!TOKEN) throw new ZeropsError('ZEROPS_TOKEN is not set');
  return withRetry(`GET ${path}`, async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // fetch rejects on transport failure; normalise so withRetry can classify it.
      throw new ZeropsError(`GET ${path} failed: ${err.message}`, 'ETIMEDOUT');
    }
    const body = await res.text();
    if (!res.ok) throw new ZeropsError(`GET ${path} -> ${res.status}`, body.slice(0, 500));
    return JSON.parse(body);
  });
}

// zcli has no command for reading a service's public URL or live status; the REST
// API is the only source. See PIPELINE.md "Reading the URL".
async function getServiceStack(serviceId) {
  return rest(`/service-stack/${serviceId}`);
}

function subdomainOf(stack) {
  const entry = (stack.userData || []).find((u) => u.key === 'zeropsSubdomain');
  const value = entry && (entry.content || entry.value);
  return value || null;
}

// Verified against the real API 2026-08-07: the wrapper key is `list` (with
// `totalCount`), and service stacks carry no top-level `hostname` — `name` holds it,
// and userData repeats it under key `hostname`. The project's own `core` service is
// in this list too, so callers must match by name rather than assume membership.
// The endpoint pages at 20 and truncates `list` silently — `totalCount` is the only
// signal that anything is missing. The orchestrator resolves hostname -> serviceStackId
// from this list, so in a project holding more than 20 services a just-imported service
// can fall off the page and the job fails with a bogus "not found". Page until the
// count is satisfied rather than trusting one request.
async function listProjectServices(projectId) {
  const PAGE = 100;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const body = await rest(`/project/${projectId}/service-stack?limit=${PAGE}&offset=${offset}`);
    const page = body.list || [];
    out.push(...page);
    const total = typeof body.totalCount === 'number' ? body.totalCount : out.length;
    if (!page.length || out.length >= total) return out;
  }
}

function hostnameOf(stack) {
  const entry = (stack.userData || []).find((u) => u.key === 'hostname');
  return (entry && entry.content) || stack.name || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deploys are async. Poll until ACTIVE, and treat the documented terminal failure
// states as failures immediately rather than burning the whole timeout on them.
async function waitForActive(serviceId, { timeoutMs = 10 * 60 * 1000, intervalMs = 5000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const stack = await getServiceStack(serviceId);
    if (stack.status !== last) {
      last = stack.status;
      if (onTick) onTick(stack.status);
    }
    if (stack.status === 'ACTIVE') return stack;
    if (/FAIL|ERROR|DELET/i.test(stack.status || '')) {
      throw new ZeropsError(`service ${serviceId} entered terminal state ${stack.status}`);
    }
    await sleep(intervalMs);
  }
  throw new ZeropsError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${serviceId} (last status ${last})`);
}

module.exports = {
  ZeropsError,
  zcli,
  login,
  rest,
  getServiceStack,
  listProjectServices,
  subdomainOf,
  hostnameOf,
  waitForActive,
  sleep,
};
