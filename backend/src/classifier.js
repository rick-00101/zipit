const llm = require('./llm');

// Which model runs this is a deployment decision, not a classifier one: llm.js picks
// the provider from whichever API key is present. See backend/.env.example.
const { isConfigured, describe } = llm;

// The whole safety property of Zepit's LLM step lives here: the schema is generated
// from the manifests, so the model picks from a closed set of archetypes and a closed
// set of fields per archetype. It cannot invent an archetype, add a field, or return
// a value outside an enum — the API constrains generation to this shape.
//
// This is the strict dialect (const, additionalProperties: false). llm.js relaxes it
// for providers whose schema support is narrower.
function buildSchema(catalogue) {
  const branches = Object.values(catalogue).map((manifest) => {
    const properties = {
      archetype: { const: manifest.id, description: manifest.description },
    };
    const fieldProps = {};
    for (const [name, rule] of Object.entries(manifest.fields || {})) {
      fieldProps[name] =
        rule.type === 'enum'
          ? { type: 'string', enum: rule.values }
          : { type: 'string', description: `Max ${rule.maxLength} characters.` };
    }
    properties.fields = {
      type: 'object',
      properties: fieldProps,
      required: Object.keys(fieldProps),
      additionalProperties: false,
    };

    return {
      type: 'object',
      properties,
      required: ['archetype', 'fields'],
      additionalProperties: false,
    };
  });

  return {
    type: 'object',
    properties: {
      choice: { anyOf: branches },
      // The catalogue is small and always will be, so "what happens when the request
      // isn't in it" is the most likely thing a stranger does first. Making the model
      // grade its own match turns that from a silent wrong deploy into a state the UI
      // can render deliberately.
      match: {
        type: 'string',
        enum: ['strong', 'partial', 'none'],
        description: 'How well the chosen archetype actually matches what was asked for.',
      },
      requested: {
        type: 'string',
        description: 'Short noun phrase naming the kind of app the user asked for, in their words.',
      },
      reasoning: {
        type: 'string',
        description: 'One sentence explaining the archetype choice, shown to the user.',
      },
    },
    required: ['choice', 'match', 'requested', 'reasoning'],
    additionalProperties: false,
  };
}

function buildSystemPrompt(catalogue) {
  const lines = Object.values(catalogue).map((m) => {
    const fields = Object.entries(m.fields || {})
      .map(([name, rule]) =>
        rule.type === 'enum'
          ? `${name} (one of: ${rule.values.join(', ')})`
          : `${name} (text, max ${rule.maxLength} chars)`
      )
      .join('; ');
    const services = m.services.map((s) => s.type).filter(Boolean).join(', ');
    return `- ${m.id}: ${m.description}\n  services: ${services}\n  fields: ${fields}`;
  });

  return [
    'You match a plain-English app description to exactly one pre-built application',
    'archetype, and fill in that archetype\'s personalization fields.',
    '',
    'You are not writing or generating an application. The code for each archetype is',
    'already written and tested. Your only job is choosing which one to deploy and',
    'filling in a few values that become environment variables on the running services.',
    '',
    'Available archetypes:',
    ...lines,
    '',
    'Always pick the closest archetype, then grade that choice honestly in `match`:',
    '',
    '- "strong" — the user described one of these apps. Anyone would agree on the match.',
    '- "partial" — the archetype does the core of what they asked for, but they named',
    '  capabilities it does not have (payments, accounts, file uploads, search, …).',
    '- "none" — they asked for a fundamentally different kind of application. You still',
    '  return the closest archetype, but it is not the app they described.',
    '',
    'Grade this honestly. A request that is really an online store is "none" even though',
    'a task board also has lists. An inflated "strong" is far worse than an honest',
    '"none": the grade is shown to the user, who then decides whether to deploy anyway.',
    'Never stretch a match to seem helpful.',
    '',
    'Set `requested` to a short noun phrase for what they asked for, in their own terms',
    '("an online store", "a photo gallery with uploads"). It is shown back to them.',
    '',
    'Fill every field of the chosen archetype. Derive values from the description where',
    'it gives you something to work with (a team name, a topic, a stated preference for',
    'light or dark); otherwise choose something sensible and specific rather than',
    'generic. Keep text fields within their stated length limits.',
  ].join('\n');
}

class ClassificationError extends Error {}

// Returns { archetype, fields, reasoning, model }. Fields are still validated against
// the manifest by the caller — structured output constrains the shape, not the
// semantics, and a maxLength overrun is the model's most likely miss.
async function classify(description, catalogue) {
  if (!description || !description.trim()) throw new ClassificationError('description is empty');

  let response;
  try {
    response = await llm.complete({
      system: buildSystemPrompt(catalogue),
      user: description.slice(0, 2000),
      schema: buildSchema(catalogue),
      maxTokens: 4096,
    });
  } catch (err) {
    if (err instanceof llm.LLMError) throw new ClassificationError(err.message);
    throw new ClassificationError(`LLM request failed: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new ClassificationError('classification response was not valid JSON');
  }

  const { choice, reasoning, match, requested } = parsed;
  if (!choice || !catalogue[choice.archetype]) {
    throw new ClassificationError(`model returned unknown archetype: ${choice && choice.archetype}`);
  }

  return {
    archetype: choice.archetype,
    fields: choice.fields || {},
    reasoning,
    // Default to the cautious end rather than the flattering one: an unrated match
    // must never render as a confident one.
    match: ['strong', 'partial', 'none'].includes(match) ? match : 'partial',
    requested: requested || '',
    model: response.model,
    usage: response.usage,
  };
}

module.exports = { classify, isConfigured, describe, ClassificationError };
