// spikes/12-summarize-local/schema.mjs
export const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 40 },
    one_liner: { type: 'string', maxLength: 80 },
    body: { type: 'string' },
    state: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'abandoned'] },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['title', 'one_liner', 'body', 'state', 'next_steps'],
};
if (process.argv[1]?.endsWith('schema.mjs')) console.log(JSON.stringify(schema));
