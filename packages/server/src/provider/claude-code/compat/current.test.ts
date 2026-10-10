import { describe, expect, it } from 'vitest';
import { LINKED_ENTRIES } from '../config/accountLinks.ts';
import { KNOWN_PER_ACCOUNT_ENTRIES } from './claudeDir.ts';
import { agentsJsonDrifts, authStatusDrifts, BUILTIN_SUBCOMMANDS, KNOWN_AGENT_KINDS, printJsonDrifts, subcommandsFromHelp } from './cli.ts';
import { isCurrentDrift } from './current.ts';
import { KNOWN_REGISTRY_STATUSES, registryDrifts } from './registry.ts';
import { screenDrift } from './screen.ts';
import { statuslineDrifts } from './statusline.ts';
import { KNOWN_ASSISTANT_BLOCKS, KNOWN_LINE_TYPES, KNOWN_META_TYPES, KNOWN_SYSTEM_SUBTYPES, KNOWN_USER_BLOCKS, READ_ATTACHMENT_TYPE, transcriptDrifts } from './transcript.ts';
import type { Drift } from './types.ts';

// 記録は手元の claude の版が変わるまで残る。そのあいだに hangar が知っている集合を広げると、
// 前の hangar が記録した値が、今の hangar から見ればずれでないのに残り続ける。
// isCurrentDrift は、記録の契約と値だけで「今の hangar でもずれか」を答える。

const still = (d: Pick<Drift, 'contract' | 'value'>) => isCurrentDrift(d.contract, d.value);

describe('isCurrentDrift', () => {
  it('トランスクリプト：今の集合で知っている行、system の種類、本文の塊はずれでない', () => {
    for (const v of [...KNOWN_LINE_TYPES, ...KNOWN_META_TYPES]) expect(isCurrentDrift('transcript', `type=${v}`), v).toBe(false);
    for (const v of KNOWN_SYSTEM_SUBTYPES) expect(isCurrentDrift('transcript', `system.subtype=${v}`), v).toBe(false);
    for (const v of KNOWN_USER_BLOCKS) expect(isCurrentDrift('transcript', `user.content=${v}`), v).toBe(false);
    for (const v of KNOWN_ASSISTANT_BLOCKS) expect(isCurrentDrift('transcript', `assistant.content=${v}`), v).toBe(false);
    expect(isCurrentDrift('transcript', `attachment.type=${READ_ATTACHMENT_TYPE}`)).toBe(false);
    // 見本の PR で meta に足した値。前の hangar の記録に残っていた。
    expect(isCurrentDrift('transcript', 'type=isolation-latch')).toBe(false);
  });
  it('トランスクリプト：知らない値と欠けはずれのまま', () => {
    for (const v of ['type=brand-new', 'type=(missing)', 'system.subtype=turn_end', 'system.subtype=(missing)', 'attachment.type=queued_prompt',
      'attachment.type=(missing)', 'user.content=audio', 'assistant.content=server_tool_use', 'assistant.content=(missing)']) {
      expect(isCurrentDrift('transcript', v), v).toBe(true);
    }
  });
  it('レジストリ：知っている status はずれでなく、知らない status と欠けはずれのまま', () => {
    for (const s of KNOWN_REGISTRY_STATUSES) expect(isCurrentDrift('registry', `status=${s}`), s).toBe(false);
    for (const v of ['status=thinking', 'status=(missing)', 'sessionId=(missing)', 'pid=(missing)', 'entry=(not-object)']) expect(isCurrentDrift('registry', v), v).toBe(true);
  });
  it('~/.claude の項目：共有のリンクとアカウントごとに持つと知っている項目と見ない名前はずれでなく、ほかはずれのまま', () => {
    for (const n of [...LINKED_ENTRIES, ...KNOWN_PER_ACCOUNT_ENTRIES, '.DS_Store']) expect(isCurrentDrift('claude-dir', `entry=${n}`), n).toBe(false);
    expect(isCurrentDrift('claude-dir', 'entry=zeta-new')).toBe(true);
  });
  it('CLI：組み込みの一覧に入ったサブコマンドの増と、外れたサブコマンドの減はずれでない', () => {
    for (const s of BUILTIN_SUBCOMMANDS) {
      expect(isCurrentDrift('cli', `subcommand.added=${s}`), s).toBe(false);
      expect(isCurrentDrift('cli', `subcommand.removed=${s}`), s).toBe(true);
    }
    // 2.1.292 の --help に無かった名前。組み込みから外したので、減ったと記録された値はもうずれでない。
    expect(isCurrentDrift('cli', 'subcommand.removed=daemon')).toBe(false);
    expect(isCurrentDrift('cli', 'subcommand.added=brand-new')).toBe(true);
    for (const k of KNOWN_AGENT_KINDS) expect(isCurrentDrift('cli', `agents-json.kind=${k}`), k).toBe(false);
    for (const v of ['agents-json.kind=remote', 'agents-json.kind=(missing)', 'agents-json.id=(missing)', 'help.commands=(missing)', 'auth-status=(not-json)',
      'auth-status.loggedIn=(missing)', 'print-json.structured_output=(missing)']) expect(isCurrentDrift('cli', v), v).toBe(true);
  });
  it('値だけでは決められない契約（statusline、画面の文字）と、知らない形の値は残す', () => {
    for (const v of ['rate_limits.five_hour.resets_at=ms', 'cost.total_cost_usd=(missing)', 'session_id=(missing)']) expect(isCurrentDrift('statusline', v), v).toBe(true);
    for (const v of ['transcript-footer=(missing)', 'prompt-marker=(missing)']) expect(isCurrentDrift('screen', v), v).toBe(true);
    for (const c of ['transcript', 'registry', 'claude-dir', 'cli'] as const) {
      expect(isCurrentDrift(c, 'no-equals-sign'), c).toBe(true);
      expect(isCurrentDrift(c, 'some.future.key=busy'), c).toBe(true);
    }
  });
  it('今の見張りが出すずれは、どれも今もずれと判定する（見張りと判定が食い違わない）', () => {
    const produced: Drift[] = [
      ...transcriptDrifts({ type: 'brand-new' }),
      ...transcriptDrifts({ sessionId: 'x' }),
      ...transcriptDrifts({ type: 'system', subtype: 'turn_end' }),
      ...transcriptDrifts({ type: 'system' }),
      ...transcriptDrifts({ type: 'attachment', attachment: { type: 'queued_prompt', prompt: 'x' } }),
      ...transcriptDrifts({ type: 'attachment' }),
      ...transcriptDrifts({ type: 'assistant', message: { content: [{ type: 'server_tool_use' }, 'loose'] } }),
      ...transcriptDrifts({ type: 'user', message: { content: [{ type: 'audio' }] } }),
      ...registryDrifts({ status: 'thinking' }),
      ...registryDrifts([]),
      ...subcommandsFromHelp('Usage: claude\n\nCommands:\n  brand-new   x\n').drifts,
      ...subcommandsFromHelp('no commands here').drifts,
      ...authStatusDrifts('x'), ...authStatusDrifts('[]'), ...authStatusDrifts('{}'),
      ...agentsJsonDrifts('x'), ...agentsJsonDrifts('{}'), ...agentsJsonDrifts('[1, {"kind": "remote"}, {}]'),
      ...printJsonDrifts('x'), ...printJsonDrifts('[]'), ...printJsonDrifts('{}'),
      ...statuslineDrifts({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 2e12 } } }),
      screenDrift('footer'), screenDrift('prompt-marker'),
      { contract: 'claude-dir', value: 'entry=zeta-new', version: null },
    ];
    expect(produced.length).toBeGreaterThan(30);
    for (const d of produced) expect(still(d), `${d.contract} ${d.value}`).toBe(true);
  });
});
