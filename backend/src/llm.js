// Provider-neutral seam for the one thing Zepit ever asks a model to do: return a
// single JSON object matching a schema. Everything above this file is provider
// agnostic — adding a provider means adding one entry here and nothing else.
//
// Anthropic and Gemini both constrain generation to a schema, but they spell the
// request differently and accept different schema dialects. toGeminiSchema() is the
// entirety of that difference.

const DEFAULT_MODEL = {
  anthropic: 'claude-opus-5',
  gemini: 'gemini-2.5-flash',
};

// Checked in this order when ZEPIT_LLM_PROVIDER is unset.
const API_KEY_VARS = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

const GEMINI_BASE_URL =
  process.env.ZEPIT_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = Number(process.env.ZEPIT_LLM_TIMEOUT_MS) || 60_000;

class LLMError extends Error {}

const keyFor = (name) => API_KEY_VARS[name].map((v) => process.env[v]).find(Boolean) || null;

// Resolved on every call rather than at require time: scripts and tests set the
// environment after loading this module, and on Zerops it is fixed at boot anyway.
function provider() {
  const explicit = process.env.ZEPIT_LLM_PROVIDER;
  if (explicit) {
    if (!DEFAULT_MODEL[explicit]) {
      throw new LLMError(
        `unknown ZEPIT_LLM_PROVIDER: ${explicit} (expected ${Object.keys(DEFAULT_MODEL).join(' or ')})`
      );
    }
    return explicit;
  }
  // Whichever key is present wins; set ZEPIT_LLM_PROVIDER to break a tie.
  return Object.keys(DEFAULT_MODEL).find(keyFor) || null;
}

function model() {
  const name = provider();
  return process.env.ZEPIT_LLM_MODEL || (name && DEFAULT_MODEL[name]) || null;
}

const isConfigured = () => {
  const name = provider();
  return Boolean(name && keyFor(name));
};

const describe = () => (isConfigured() ? `${provider()}:${model()}` : 'not configured');

// Returns { text, model, usage } with `text` guaranteed non-empty. Parsing and
// validating that text is the caller's job — the schema constrains shape, not
// semantics.
async function complete({ system, user, schema, maxTokens = 4096 }) {
  if (!isConfigured()) {
    throw new LLMError(
      'no LLM API key is set — set GEMINI_API_KEY or ANTHROPIC_API_KEY'
    );
  }
  return provider() === 'gemini'
    ? geminiComplete({ system, user, schema, maxTokens })
    : anthropicComplete({ system, user, schema, maxTokens });
}

let anthropicClient = null;

async function anthropicComplete({ system, user, schema, maxTokens }) {
  // Required lazily so a Gemini-only deployment never needs the SDK present.
  const Anthropic = require('@anthropic-ai/sdk');
  if (!anthropicClient) anthropicClient = new Anthropic();

  let res;
  try {
    res = await anthropicClient.messages.create({
      model: model(),
      max_tokens: maxTokens,
      system,
      output_config: {
        // A small, well-scoped task: low effort keeps it fast and cheap without
        // touching quality. Thinking stays on (the default on Opus 5).
        effort: process.env.ZEPIT_LLM_EFFORT || 'low',
        format: { type: 'json_schema', schema },
      },
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    throw new LLMError(`request to Anthropic failed: ${err.message}`);
  }

  // A refusal returns HTTP 200 with an empty or partial content array — check the
  // stop reason before reading content, or this throws on an index that isn't there.
  if (res.stop_reason === 'refusal') throw new LLMError('the model declined to answer');
  if (res.stop_reason === 'max_tokens') throw new LLMError('response was truncated (max_tokens)');

  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new LLMError('no text block in the Anthropic response');

  return {
    text: block.text,
    model: res.model,
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  };
}

async function geminiComplete({ system, user, schema, maxTokens }) {
  const name = model();
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
    },
  };

  // 2.5 models think by default and thinking tokens are charged against
  // maxOutputTokens — enough of them and the answer itself gets truncated. Opt in
  // to a budget only when asked: flash accepts 0, pro has a nonzero floor and 400s.
  const budget = process.env.ZEPIT_LLM_THINKING_BUDGET;
  if (budget !== undefined && budget !== '') {
    body.generationConfig.thinkingConfig = { thinkingBudget: Number(budget) };
  }

  let res;
  try {
    res = await fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(name)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': keyFor('gemini') },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LLMError(`request to Gemini failed: ${err.message}`);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (payload && payload.error && payload.error.message) || `HTTP ${res.status}`;
    throw new LLMError(`Gemini rejected the request: ${detail}`);
  }

  // A blocked prompt comes back 200 with no candidates at all.
  const blockReason = payload.promptFeedback && payload.promptFeedback.blockReason;
  if (blockReason) throw new LLMError(`Gemini blocked the prompt (${blockReason})`);

  const candidate = (payload.candidates || [])[0];
  if (!candidate) throw new LLMError('Gemini returned no candidates');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new LLMError(`Gemini stopped early (${candidate.finishReason})`);
  }

  // Thought summaries arrive as parts flagged `thought` — they are not the answer.
  const text = (((candidate.content || {}).parts) || [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('');
  if (!text) throw new LLMError('no text in the Gemini response');

  const usage = payload.usageMetadata || {};
  return {
    text,
    model: payload.modelVersion || name,
    usage: {
      input: usage.promptTokenCount,
      output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    },
  };
}

// Gemini's responseSchema is an OpenAPI 3.0 subset: it has no `additionalProperties`
// and no `const`. Everything else the classifier emits — type, enum, anyOf,
// properties, required, description — carries over unchanged.
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties') continue;
    if (key === 'const') {
      out.type = typeof value === 'string' ? 'string' : out.type;
      out.enum = [value];
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  // Gemini emits properties in whatever order it likes unless told; pinning it keeps
  // responses stable and, on object schemas, is what the docs recommend.
  if (out.type === 'object' && out.properties) out.propertyOrdering = Object.keys(out.properties);
  return out;
}

module.exports = {
  LLMError,
  complete,
  isConfigured,
  describe,
  provider,
  model,
  toGeminiSchema,
};
