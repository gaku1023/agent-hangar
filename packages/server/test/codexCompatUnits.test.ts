import { describe, expect, it } from 'vitest';
import { builtinSubcommandDrifts, helpDrifts, parseCodexHelp } from '../src/provider/codex/compat/help.ts';
import { appendOnlyDrifts, compressionDrifts, parseFeatureList } from '../src/provider/codex/compat/storage.ts';
import { shapeOfRollout } from '../src/provider/codex/compat/rolloutShape.ts';
import { diffJson, extractSchemaSubset, type SchemaMethod } from '../src/provider/codex/compat/schemaSubset.ts';

const bundle = {
  definitions: {
    Init: { type: 'object', properties: { a: { type: 'string', description: 'x' } } },
    ClientRequest: { oneOf: [{ properties: { method: { enum: ['foo/start'] }, params: { $ref: '#/definitions/v2/FooParams' } }, title: 'FooStartRequest' }] },
    ServerNotification: { oneOf: [{ properties: { method: { enum: ['foo/done'] }, params: { $ref: '#/definitions/v2/FooDone' } } }] },
    ServerRequest: { oneOf: [] },
    v2: {
      FooParams: { properties: { id: { $ref: '#/definitions/v2/Id' }, opt: { anyOf: [{ $ref: '#/definitions/Init' }, { type: 'null' }] } } },
      FooResponse: { type: 'object' },
      Id: { type: 'string', description: '説明は比べない' },
      FooDone: { type: 'object' },
      Unused: { type: 'string' },
    },
  },
};
const methods: SchemaMethod[] = [
  { kind: 'request', method: 'foo/start', response: 'v2/FooResponse' },
  { kind: 'notification', method: 'foo/done' },
];

describe('extractSchemaSubset', () => {
  it('使う要求と通知の包みと、参照をたどった定義だけを取り、description は落とす', () => {
    const s = extractSchemaSubset(bundle, methods);
    expect(Object.keys(s.methods)).toEqual(['notification foo/done', 'request foo/start']);
    expect(Object.keys(s.definitions)).toEqual(['Init', 'v2/FooDone', 'v2/FooParams', 'v2/FooResponse', 'v2/Id']);
    expect(JSON.stringify(s)).not.toContain('説明は比べない');
  });
  it('無い方法と無い参照は、黙らず投げる', () => {
    expect(() => extractSchemaSubset(bundle, [{ kind: 'request', method: 'nope' }])).toThrow(/request nope/);
    expect(() => extractSchemaSubset(bundle, [{ kind: 'request', method: 'foo/start', response: 'v2/Gone' }])).toThrow(/v2\/Gone/);
  });
});

describe('diffJson', () => {
  it('同じなら空、違いはパスつきで出す', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
    const d = diffJson({ a: { x: 1 }, gone: 1, arr: [1, 2] }, { a: { x: 2 }, added: true, arr: [1] });
    expect(d).toContain('a.x: 1 -> 2');
    expect(d).toContain('gone: in the fixture, missing now');
    expect(d).toContain('added: not in the fixture, present now');
    expect(d.some((l) => l.startsWith('arr'))).toBe(true);
  });
  it('差が多いときは上限で切る', () => {
    const a = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 1]));
    const d = diffJson(a, {}, 10);
    expect(d.length).toBe(11);
    expect(d[10]).toMatch(/and 90 more/);
  });
});

describe('shapeOfRollout', () => {
  const l = (type: string, payload: unknown) => ({ timestamp: 't', type, payload });
  it('行の種類ごとに、キーの道と型を畳む。値は見ない', () => {
    const a = shapeOfRollout([l('session_meta', { id: 'a', n: 1 }), l('event_msg', { type: 'task_started', x: null }), l('event_msg', { type: 'task_started', x: 'y' })]);
    const b = shapeOfRollout([l('session_meta', { id: 'zzz', n: 99 }), l('event_msg', { type: 'task_started', x: 'q' }), l('event_msg', { type: 'task_started', x: null })]);
    expect(a).toEqual(b);
    expect(a['event_msg/task_started']).toEqual({ timestamp: 'string', type: 'string', 'payload.type': 'string', 'payload.x': 'null|string' });
  });
  it('配列は中身を 1 つに畳み、型が変われば形が変わる', () => {
    const a = shapeOfRollout([l('response_item', { type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] })]);
    expect(a['response_item/message']?.['payload.content[].text']).toBe('string');
    const b = shapeOfRollout([l('response_item', { type: 'message', content: [{ type: 'output_text', text: 1 }] })]);
    expect(diffJson(a, b)).not.toEqual([]);
  });
  it('hangar が読み捨てる world_state は見ない', () => {
    expect(shapeOfRollout([l('world_state', { full: true })])).toEqual({});
  });
});

describe('parseCodexHelp', () => {
  const text = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]

Commands:
  exec              Run Codex non-interactively [aliases: e]
  apply             Apply the latest diff produced by Codex agent as a \`git apply\` to your local
                    working tree [aliases: a]
  resume            Resume a previous interactive session
  help              Print this message

Arguments:
  [PROMPT]
          Optional user prompt
`;
  it('Commands の名前と別名を読む。続きの行は数えない', () => {
    expect(parseCodexHelp(text)).toEqual({ commands: ['apply', 'exec', 'help', 'resume'], aliases: ['a', 'e'] });
  });
  it('Commands が無ければ null', () => {
    expect(parseCodexHelp('nothing')).toBeNull();
  });
});

describe('builtinSubcommandDrifts', () => {
  const help = { commands: ['exec', 'fork', 'resume'], aliases: ['e'] };
  it('resume 以外の名前と別名がそろっていれば空', () => {
    expect(builtinSubcommandDrifts(help, ['e', 'exec', 'fork'])).toEqual([]);
  });
  it('増えたものと消えたものを分けて出す', () => {
    const d = builtinSubcommandDrifts(help, ['exec', 'gone']);
    expect(d).toEqual(['in codex --help but not in the intercept list: e', 'in codex --help but not in the intercept list: fork', 'in the intercept list but not in codex --help: gone']);
  });
});

describe('helpDrifts（機種によるサブコマンドを許す）', () => {
  const sample = { commands: ['app', 'exec', 'resume'], aliases: ['e'] };
  it('Linux の help に app が無くても、見本と同じとみなす', () => {
    expect(helpDrifts({ commands: ['exec', 'resume'], aliases: ['e'] }, sample)).toEqual([]);
  });
  it('app があっても同じ', () => {
    expect(helpDrifts(sample, sample)).toEqual([]);
  });
  it('見本に無いサブコマンドが増えたら落とす（機種によるものの名でも、見本に無ければ別）', () => {
    expect(helpDrifts({ commands: ['exec', 'resume', 'newcmd'], aliases: ['e'] }, sample)).toEqual(['in codex --help but not in the sample: newcmd']);
    expect(helpDrifts({ commands: ['app', 'exec', 'resume'], aliases: ['e', 'x'] }, { commands: ['exec', 'resume'], aliases: ['e'] })).toEqual(['in codex --help but not in the sample: app', 'in codex --help but not in the sample: x']);
  });
  it('見本にある普通のサブコマンドが消えたら落とす', () => {
    expect(helpDrifts({ commands: ['app', 'exec'], aliases: ['e'] }, sample)).toEqual(['in the sample but not in codex --help: resume']);
  });
  it('横取りの一覧に app があっても、help に無いだけでは落とさない', () => {
    expect(builtinSubcommandDrifts({ commands: ['exec', 'resume'], aliases: ['e'] }, ['app', 'e', 'exec'])).toEqual([]);
  });
});

describe('rollout の置かれ方の見張り（compat/storage.ts）', () => {
  const list = [
    'agent_message_board                      under development  false',
    'local_thread_store_compression           under development  false',
    'enable_request_compression               stable             true',
    'local_thread_store_shared_compression    removed            false',
    '壊れた行',
  ].join('\n');

  it('features list の行を、名前、段階、真偽に読む', () => {
    const f = parseFeatureList(list);
    expect(f.local_thread_store_compression).toEqual({ stage: 'under development', enabled: false });
    expect(f.enable_request_compression).toEqual({ stage: 'stable', enabled: true });
    expect(Object.keys(f)).toHaveLength(4);
  });

  it('圧縮の既定か段階が変わる、機能が消えると知らせる', () => {
    const want = { stage: 'under development', enabled: false };
    expect(compressionDrifts(want, want)).toEqual([]);
    expect(compressionDrifts(want, { stage: 'stable', enabled: true })).toHaveLength(2);
    expect(compressionDrifts(want, { stage: 'experimental', enabled: false })).toHaveLength(1);
    expect(compressionDrifts(want, undefined)[0]).toContain('is gone');
  });

  it('追記だけなら差は無く、書き換え、縮み、伸びないは知らせる', () => {
    const a = Buffer.from('{"a":1}\n{"b":2}\n');
    expect(appendOnlyDrifts(a, Buffer.concat([a, Buffer.from('{"c":3}\n')]))).toEqual([]);
    expect(appendOnlyDrifts(a, Buffer.from('{"a":9}\n{"b":2}\n{"c":3}\n'))[0]).toContain('rewritten');
    expect(appendOnlyDrifts(a, a.subarray(0, 5))[0]).toContain('shrank');
    expect(appendOnlyDrifts(a, a)[0]).toContain('did not grow');
  });
});
