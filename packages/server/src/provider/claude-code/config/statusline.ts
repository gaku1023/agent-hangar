import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatuslineStatusDto } from '@agent-hangar/shared';
import { readUtf8Text } from '../../../config/textEncoding.ts';
import { hasMode } from '../../../platform/secure.ts';

// statusline スクリプトへの追記は、hangar が ~/.claude 配下に書く唯一の操作である。
// ここでは読み取りと、承認を得た後に呼ばれる追記だけを提供し、問いかけは CLI が担う。

export const STATUSLINE_MARKER = '# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。';

/**
 * PowerShell の形の目印。ASCII だけで書く。
 * Windows PowerShell 5.1 は BOM の無い .ps1 を ANSI のコードページ（日本語なら CP932）で読む。
 * UTF-8 の日本語は 2 バイトの区切りをずらして改行をまたぎ、次の行まで 1 つのコメントにしてしまう。
 * BOM を足して直すと、CP932 で書かれた利用者のスクリプトのほうが壊れるので、目印の側を ASCII にする。
 */
export const PS_STATUSLINE_MARKER = '# agent-hangar: forward usage to local server; errors ignored.';

/** 入っているスニペットの目印として認めるもの。0.6.1 までの .ps1 は日本語の目印で入っている。 */
const MARKERS = [STATUSLINE_MARKER, PS_STATUSLINE_MARKER];

/** スクリプトの中身に hangar のスニペットが入っているか。目印の行で見る（古い形の目印も含む）。 */
export function hasStatuslineMarker(text: string): boolean {
  return text.split(/\r?\n/).some((l) => MARKERS.includes(l));
}

/** スニペットの終わりの行。目印と合わせて、入っているスニペットの範囲を決める。 */
const SNIPPET_END = 'exec <<<"$__hangar_input"';

/** スニペットが curl に読ませるヘッダのファイル。トークンそのものではなく、ヘッダ 1 行が入る。 */
export const STATUSLINE_HEADER_FILE = 'statusline-header';

export function statuslineHeaderPath(home: string): string {
  return path.join(home, STATUSLINE_HEADER_FILE);
}

/**
 * curl に読ませる `Authorization: Bearer <トークン>` の 1 行を置く。
 *
 * token とは別のファイルにする。`-H @<ファイル>` はファイルの中身をヘッダの行として読むので、
 * 64 桁だけが入った token をそのまま渡すことはできない。
 * token を唯一の出どころのままにして、ここはそこから作る控えとして扱う。
 * 中身はトークンと同じ重さなので 0600 で置き、既にあるファイルの権限も 0600 に直す。
 */
export function writeStatuslineHeaderFile(home: string, token: string): string {
  const file = statuslineHeaderPath(home);
  fs.writeFileSync(file, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * ヘッダのファイルが無いか、トークンと食い違うか、他人に読める権限なら置き直す。
 *
 * サーバの起動のたびに呼ぶ。
 * 置き場ごと消した利用者は、statusline install をやり直すまでヘッダのファイルを持たない。
 * スニペットは読めなければ何も送らずに素通しするので、使用量が静かに止まり、利用者には何も見えない。
 * トークンと同じところで用意すれば、トークンが作り直されたときも次の起動で揃う。
 *
 * 中身も権限も合っているときは触らない。
 * 毎回書き直すと mtime だけが動き、ファイルを見張っている道具に無駄な知らせが出る。
 */
export function ensureStatuslineHeaderFile(home: string, token: string): string {
  const file = statuslineHeaderPath(home);
  try {
    const ok = fs.readFileSync(file, 'utf8') === `Authorization: Bearer ${token}\n` && hasMode(file, 0o600);
    if (ok) return file;
  } catch {
    // 無い、または読めない。下で置き直す。
  }
  return writeStatuslineHeaderFile(home, token);
}

/**
 * 設計文書のスニペット。
 * 標準入力を読んでサーバへ背景で送り、同じ内容を元のスクリプトの標準入力に戻す。
 * ヘッダのファイルは HANGAR_HOME があればそこから読む。
 * 既定は従来どおり ~/.agent-hangar である。
 *
 * トークンは curl の argv に載せない。
 * `-H "Authorization: Bearer $(cat ...)"` と書くとシェルが先に展開するので、
 * 64 桁が curl の argv に載り、statusline が走るたびに ps から読める。
 * `-H @<ファイル>` は中身をヘッダの行として読むので、argv にはファイルの名前しか出ない。
 * この書き方は curl 7.55 以降にある（手元の 8.7.1 で実測した）。
 * --variable と --expand-header でも隠せるが、そちらは curl 8.3 以降にしか無く、
 * 古い curl では要求を出す前に終わるうえ、失敗が >/dev/null 2>&1 に消えて利用者に何も見えない。
 *
 * ヘッダのファイルが無いか読めないときは、何も送らずに素通しする。
 * hangar の都合で利用者の statusline の表示を壊さないためである。
 */
export function statuslineSnippet(port: number): string {
  return [
    STATUSLINE_MARKER,
    '__hangar_input=$(cat)',
    '__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"',
    `__hangar_header="$__hangar_home/${STATUSLINE_HEADER_FILE}"`,
    'if [ -r "$__hangar_header" ]; then',
    `  printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \\`,
    `    -H 'Content-Type: application/json' \\`,
    '    -H @"$__hangar_header" \\',
    `    --data-binary @- http://127.0.0.1:${port}/api/ingest/statusline >/dev/null 2>&1 &`,
    'fi',
    SNIPPET_END,
    '',
  ].join('\n');
}

/**
 * command を語に分ける。空白で区切り、二重引用符と一重引用符の中の空白では区切らない。引用符は外す。
 * 逆斜線は Windows のパスの区切りなので、そのまま残す（エスケープとしては読まない）。
 */
function splitWords(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (/\s/.test(ch)) {
      if (inWord) { words.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (inWord) words.push(cur);
  return words;
}

/** 実行するものの名前。区切り（/ と \）の後ろを取り、小文字にして .exe を外す（"C:\…\pwsh.exe" → pwsh）。 */
const programName = (w: string) => (w.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');

/**
 * command の中でスクリプトを指す語。
 * bash、sh、zsh の後ろの語、pwsh や powershell の -File の後ろの語、それ以外は先頭の語である。
 * 実行するものは、絶対パスや引用符つきで書かれていても名前で見分ける（/bin/bash、"C:\Program Files\…\pwsh.exe"）。
 */
function scriptWord(command: string): string | undefined {
  const words = splitWords(command);
  const head = programName(words[0] ?? '');
  if (['bash', 'sh', 'zsh'].includes(head)) return words[1];
  if (head === 'pwsh' || head === 'powershell') {
    const i = words.findIndex((w, n) => n > 0 && /^-(f|file)$/i.test(w));
    return i === -1 ? undefined : words[i + 1];
  }
  return words[0];
}

/**
 * パスの語の、~、$HOME、${HOME}、$NAME、${NAME}、%NAME% を展開する。
 * ~ と HOME は homeDir、ほかは env から引く（Windows の env は名前の大文字小文字を区別しない）。
 * 展開できない変数が 1 つでもあれば null を返し、呼び手は読めない扱いにする（推して別のファイルを指さないため）。
 */
function expandPath(word: string, homeDir: string, env: NodeJS.ProcessEnv): string | null {
  let missing = false;
  const look = (name: string): string => {
    if (name === 'HOME') return homeDir;
    const key = process.platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase()) : name;
    const v = key === undefined ? undefined : env[key];
    if (v === undefined || v === '') { missing = true; return ''; }
    return v;
  };
  let out = word === '~' ? homeDir : word.startsWith('~/') || word.startsWith('~\\') ? path.join(homeDir, word.slice(2)) : word;
  out = out
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (_m, n: string) => look(n))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n: string) => look(n))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, n: string) => look(n));
  return missing ? null : out;
}

/**
 * ~/.claude/settings.json の statusLine.command を読み、スクリプトを指す語がファイルならその絶対パスを返す。
 * env は %NAME% と $NAME の展開に使う（試験は差し替える）。
 */
export function resolveStatuslineScript(claudeDir: string, homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): { command: string | null; scriptPath: string | null } {
  const file = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(file)) return { command: null, scriptPath: null };
  let command: string | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine?: { command?: unknown } };
    command = typeof j.statusLine?.command === 'string' && j.statusLine.command.trim() ? j.statusLine.command.trim() : null;
  } catch {
    return { command: null, scriptPath: null };
  }
  if (!command) return { command: null, scriptPath: null };
  const first = scriptWord(command);
  if (!first) return { command, scriptPath: null };
  const expanded = expandPath(first, homeDir, env);
  if (expanded === null) return { command, scriptPath: null };
  const candidate = path.resolve(expanded);
  const ok = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  return { command, scriptPath: ok ? candidate : null };
}

export function statuslineStatus(claudeDir: string, homeDir: string = os.homedir()): StatuslineStatusDto {
  const r = resolveStatuslineScript(claudeDir, homeDir);
  const installed = r.scriptPath !== null && hasStatuslineMarker(fs.readFileSync(r.scriptPath, 'utf8'));
  return { command: r.command, scriptPath: r.scriptPath, installed };
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/** PowerShell のスニペットの終わりの行。読んだ標準入力を、元のスクリプトが [Console]::In で読めるように戻す。 */
const PS_SNIPPET_END = '[Console]::SetIn([System.IO.StringReader]::new($__hangar_input))';

/** スクリプトが PowerShell か。拡張子で決める。 */
export function isPowerShellScript(scriptPath: string): boolean {
  return /\.ps1$/i.test(scriptPath);
}

/**
 * PowerShell のスクリプト（Windows の .ps1）に入れるスニペット。bash の形と同じことをする。
 * 標準入力を読み、ヘッダのファイルが読めるときだけ、短い時間（0.3 秒）を区切ってサーバへ送る。失敗は黙る。
 * 送り終えたら、読んだ内容を [Console]::SetIn で標準入力に戻す。元のスクリプトは [Console]::In.ReadToEnd() で同じ内容を読める。
 * 全体を ASCII だけで書く（PS_STATUSLINE_MARKER）。
 * 標準入力はバイトのまま読んで UTF-8 で解釈する。5.1 の [Console]::In はコンソールのコードページで読むので、
 * session_name などの日本語が化けて届く。
 * バイトで読み切った後は、元のスクリプトが [Console]::OpenStandardInput() で読んでも 0 バイトしか残らない。
 * そのため OpenStandardInput で読むスクリプトには自動では入れない（powershellBlock の ps-input）。
 * トークンはどのプロセスの引数にも載せない（同じプロセスの中で、ヘッダのファイルから読む）。
 * PowerShell には裏で送る軽い道が無い（Start-Job は別のプロセスを起こして 1 秒近くかかる）ので、送るのは待つ。宛先は同じ PC なので短い。
 */
export function powershellStatuslineSnippet(port: number): string {
  return [
    PS_STATUSLINE_MARKER,
    '$__hangar_buf = [System.IO.MemoryStream]::new()',
    '[Console]::OpenStandardInput().CopyTo($__hangar_buf)',
    '$__hangar_input = [System.Text.Encoding]::UTF8.GetString($__hangar_buf.ToArray())',
    "$__hangar_home = if ($env:HANGAR_HOME) { $env:HANGAR_HOME } else { Join-Path $HOME '.agent-hangar' }",
    `$__hangar_header = Join-Path $__hangar_home '${STATUSLINE_HEADER_FILE}'`,
    'if (Test-Path -LiteralPath $__hangar_header) {',
    '  try {',
    '    Add-Type -AssemblyName System.Net.Http',
    "    $__hangar_auth = ((Get-Content -LiteralPath $__hangar_header -Raw) -replace '^Authorization:\\s*', '').Trim()",
    `    $__hangar_req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, 'http://127.0.0.1:${port}/api/ingest/statusline')`,
    "    $null = $__hangar_req.Headers.TryAddWithoutValidation('Authorization', $__hangar_auth)",
    "    $__hangar_req.Content = [System.Net.Http.StringContent]::new($__hangar_input, [System.Text.Encoding]::UTF8, 'application/json')",
    '    $__hangar_http = [System.Net.Http.HttpClient]::new()',
    '    $null = $__hangar_http.SendAsync($__hangar_req).Wait(300)',
    '  } catch {}',
    '}',
    PS_SNIPPET_END,
    '',
  ].join('\n');
}

/** スクリプトの種類に合うスニペット。.ps1 は PowerShell の形、ほかは bash の形である。 */
export function statuslineSnippetFor(scriptPath: string, port: number): string {
  return isPowerShellScript(scriptPath) ? powershellStatuslineSnippet(port) : statuslineSnippet(port);
}

/** UTF-8 の BOM。 */
const BOM = '\uFEFF';

/** 行に分ける。改行の形（CRLF か LF）は eol に覚え、行の中に \r を残さない。 */
function splitLines(src: string): { lines: string[]; eol: string } {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  return { lines: src.split(/\r?\n/), eol };
}

/**
 * 入っているスニペットの行の範囲。目印の行から終わりの行（bash か PowerShell）までを見る。
 * 手で書き換えられていて終わりの行が見つからないときは null を返し、呼び手は何もしない。
 */
function snippetRange(lines: string[]): { from: number; to: number } | null {
  const from = lines.findIndex((l) => MARKERS.includes(l));
  if (from === -1) return null;
  const limit = Math.min(lines.length, from + 24);
  for (let i = from + 1; i < limit; i++) if (lines[i] === SNIPPET_END || lines[i] === PS_SNIPPET_END) return { from, to: i };
  return null;
}

/** スニペットの行（末尾の空の要素を除く）を、ファイルの改行の形でつなぐ。 */
const snippetLines = (scriptPath: string, port: number) => statuslineSnippetFor(scriptPath, port).split('\n').slice(0, -1);

/** 入っているスニペットが今の形かどうか。目印が無ければ偽。 */
export function statuslineSnippetUpToDate(scriptPath: string, port: number): boolean {
  return planStatuslineSnippet(fs.readFileSync(scriptPath, 'utf8'), scriptPath, port).kind === 'same';
}

/**
 * PowerShell のスクリプトの先頭に、自動で入れてよいか。
 * param の塊は最初の文でなければならないので、その前には入れられない（ps-param）。
 * $input で標準入力を読むスクリプトは、[Console]::SetIn で戻した内容を読めないことがある（ps-input）。
 * [Console]::OpenStandardInput() で読むスクリプトは、スニペットが読み切った後なので 0 バイトしか読めない（これも ps-input）。
 * src には hangar のスニペットを含めない（スニペット自身が OpenStandardInput を使う）。
 * どちらも、何も書かずに断り、手で入れる道を案内する。
 */
function powershellBlock(src: string): 'ps-param' | 'ps-input' | null {
  const body = src.replace(/^﻿/, '').replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const head = (body[0] ?? '').toLowerCase();
  if (/^param\s*\(/.test(head) || /^\[cmdletbinding/.test(head)) return 'ps-param';
  if (/\$input\b|OpenStandardInput/i.test(src)) return 'ps-input';
  return null;
}

/**
 * 書く中身だけを決める。書かない。
 * add は新しく入れる、replace は古い形を今の形に差し替える、same は今の形が入っている、
 * unreadable は目印はあるが範囲を読み取れない（手で書き換えられている）、ps-param と ps-input は PowerShell で自動では入れられないもの。
 * bash の形は shebang の直後（無ければ先頭）、PowerShell の形は先頭に入れる。改行の形はファイルに合わせる。
 */
export type StatuslineEdit = { kind: 'add' | 'replace'; next: string } | { kind: 'same' | 'unreadable' | 'ps-param' | 'ps-input' };
export function planStatuslineSnippet(full: string, scriptPath: string, port: number): StatuslineEdit {
  // UTF-8 の BOM は先頭に保つ。外してから決め、足した中身の先頭に戻す（BOM の付いた行では目印も shebang も見つからない）。
  const bom = full.startsWith(BOM) ? BOM : '';
  const src = full.slice(bom.length);
  const r = planWithoutBom(src, scriptPath, port);
  return r.kind === 'add' || r.kind === 'replace' ? { kind: r.kind, next: `${bom}${r.next}` } : r;
}

function planWithoutBom(src: string, scriptPath: string, port: number): StatuslineEdit {
  const { lines, eol } = splitLines(src);
  const want = snippetLines(scriptPath, port);
  if (lines.some((l) => MARKERS.includes(l))) {
    const range = snippetRange(lines);
    if (!range) return { kind: 'unreadable' };
    const cur = lines.slice(range.from, range.to + 1);
    if (cur.length === want.length && cur.every((l, i) => l === want[i])) return { kind: 'same' };
    // 今の形はバイトで読み切るので、元のスクリプトが OpenStandardInput で読むなら差し替えると表示が空になる。
    if (isPowerShellScript(scriptPath)) {
      const rest = [...lines.slice(0, range.from), ...lines.slice(range.to + 1)].join(eol);
      if (powershellBlock(rest) === 'ps-input') return { kind: 'ps-input' };
    }
    return { kind: 'replace', next: [...lines.slice(0, range.from), ...want, ...lines.slice(range.to + 1)].join(eol) };
  }
  if (isPowerShellScript(scriptPath)) {
    const block = powershellBlock(src);
    if (block) return { kind: block };
    return { kind: 'add', next: `${want.join(eol)}${eol}${src}` };
  }
  const snippet = want.join(eol) + eol;
  const nl = src.indexOf('\n');
  // shebang の行だけで改行が無いときは、行を閉じてからスニペットを足す。
  const hasShebang = src.startsWith('#!');
  const head = hasShebang ? (nl === -1 ? `${src}${eol}` : src.slice(0, nl + 1)) : '';
  const rest = hasShebang ? (nl === -1 ? '' : src.slice(nl + 1)) : src;
  return { kind: 'add', next: head + snippet + rest };
}

/** 外す中身だけを決める。remove は目印から終わりの行までを除いたもの、absent は入っていない、unreadable は範囲を読み取れない。 */
export type StatuslineRemoval = { kind: 'remove'; next: string } | { kind: 'absent' | 'unreadable' };
export function planStatuslineRemoval(full: string): StatuslineRemoval {
  const bom = full.startsWith(BOM) ? BOM : '';
  const { lines, eol } = splitLines(full.slice(bom.length));
  if (!lines.some((l) => MARKERS.includes(l))) return { kind: 'absent' };
  const range = snippetRange(lines);
  if (!range) return { kind: 'unreadable' };
  return { kind: 'remove', next: bom + [...lines.slice(0, range.from), ...lines.slice(range.to + 1)].join(eol) };
}

/** バックアップを取ってから、決めた中身を書く。実行権限は保つ。 */
function writeWithBackup(scriptPath: string, next: string, now: Date): string {
  const backup = `${scriptPath}.bak-${stamp(now)}`;
  fs.copyFileSync(scriptPath, backup);
  const mode = fs.statSync(scriptPath).mode;
  fs.writeFileSync(scriptPath, next, { mode });
  return backup;
}

/**
 * バックアップを取ってから、shebang の直後（無ければ先頭）にスニペットを入れる。
 * 既に入っていて今の形と違えば、その範囲だけを差し替える。
 * 目印だけを見て何もしないと、トークンを argv に載せる古い形が残り続けるためである。
 * 書く中身は planStatuslineSnippet が決める（承認の窓で見せる差分と同じもの）。
 */
export function appendStatuslineSnippet(scriptPath: string, port: number, now: Date = new Date()): { changed: boolean; backup: string | null } {
  // UTF-8 でないスクリプト（UTF-16 など）は、UTF-8 で書き戻すと壊れるので触らない（config/textEncoding.ts）。
  const read = readUtf8Text(scriptPath);
  if (read === null || 'problem' in read) return { changed: false, backup: null };
  const plan = planStatuslineSnippet(read.text, scriptPath, port);
  if (plan.kind !== 'add' && plan.kind !== 'replace') return { changed: false, backup: null };
  return { changed: true, backup: writeWithBackup(scriptPath, plan.next, now) };
}

/** 入っているスニペットを外す。バックアップを取ってから書く。入っていないか、範囲を読み取れなければ触らない。 */
export function removeStatuslineSnippet(scriptPath: string, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const read = readUtf8Text(scriptPath);
  if (read === null || 'problem' in read) return { changed: false, backup: null };
  const plan = planStatuslineRemoval(read.text);
  if (plan.kind !== 'remove') return { changed: false, backup: null };
  return { changed: true, backup: writeWithBackup(scriptPath, plan.next, now) };
}
