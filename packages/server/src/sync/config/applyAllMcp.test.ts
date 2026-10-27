import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigApplyOrderItemDto, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../db/open.ts';
import { ApplyError, planApplyFiles, runApply, type ApplyOptions } from './apply.ts';
import { listAllBackups, runRestoreTarget } from './applyAll.ts';
import { readApplyOrder, writeApplyOrder } from './applyOrder.ts';
import { ConfigBase } from './base.ts';
import { codexTomlId } from './ids.ts';
import { writeInbox } from './inbox.ts';
import { CLAUDE_MCP_PREFIX, CODEX_MCP_PREFIX, OPENCODE_MCP_PREFIX, mcpIdOf } from './targets/mcpCommon.ts';

/** S11b：MCP の 3 対象が、適用の口（applyAll）で好みの鍵の対象と同じ 1 回の適用に入る。 */

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

let tmp: string;
let home: string;
let db: Db;
const claudeJson = (): string => path.join(tmp, 'claude.json');
const codexToml = (): string => path.join(tmp, 'codex', 'config.toml');
const ocJson = (): string => path.join(tmp, 'opencode', 'opencode.json');
const opts = (o: Partial<ApplyOptions> = {}): ApplyOptions => ({
  home, db, now: () => NOW, userHome: tmp, claudeDir: path.join(tmp, 'claude'), codexHome: path.join(tmp, 'codex'), opencodeDir: path.join(tmp, 'opencode'),
  agentsSkillsDir: path.join(tmp, 'agents', 'skills'), claudeJsonPath: claudeJson(), exists: () => true, ...o,
});
const gens = (backups: string): string[] => { try { return fs.readdirSync(path.join(home, 'backups', backups)).sort(); } catch { return []; } };
const failOf = (fn: () => unknown): ApplyError => { try { fn(); } catch (e) { if (e instanceof ApplyError) return e; throw e; } throw new Error('投げられなかった'); };

type In = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; value: unknown; target: string };
function deliver(items: In[]): void {
  const blobs = new Map<string, Buffer>();
  const manifestItems = items.map((i) => { const b = Buffer.from(JSON.stringify(i.value)); blobs.set(sha(b), b); return { id: i.id, kind: i.kind, sha256: sha(b), size: b.length, marks: [] }; });
  const targets = ['claude', 'codex', 'opencode', 'claude-mcp', 'codex-mcp', 'opencode-mcp'];
  writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: manifestItems, targets }, blobs, skipped: 0 }, { bundleSha256: sha('b'), forRowSha256: 'row', at: NOW, itemCount: manifestItems.length, skipped: 0, targets });
  const dtos: ConfigApplyOrderItemDto[] = items.map((o) => ({ id: o.id, kind: o.kind, op: o.op, take: 'remote', fromDeviceId: 'dev-b', sha256: sha(JSON.stringify(o.value)), target: o.target }));
  writeApplyOrder(home, 'dev-a', dtos, NOW);
}

const codexModel: In = { id: codexTomlId(['model']), kind: 'codex-config', op: 'overwrite', value: 'new', target: 'config.toml#model' };
const ocModel: In = { id: 'opencode:json:model', kind: 'opencode-config', op: 'overwrite', value: 'm2', target: 'opencode.json#model' };
const claudeSrv: In = { id: mcpIdOf(CLAUDE_MCP_PREFIX, 'docs'), kind: 'claude-mcp', op: 'create', value: { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] }, target: '.claude.json#mcpServers.docs' };
const codexSrv: In = { id: mcpIdOf(CODEX_MCP_PREFIX, 'docs'), kind: 'codex-mcp', op: 'create', value: { command: 'npx', args: ['-y', 'docs-mcp'] }, target: 'config.toml#mcp_servers.docs' };
const ocSrv: In = { id: mcpIdOf(OPENCODE_MCP_PREFIX, 'docs'), kind: 'opencode-mcp', op: 'create', value: { type: 'local', command: ['npx', '-y', 'docs-mcp'] }, target: 'opencode.json#mcp.docs' };
const MIXED = (): In[] => [codexModel, codexSrv, ocModel, ocSrv, claudeSrv];

const CODEX_ORIG = '# keep me\nmodel = "old"\n\n[mcp_servers.mine]\ncommand = "mine"\n';
const OC_ORIG = `${JSON.stringify({ model: 'm1', mcp: { mine: { type: 'local', command: ['mine'] } } }, null, 2)}\n`;
const CLAUDE_ORIG = `${JSON.stringify({ numStartups: 7, mcpServers: { mine: { type: 'stdio', command: 'mine', args: [] } }, projects: {} }, null, 2)}\n`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-apply-mcp-'));
  home = path.join(tmp, 'hangar');
  fs.mkdirSync(home);
  db = openDb(':memory:');
  fs.mkdirSync(path.dirname(codexToml()), { recursive: true });
  fs.mkdirSync(path.dirname(ocJson()), { recursive: true });
  fs.writeFileSync(codexToml(), CODEX_ORIG);
  fs.writeFileSync(ocJson(), OC_ORIG);
  fs.writeFileSync(claudeJson(), CLAUDE_ORIG);
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('MCP と好みの鍵が混ざった指示書', () => {
  it('同じ config.toml・opencode.json に 1 回の適用で両方書かれ、互いの鍵も手元の鍵も消えない', () => {
    deliver(MIXED());
    const files = planApplyFiles(opts());
    // 同じファイルは 1 つにまとめ、後の対象の結果まで重ねた差分を見せる。
    expect(files.files.map((f) => f.path).sort()).toEqual([claudeJson(), codexToml(), ocJson()].sort());
    const codexPlan = files.files.find((f) => f.path === codexToml())!;
    expect(codexPlan.lines.map((l) => l.text).join('\n')).toMatch(/model = "new"[\s\S]*mcp_servers\.docs/);
    expect(fs.readFileSync(codexToml(), 'utf8')).toBe(CODEX_ORIG);

    const r = runApply(opts());
    const toml = fs.readFileSync(codexToml(), 'utf8');
    expect(toml).toContain('# keep me');
    expect(toml).toContain('model = "new"');
    expect(toml).toMatch(/\[mcp_servers\.docs\]\ncommand = "npx"/);
    expect(toml).toMatch(/\[mcp_servers\.mine\]\ncommand = "mine"/);
    const oc = JSON.parse(fs.readFileSync(ocJson(), 'utf8'));
    expect(oc).toEqual({ model: 'm2', mcp: { mine: { type: 'local', command: ['mine'] }, docs: { type: 'local', command: ['npx', '-y', 'docs-mcp'] } } });
    const cj = JSON.parse(fs.readFileSync(claudeJson(), 'utf8'));
    expect(cj.numStartups).toBe(7);
    expect(cj.mcpServers.mine).toEqual({ type: 'stdio', command: 'mine', args: [] });
    expect(cj.mcpServers.docs).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] });
    expect(readApplyOrder(home)).toBeNull();
    expect(r.generations!.map((g) => g.target).sort()).toEqual(['claude-mcp', 'codex', 'codex-mcp', 'opencode', 'opencode-mcp']);
    for (const b of ['claude-mcp-config', 'codex-config', 'codex-mcp-config', 'opencode-config', 'opencode-mcp-config']) expect(gens(b)).toHaveLength(1);
    expect(listAllBackups(home).map((g) => g.target ?? 'claude').sort()).toEqual(['claude-mcp', 'codex', 'codex-mcp', 'opencode', 'opencode-mcp']);
    const base = new ConfigBase(db).all();
    for (const i of MIXED()) expect(base.get(i.id)).toBe(sha(JSON.stringify(i.value)));
  });

  it('~/.claude.json の控えを置けなければ、どの対象にも何も書かない', () => {
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'claude-mcp-config'), 'a file, not a directory');
    deliver(MIXED());
    expect(failOf(() => runApply(opts())).code).toBe('write-failed');
    expect(fs.readFileSync(claudeJson(), 'utf8')).toBe(CLAUDE_ORIG);
    expect(fs.readFileSync(codexToml(), 'utf8')).toBe(CODEX_ORIG);
    expect(fs.readFileSync(ocJson(), 'utf8')).toBe(OC_ORIG);
    expect(readApplyOrder(home)).not.toBeNull();
    expect(new ConfigBase(db).all().size).toBe(0);
  });

  it('~/.claude.json の世代から戻せる（--target claude-mcp）', () => {
    deliver([claudeSrv]);
    const r = runApply(opts());
    expect(JSON.parse(fs.readFileSync(claudeJson(), 'utf8')).mcpServers.docs).toBeDefined();
    runRestoreTarget({ ...opts(), name: r.generation!, target: 'claude-mcp' });
    expect(fs.readFileSync(claudeJson(), 'utf8')).toBe(CLAUDE_ORIG);
  });

  it('途中で書けなければ（codex-mcp の後ろで opencode.json が書き換えられた）、先に書いた対象も戻す', () => {
    deliver(MIXED());
    const e = failOf(() => runApply(opts({ onWrite: (rel) => { if (rel === 'opencode.json') throw new Error('boom'); } })));
    expect(e.code).toBe('write-failed');
    expect(fs.readFileSync(claudeJson(), 'utf8')).toBe(CLAUDE_ORIG);
    expect(fs.readFileSync(codexToml(), 'utf8')).toBe(CODEX_ORIG);
    expect(fs.readFileSync(ocJson(), 'utf8')).toBe(OC_ORIG);
    expect(readApplyOrder(home)).not.toBeNull();
    expect(new ConfigBase(db).all().size).toBe(0);
  });

  it('届いた MCP の起動コマンドがこの PC に無ければ、適用で断って何も書かない', () => {
    deliver([codexModel, { ...claudeSrv, value: { type: 'stdio', command: '/nowhere/bin/x', args: [] } }]);
    const e = failOf(() => runApply(opts({ exists: () => false })));
    expect(e.code).toBe('unsafe');
    expect(fs.readFileSync(codexToml(), 'utf8')).toBe(CODEX_ORIG);
    expect(fs.readFileSync(claudeJson(), 'utf8')).toBe(CLAUDE_ORIG);
  });
});
