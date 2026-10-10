// 起動に失敗したときの札の文。
// この頁は殻の中の静的な頁で、UI の辞書（packages/shared/src/i18n）を持たない。
// なので、失敗の札の文だけを入れた小さい日英の表をここに持つ。用語は UI の辞書と同じ用語集の語に合わせる。
// 殻は種類と数だけを渡し（lib.rs の fail_js と bootfail.rs）、文はここで作る。殻は文を書かない。

/** 札を出せる失敗の種類。bootfail.rs の KINDS と同じ並びにする（config.test.ts が突き合わせる）。 */
export const FAIL_KINDS = ['server-exited', 'port-in-use', 'db-too-old', 'db-backup-failed', 'compat-mismatch', 'other'];

/** 札の言語。packages/shared の LANGUAGES と同じ（config.test.ts が突き合わせる）。先頭が既定である。 */
export const LANGS = ['ja', 'en'];

const DEFAULT_PORT = 4177;

const text = (v, fallback = '') => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

/**
 * 命令に埋めるパスを、シェルがそのまま読める形にする。
 * 安全な文字だけならそのまま、そうでなければ単引用符で包む。~ で始まるものは、~ だけを引用の外に出す（~ は引用の中では展開されない）。
 */
export function shellQuote(s) {
  if (s === '') return "''";
  if (s.startsWith('~/')) return `~/${shellQuote(s.slice(2))}`.replace("~/''", '~/');
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** パスの最後の名前を、同じ置き場の別の名前に替える。 */
const sibling = (file, name) => {
  const i = file.lastIndexOf('/');
  return i < 0 ? name : `${file.slice(0, i + 1)}${name}`;
};

const LSOF = (port) => `lsof -nP -iTCP:${port} -sTCP:LISTEN`;

// 種類ごとの文。c は params から作った値（port、theirs、ours、found、baseline、file、dir）と、置き場の名前（home）。
const TABLE = {
  ja: {
    'server-exited': (c) => ({
      title: 'サーバを起動できませんでした',
      what: `同梱のサーバが起動の途中で終了しました。Node が見つからないか、${c.home} に書けないときに多く起きます。`,
      steps: ['「もう一度試す」を押します', '直らなければ、ログを開いて最後の数行を読みます', 'Node 22 以上が入っているか確認します', '直らないときは、ログの全文を添えて報告してください'],
      command: 'node --version',
    }),
    'port-in-use': (c) => ({
      title: `ポート ${c.port} を別のアプリが使っています`,
      what: `hangar はポート ${c.port} で動きます。別のプロセスがそのポートで待ち受けていて、hangar のサーバではありません。hangar はそのプロセスを止めません。`,
      steps: ['そのプロセスを調べて、止められるなら止めます', '「もう一度試す」を押します', '止められないときは、そのアプリを閉じてから Hangar を開き直してください'],
      command: LSOF(c.port),
      needsLsof: true,
    }),
    'compat-mismatch': (c) => (c.theirs !== null && c.ours !== null && c.theirs > c.ours
      ? {
          title: `この Hangar.app が、${c.port} で動いている hangar のサーバより古い版です`,
          what: `動いているサーバは版 ${c.theirs}、この Hangar.app は版 ${c.ours} です。そのサーバは、この Hangar.app より新しい hangar が起こしたものです。hangar はそのサーバを止めません。`,
          steps: ['Hangar.app を新しい版に入れ替えます', '入れ替えずに使うときは、そのサーバを止めてから「もう一度試す」を押します'],
          command: LSOF(c.port),
          needsLsof: true,
        }
      : {
          title: `${c.port} で動いている hangar のサーバが、この Hangar.app より古い版です`,
          what: `動いているサーバは版 ${c.theirs ?? '?'}、この Hangar.app は版 ${c.ours ?? '?'} です。hangar start や npm run dev で起こしたサーバが残っています。hangar はそのサーバを止めません。`,
          steps: ['そのサーバを止めます', '「もう一度試す」を押します。この Hangar.app が同梱のサーバを起こします'],
          command: LSOF(c.port),
          needsLsof: true,
        }),
    'db-too-old': (c) => ({
      title: 'データベースが古く、自動では更新できません',
      what: `${c.file} は${c.found !== null ? `版 ${c.found} で作られていて、この Hangar.app が更新できるのは版 ${c.baseline ?? '?'} 以降です` : '、この Hangar.app が更新できる版より古いものです'}。索引は Claude Code のトランスクリプトから作り直せますが、ノートとステータスは残せません。`,
      steps: ['hangar.db を別の名前に退避します', '「もう一度試す」を押します。索引を作り直します', 'ノートとステータスが要るときは、退避したファイルを添えて報告してください'],
      command: `mv ${shellQuote(c.file)} ${shellQuote(sibling(c.file, c.found !== null ? `hangar-v${c.found}.db` : 'hangar-old.db'))}`,
    }),
    'db-backup-failed': (c) => ({
      title: 'データベースのバックアップが取れないため、起動を止めました',
      what: `更新の前にバックアップを ${c.dir} に置きますが、書けませんでした。ディスクの空きが無いか、フォルダに書く権限が無いときに起きます。`,
      steps: ['ディスクの空きを確認します', 'backups/db に書けるか確認します', '「もう一度試す」を押します'],
      command: `ls -la ${shellQuote(c.dir)}`,
    }),
    other: () => ({
      title: 'Hangar を起動できませんでした',
      what: '起動の途中で止まりました。理由は下の詳細にあります。',
      steps: ['「もう一度試す」を押します', '直らなければ、詳細とログを読みます', '直らないときは、詳細とログの全文を添えて報告してください'],
      command: null,
    }),
  },
  en: {
    'server-exited': (c) => ({
      title: 'The server could not start',
      what: `The bundled server exited during startup. This usually happens when Node is missing or ${c.home} is not writable.`,
      steps: ['Press "Try again"', 'If that does not help, open the log and read the last lines', 'Check that Node 22 or later is installed', 'If it still fails, report it with the full log'],
      command: 'node --version',
    }),
    'port-in-use': (c) => ({
      title: `Port ${c.port} is in use by another app`,
      what: `hangar runs on port ${c.port}. Another process is listening there, and it is not a hangar server. hangar does not stop that process.`,
      steps: ['Find the process and stop it if you can', 'Press "Try again"', 'If you cannot stop it, close that app and reopen Hangar'],
      command: LSOF(c.port),
      needsLsof: true,
    }),
    'compat-mismatch': (c) => (c.theirs !== null && c.ours !== null && c.theirs > c.ours
      ? {
          title: `This Hangar.app is older than the hangar server running on ${c.port}`,
          what: `The running server is version ${c.theirs} and this Hangar.app is version ${c.ours}. That server was started by a newer hangar. hangar does not stop it.`,
          steps: ['Replace Hangar.app with a newer version', 'To keep using this version, stop that server and press "Try again"'],
          command: LSOF(c.port),
          needsLsof: true,
        }
      : {
          title: `The hangar server running on ${c.port} is older than this Hangar.app`,
          what: `The running server is version ${c.theirs ?? '?'} and this Hangar.app is version ${c.ours ?? '?'}. A server started with hangar start or npm run dev is still running. hangar does not stop it.`,
          steps: ['Stop that server', 'Press "Try again". This Hangar.app will start its bundled server'],
          command: LSOF(c.port),
          needsLsof: true,
        }),
    'db-too-old': (c) => ({
      title: 'The database is too old to update automatically',
      what: `${c.file} ${c.found !== null ? `was created at version ${c.found}, and this Hangar.app can update version ${c.baseline ?? '?'} or later` : 'is older than the versions this Hangar.app can update'}. The index can be rebuilt from Claude Code transcripts, but notes and statuses cannot be kept.`,
      steps: ['Move hangar.db aside under another name', 'Press "Try again". The index will be rebuilt', 'If you need the notes and statuses, report it with the file you moved aside'],
      command: `mv ${shellQuote(c.file)} ${shellQuote(sibling(c.file, c.found !== null ? `hangar-v${c.found}.db` : 'hangar-old.db'))}`,
    }),
    'db-backup-failed': (c) => ({
      title: 'Startup stopped because the database could not be backed up',
      what: `A backup goes to ${c.dir} before updating, but it could not be written. This happens when the disk is full or the folder is not writable.`,
      steps: ['Check free disk space', 'Check that backups/db is writable', 'Press "Try again"'],
      command: `ls -la ${shellQuote(c.dir)}`,
    }),
    other: () => ({
      title: 'Hangar could not start',
      what: 'Startup stopped partway. The reason is in the details below.',
      steps: ['Press "Try again"', 'If that does not help, read the details and the log', 'If it still fails, report it with the details and the full log'],
      command: null,
    }),
  },
};

// 札の見出しや操作の名前。種類に依らない。
const LABELS = {
  ja: { whatNext: '次にすること', details: '詳細', logAt: (home) => `記録はこの PC の ${home}/desktop.log にあります`, copyAll: '全文をコピー', copyCommand: 'コピー', copied: 'コピーしました', tryAgain: 'もう一度試す', openLog: 'ログを開く' },
  en: { whatNext: 'What to do next', details: 'Details', logAt: (home) => `The log is at ${home}/desktop.log on this computer`, copyAll: 'Copy all', copyCommand: 'Copy', copied: 'Copied', tryAgain: 'Try again', openLog: 'Open log' },
};

/**
 * 殻が渡した失敗から、札に並べるものを作る。
 * info は { kind, params, detail, lang, version, os, home }。知らない種類は other、知らない言語は日本語で出す。
 * params の値は文字か数だけを読み、ほかは捨てる。
 */
export function failView(info) {
  const kind = FAIL_KINDS.includes(info?.kind) ? info.kind : 'other';
  const lang = LANGS.includes(info?.lang) ? info.lang : LANGS[0];
  const home = text(info?.home, '~/.agent-hangar') || '~/.agent-hangar';
  const p = info?.params && typeof info.params === 'object' ? info.params : {};
  const c = {
    home,
    port: num(p.port) ?? DEFAULT_PORT,
    theirs: num(p.theirs),
    ours: num(p.ours),
    found: num(p.found),
    baseline: num(p.baseline),
    file: text(p.file) || `${home}/hangar.db`,
    dir: text(p.dir) || `${home}/backups/db`,
  };
  const row = TABLE[lang][kind](c);
  const os = text(info?.os);
  const version = text(info?.version);
  // Windows には lsof が無い。確かめられない命令は添えない。
  const command = row.needsLsof && /^Windows/.test(os) ? null : row.command;
  const detail = text(info?.detail);
  const footer = [version ? `Hangar ${version}` : '', os].filter(Boolean).join(' · ');
  const L = LABELS[lang];
  return {
    kind,
    lang,
    title: row.title,
    what: row.what,
    steps: row.steps,
    command,
    detail,
    footer,
    // 報告にそのまま貼れる形。版と OS、種類、詳細の順に置く。
    copyText: [...(footer ? [footer] : []), kind, ...(detail ? ['', detail] : [])].join('\n'),
    labels: { whatNext: L.whatNext, details: L.details, logAt: L.logAt(home), copyAll: L.copyAll, copyCommand: L.copyCommand, copied: L.copied, tryAgain: L.tryAgain, openLog: L.openLog },
  };
}
