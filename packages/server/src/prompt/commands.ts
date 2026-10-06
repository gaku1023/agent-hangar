import fs from 'node:fs';
import path from 'node:path';
import type { PromptCommandDto, PromptCommandSource } from '@agent-hangar/shared';
import { parseFrontmatter } from './frontmatter.ts';
import { firstPromptUses } from './history.ts';

/**
 * 組み込みのうち、最初の一言になるもの。ファイルから読めないので手で持つ。
 * 会話の途中でしか意味がないもの（compact、clear、copy など）、端末の設定のもの（login、mcp など）、
 * ダイアログの詳細に欄がある model と effort は入れない（docs/superpowers/specs/2026-10-06-prompt-composer-design.md）。
 */
const BUILTIN: { name: string; description: string; argumentHint: string | null }[] = [
  { name: 'init', description: 'CLAUDE.md を作ってコードベースを説明させる', argumentHint: null },
  { name: 'review', description: 'プルリクエストを審査する', argumentHint: '[PR 番号]' },
  { name: 'code-review', description: 'いまの差分の誤りを探す', argumentHint: '[low|medium|high]' },
  { name: 'security-review', description: 'ブランチの変更の安全性を審査する', argumentHint: null },
  { name: 'loop', description: '指示を一定の間隔で繰り返す', argumentHint: '[間隔] <指示>' },
  { name: 'schedule', description: '決まった時刻に動くクラウドのエージェントを作る', argumentHint: null },
];

type Found = Omit<PromptCommandDto, 'uses'>;

const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file: string): unknown => { const t = readText(file); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
const entries = (dir: string): fs.Dirent[] => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
// リンクの先がフォルダかどうかは Dirent では分からないので、stat で見る（~/.claude/skills の下はリンクのことがある）。
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** 1 つの文書を候補にする。読めなければ null。説明は 1 行目だけにする。 */
function fromDoc(file: string, fallbackName: string, source: PromptCommandSource, prefix: string, nameFromFile: boolean): Found | null {
  const text = readText(file);
  if (text === null) return null;
  const fm = parseFrontmatter(text);
  if (fm['user-invocable'] === 'false') return null;
  const base = nameFromFile ? fallbackName : fm.name || fallbackName;
  return { name: prefix + base, description: (fm.description ?? '').split('\n')[0]!.trim(), argumentHint: fm['argument-hint'] || null, source };
}

function skillsIn(dir: string, source: PromptCommandSource, prefix = ''): Found[] {
  const out: Found[] = [];
  for (const e of entries(dir)) {
    const p = path.join(dir, e.name);
    if (!isDir(p)) continue;
    const c = fromDoc(path.join(p, 'SKILL.md'), e.name, source, prefix, false);
    if (c) out.push(c);
  }
  return out;
}

/** コマンドはファイルの名前がそのまま名前になる。フォルダに入ったものは、区切りをコロンにする。 */
function commandsIn(dir: string, source: PromptCommandSource, prefix = '', depth = 0): Found[] {
  const out: Found[] = [];
  if (depth > 4) return out;
  for (const e of entries(dir)) {
    const p = path.join(dir, e.name);
    if (isDir(p)) { out.push(...commandsIn(p, source, `${prefix}${e.name}:`, depth + 1)); continue; }
    if (!e.name.endsWith('.md')) continue;
    const c = fromDoc(p, e.name.slice(0, -3), source, prefix, true);
    if (c) out.push(c);
  }
  return out;
}

/** 有効なプラグインの置き場。enabledPlugins があれば true のものだけ、無ければ入っているもの全部。 */
function pluginRoots(claudeDir: string): { plugin: string; root: string }[] {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, { installPath?: unknown }[]> } | null;
  const settings = readJson(path.join(claudeDir, 'settings.json')) as { enabledPlugins?: Record<string, unknown> } | null;
  const enabled = settings?.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : null;
  const out: { plugin: string; root: string }[] = [];
  if (!installed?.plugins || typeof installed.plugins !== 'object') return out;
  for (const [key, list] of Object.entries(installed.plugins)) {
    if (enabled && enabled[key] !== true) continue;
    const last = Array.isArray(list) ? list[list.length - 1] : null;
    if (typeof last?.installPath === 'string') out.push({ plugin: key.split('@')[0]!, root: last.installPath });
  }
  return out;
}

/**
 * 初期プロンプト欄の `/` の候補。読むだけで、何も書かない。
 * 同じ名前は、プロジェクト、自分の、プラグイン、組み込みの順で先のものを残す。
 */
export function listPromptCommands(o: { claudeDir: string; projectPath: string | null }): PromptCommandDto[] {
  const found: Found[] = [];
  if (o.projectPath) {
    const root = path.join(o.projectPath, '.claude');
    found.push(...skillsIn(path.join(root, 'skills'), 'project'), ...commandsIn(path.join(root, 'commands'), 'project'));
  }
  found.push(...skillsIn(path.join(o.claudeDir, 'skills'), 'user'), ...commandsIn(path.join(o.claudeDir, 'commands'), 'user'));
  for (const { plugin, root } of pluginRoots(o.claudeDir)) {
    found.push(...skillsIn(path.join(root, 'skills'), 'plugin', `${plugin}:`), ...commandsIn(path.join(root, 'commands'), 'plugin', `${plugin}:`));
  }
  found.push(...BUILTIN.map((b) => ({ ...b, source: 'builtin' as const })));
  const uses = firstPromptUses(path.join(o.claudeDir, 'history.jsonl'));
  const seen = new Set<string>();
  const out: PromptCommandDto[] = [];
  for (const c of found) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ ...c, uses: uses.get(c.name) ?? 0 });
  }
  return out;
}
