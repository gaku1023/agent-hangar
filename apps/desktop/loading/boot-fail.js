// 起動に失敗したときの札の文。
// この頁は殻の中の静的な頁で、UI の辞書（packages/shared/src/i18n）を持たない。
// なので、失敗の札の文だけを入れた小さい日英の表をここに持つ。用語は UI の辞書と同じ用語集の語に合わせる。
// 殻は種類と数だけを渡し（lib.rs の fail_js と bootfail.rs）、文はここで作る。殻は札の文を書かない（詳細だけを頁の言語で書く）。

/** 札を出せる失敗の種類。bootfail.rs の KINDS と同じ並びにする（config.test.ts が突き合わせる）。 */
export const FAIL_KINDS = ['server-exited', 'port-in-use', 'db-too-old', 'db-backup-failed', 'compat-mismatch', 'node-missing', 'other'];

/** 札の言語。packages/shared の LANGUAGES と同じ（config.test.ts が突き合わせる）。先頭が既定である。 */
export const LANGS = ['ja', 'en'];

const DEFAULT_PORT = 4177;
/** 同梱のサーバが使う Node のメジャー版。殻が渡さなかったときだけ使う（殻は server-dist/manifest.json の nodeMajor を渡す）。 */
const DEFAULT_NODE_MAJOR = 22;

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

/** パスの最後の名前を、同じ置き場の別の名前に替える。区切りは / と Windows の \\ の両方を読み、元の区切りを残す。 */
const sibling = (file, name) => {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i < 0 ? name : `${file.slice(0, i + 1)}${name}`;
};

/**
 * 命令に埋めるパスを、PowerShell がそのまま読める形にする。
 * ~ で始まるものは $HOME に替えて二重引用符で包み、残りの $ と ` と " を ` で逃がす（~ を確実に展開させるため）。
 * 安全な文字だけならそのまま、そうでなければ単引用符で包み、中の単引用符を 2 つにする。
 */
export function psQuote(s) {
  if (s === '') return "''";
  if (s === '~') return '"$HOME"';
  if (s.startsWith('~\\') || s.startsWith('~/')) return `"$HOME${s.slice(1).replace(/[`$"]/g, (ch) => `\`${ch}`)}"`;
  return /^[A-Za-z0-9_.:\\/-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

// 札に添える命令。macOS と Linux はシェル、Windows は PowerShell で動く形にする。
const POSIX = {
  listening: (port) => `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
  move: (from, to) => `mv ${shellQuote(from)} ${shellQuote(to)}`,
  list: (dir) => `ls -la ${shellQuote(dir)}`,
};
const POWERSHELL = {
  listening: (port) => `Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`,
  move: (from, to) => `Move-Item -LiteralPath ${psQuote(from)} -Destination ${psQuote(to)}`,
  list: (dir) => `Get-ChildItem -Force -LiteralPath ${psQuote(dir)}`,
};

// Node を入れるコマンド。macOS は Homebrew で Node と tmux を一度に入れる。
// Windows は winget で Node だけを入れる（psmux はホームの帯と始める前の案内が別に出す）。node.rs の winget_command と同じ形にする。
// ほか（Linux）は nvm で入れる。
const NODE_INSTALL = {
  mac: (n) => `brew install node@${n} tmux`,
  windows: (n) => `winget install -e --id OpenJS.NodeJS.${n}`,
  other: (n) => `nvm install ${n}`,
};

/** Node が無いときの札の文（日本語）。理由は、入っていない（missing）、版が違う（version）、アーキテクチャが違う（arch）の 3 つ。 */
function nodeJa(c) {
  const { major, arch, reason, found, foundArch } = c.node;
  const lead = c.windows ? 'PowerShell で次を実行してください：' : 'ターミナルで次を実行してください：';
  const base = { lead, steps: [], command: c.node.install, tryAgain: '入れたのでもう一度試す' };
  if (reason === 'version') return { ...base, title: `Node.js ${major} が見つかりません`, what: `見つかった Node.js は ${found} です。Hangar の動作には Node.js ${major} が要ります。` };
  if (reason === 'arch') return { ...base, title: `${arch} 用の Node.js ${major} が見つかりません`, what: `見つかった Node.js ${major} は ${foundArch} 用です。${c.mac ? 'この Mac' : 'この PC'} で Hangar を動かすには ${arch} 用の Node.js ${major} が要ります。` };
  return { ...base, title: `Node.js ${major} が入っていません`, what: `Hangar の動作には Node.js ${major} が要ります。` };
}

/** 同上（英語）。 */
function nodeEn(c) {
  const { major, arch, reason, found, foundArch } = c.node;
  const lead = c.windows ? 'Run this in PowerShell:' : 'Run this in Terminal:';
  const base = { lead, steps: [], command: c.node.install, tryAgain: 'I installed it, try again' };
  if (reason === 'version') return { ...base, title: `Node.js ${major} was not found`, what: `The Node.js found is version ${found}. Hangar needs Node.js ${major} to run.` };
  if (reason === 'arch') return { ...base, title: `Node.js ${major} for ${arch} was not found`, what: `The Node.js ${major} found is for ${foundArch}. Hangar on ${c.mac ? 'this Mac' : 'this PC'} needs Node.js ${major} for ${arch}.` };
  return { ...base, title: `Node.js ${major} is not installed`, what: `Hangar needs Node.js ${major} to run.` };
}

// 種類ごとの文。c は params から作った値（port、theirs、ours、found、baseline、file、dir）と、置き場の名前（home）と、パスの区切り（sep）と、OS の命令の組（cmd）と、
// アプリの呼び名（app）と、macOS かどうか（mac）。Hangar.app は macOS の呼び名なので、Windows と Linux では Hangar と呼ぶ。
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
      command: c.cmd.listening(c.port),
    }),
    'compat-mismatch': (c) => (c.theirs !== null && c.ours !== null && c.theirs > c.ours
      ? {
          title: `この ${c.app} が、${c.port} で動いている hangar のサーバより古い版です`,
          what: `動いているサーバは版 ${c.theirs}、この ${c.app} は版 ${c.ours} です。そのサーバは、この ${c.app} より新しい hangar が起こしたものです。hangar はそのサーバを止めません。`,
          steps: c.mac
            ? ['Hangar.app を新しい版に入れ替えます', '入れ替えずに使うときは、そのサーバを止めてから「もう一度試す」を押します']
            : ['Hangar の新しい版をインストールします', 'インストールせずに使うときは、そのサーバを止めてから「もう一度試す」を押します'],
          command: c.cmd.listening(c.port),
        }
      : {
          title: `${c.port} で動いている hangar のサーバが、この ${c.app} より古い版です`,
          what: `動いているサーバは版 ${c.theirs ?? '?'}、この ${c.app} は版 ${c.ours ?? '?'} です。hangar start や npm run dev で起こしたサーバが残っています。hangar はそのサーバを止めません。`,
          steps: ['そのサーバを止めます', `「もう一度試す」を押します。この ${c.app} が同梱のサーバを起こします`],
          command: c.cmd.listening(c.port),
        }),
    'db-too-old': (c) => ({
      title: 'データベースが古く、自動では更新できません',
      what: `${c.file} は${c.found !== null ? `版 ${c.found} で作られていて、この ${c.app} が更新できるのは版 ${c.baseline ?? '?'} 以降です` : `、この ${c.app} が更新できる版より古いものです`}。索引は Claude Code のトランスクリプトから作り直せますが、ノートとステータスは残せません。`,
      steps: ['hangar.db を別の名前に退避します', '「もう一度試す」を押します。索引を作り直します', 'ノートとステータスが要るときは、退避したファイルを添えて報告してください'],
      command: c.cmd.move(c.file, sibling(c.file, c.found !== null ? `hangar-v${c.found}.db` : 'hangar-old.db')),
    }),
    'db-backup-failed': (c) => ({
      title: 'データベースのバックアップが取れないため、起動を止めました',
      what: `更新の前にバックアップを ${c.dir} に置きますが、書けませんでした。ディスクの空きが無いか、フォルダに書く権限が無いときに起きます。`,
      steps: ['ディスクの空きを確認します', `backups${c.sep}db に書けるか確認します`, '「もう一度試す」を押します'],
      command: c.cmd.list(c.dir),
    }),
    'node-missing': nodeJa,
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
      command: c.cmd.listening(c.port),
    }),
    'compat-mismatch': (c) => (c.theirs !== null && c.ours !== null && c.theirs > c.ours
      ? {
          title: `This ${c.app} is older than the hangar server running on ${c.port}`,
          what: `The running server is version ${c.theirs} and this ${c.app} is version ${c.ours}. That server was started by a newer hangar. hangar does not stop it.`,
          steps: [c.mac ? 'Replace Hangar.app with a newer version' : 'Install a newer version of Hangar', 'To keep using this version, stop that server and press "Try again"'],
          command: c.cmd.listening(c.port),
        }
      : {
          title: `The hangar server running on ${c.port} is older than this ${c.app}`,
          what: `The running server is version ${c.theirs ?? '?'} and this ${c.app} is version ${c.ours ?? '?'}. A server started with hangar start or npm run dev is still running. hangar does not stop it.`,
          steps: ['Stop that server', `Press "Try again". This ${c.app} will start its bundled server`],
          command: c.cmd.listening(c.port),
        }),
    'db-too-old': (c) => ({
      title: 'The database is too old to update automatically',
      what: `${c.file} ${c.found !== null ? `was created at version ${c.found}, and this ${c.app} can update version ${c.baseline ?? '?'} or later` : `is older than the versions this ${c.app} can update`}. The index can be rebuilt from Claude Code transcripts, but notes and statuses cannot be kept.`,
      steps: ['Move hangar.db aside under another name', 'Press "Try again". The index will be rebuilt', 'If you need the notes and statuses, report it with the file you moved aside'],
      command: c.cmd.move(c.file, sibling(c.file, c.found !== null ? `hangar-v${c.found}.db` : 'hangar-old.db')),
    }),
    'db-backup-failed': (c) => ({
      title: 'Startup stopped because the database could not be backed up',
      what: `A backup goes to ${c.dir} before updating, but it could not be written. This happens when the disk is full or the folder is not writable.`,
      steps: ['Check free disk space', `Check that backups${c.sep}db is writable`, 'Press "Try again"'],
      command: c.cmd.list(c.dir),
    }),
    'node-missing': nodeEn,
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
  ja: { whatNext: '次にすること', details: '詳細', detailsToggle: '詳細（調べた場所、別の入れ方）', logAt: (log) => `記録はこの PC の ${log} にあります`, copyAll: '全文をコピー', copyCommand: 'コピー', copied: 'コピーしました', tryAgain: 'もう一度試す', openLog: 'ログを開く' },
  en: { whatNext: 'What to do next', details: 'Details', detailsToggle: 'Details (places checked, other ways to install)', logAt: (log) => `The log is at ${log} on this computer`, copyAll: 'Copy all', copyCommand: 'Copy', copied: 'Copied', tryAgain: 'Try again', openLog: 'Open log' },
};

/**
 * Node が無いときの札の材料。殻（node.rs の failure_params）が渡す major、arch、reason、found、foundArch を読む。
 * 版が違うのに見つかった版が無い、アーキテクチャが違うのに見つかったものが無い、知らない理由は、入っていない札に落とす。
 */
function nodeOf(p, install) {
  const major = num(p.major) ?? DEFAULT_NODE_MAJOR;
  const arch = text(p.arch);
  const found = num(p.found);
  const foundArch = text(p.foundArch);
  const reason = p.reason === 'version' && found !== null ? 'version' : p.reason === 'arch' && foundArch !== '' && arch !== '' ? 'arch' : 'missing';
  return { major, arch, reason, found, foundArch, install: install(major) };
}

/**
 * 殻が渡した失敗から、札に並べるものを作る。
 * info は { kind, params, detail, lang, version, os, home, sep }。知らない種類は other、知らない言語は日本語で出す。
 * sep はパスの区切りで、殻が OS のもの（Windows は \\）を渡す。\\ のほかは / と読む（前の版の殻は渡さない）。
 * params の値は文字か数だけを読み、ほかは捨てる。
 */
export function failView(info) {
  const kind = FAIL_KINDS.includes(info?.kind) ? info.kind : 'other';
  const lang = LANGS.includes(info?.lang) ? info.lang : LANGS[0];
  const sep = info?.sep === '\\' ? '\\' : '/';
  const home = text(info?.home, `~${sep}.agent-hangar`) || `~${sep}.agent-hangar`;
  const join = (...names) => [home, ...names].join(sep);
  const p = info?.params && typeof info.params === 'object' ? info.params : {};
  const os = text(info?.os);
  const mac = /^macOS/.test(os);
  const windows = /^Windows/.test(os);
  const c = {
    home,
    sep,
    mac,
    windows,
    app: mac ? 'Hangar.app' : 'Hangar',
    // Windows には lsof も mv も無い。PowerShell で動く形の命令を出す。
    cmd: windows ? POWERSHELL : POSIX,
    node: nodeOf(p, mac ? NODE_INSTALL.mac : windows ? NODE_INSTALL.windows : NODE_INSTALL.other),
    port: num(p.port) ?? DEFAULT_PORT,
    theirs: num(p.theirs),
    ours: num(p.ours),
    found: num(p.found),
    baseline: num(p.baseline),
    file: text(p.file) || join('hangar.db'),
    dir: text(p.dir) || join('backups', 'db'),
  };
  const row = TABLE[lang][kind](c);
  const L = LABELS[lang];
  const version = text(info?.version);
  const command = row.command;
  const detail = text(info?.detail);
  const footer = [version ? `Hangar ${version}` : '', os].filter(Boolean).join(' · ');
  return {
    kind,
    lang,
    title: row.title,
    what: row.what,
    steps: row.steps,
    // 次にすることの代わりに、命令の前に置く 1 文（Node が無いときの札だけ）。
    lead: row.lead ?? null,
    command,
    detail,
    // 詳細を畳んでおくか。Node が無いときの札は、入れるコマンドを主にし、調べた場所は畳む。
    collapsed: kind === 'node-missing',
    footer,
    // 報告にそのまま貼れる形。版と OS、種類、詳細の順に置く。
    copyText: [...(footer ? [footer] : []), kind, ...(detail ? ['', detail] : [])].join('\n'),
    // 動いている版。札の中の更新の文（updateView）に使う。
    current: version,
    labels: { whatNext: L.whatNext, details: L.details, detailsToggle: L.detailsToggle, logAt: L.logAt(join('desktop.log')), copyAll: L.copyAll, copyCommand: L.copyCommand, copied: L.copied, tryAgain: row.tryAgain ?? L.tryAgain, openLog: L.openLog },
  };
}

// 札の中の更新の文。起動に失敗する版を入れた人が、UI まで届かなくても新しいバージョンを受け取れるようにする。
// 語は UI の辞書（packages/shared の update.*）と同じものを使う（boot-fail.test.ts が突き合わせる）。
const UPDATE = {
  ja: {
    check: '更新を確認',
    checking: '確認中…',
    latest: '最新',
    availableTitle: (v) => `Hangar ${v} を利用できます`,
    availableDetail: (cur) => `現在は ${cur} です。`,
    mayFix: '新しいバージョンで直っていることがあります。',
    download: 'ダウンロードしてインストール',
    downloadingTitle: (v) => `Hangar ${v}`,
    percent: (n) => `${n}%`,
    downloadingUnknown: 'ダウンロードしています…',
    progressLabel: 'ダウンロードの進み具合',
    installing: 'インストールしています…終わると再起動します。',
    failedCheck: '更新を確認できませんでした',
    failedDownload: 'ダウンロードできませんでした',
    failedInstall: 'インストールできませんでした',
    failedDetail: (cur, reason) => `いまのバージョン ${cur} は変わりません。${reason}`,
    reason: { network: 'ネットワークか配布元に接続できませんでした。', signature: '署名を確認できませんでした。', permission: 'インストールの許可が得られませんでした。', other: '詳しくはログを確認してください。' },
  },
  en: {
    check: 'Check for updates',
    checking: 'Checking…',
    latest: 'Up to date',
    availableTitle: (v) => `Hangar ${v} is available`,
    availableDetail: (cur) => `You have ${cur}.`,
    mayFix: ' The new version may fix this.',
    download: 'Download and install',
    downloadingTitle: (v) => `Hangar ${v}`,
    percent: (n) => `${n}%`,
    downloadingUnknown: 'Downloading…',
    progressLabel: 'Download progress',
    installing: 'Installing… Hangar restarts when it finishes.',
    failedCheck: "Couldn't check for updates",
    failedDownload: "Couldn't download the update",
    failedInstall: "Couldn't install the update",
    failedDetail: (cur, reason) => `You're still on ${cur}. ${reason}`,
    reason: { network: "Couldn't reach the network or the download server.", signature: "The signature couldn't be verified.", permission: 'Permission to install was not granted.', other: 'See the log for details.' },
  },
};

/**
 * 札の中の更新の見せ方。u は頁が持つ更新の様子で、phase は次のどれか。
 * idle（まだ確かめていない）、checking（確かめている）、latest（新しいバージョンが無い）、available（version がある）、
 * downloading（version、done、total）、installing（version）、failed（step は check、download、install のどれか。reason は殻の分けた 4 つ）。
 * 返すのは、下端の「更新を確認」の釦（check）、版の横の添え書き（note）、札の中の帯（band）、「もう一度試す」を主の釦から外すか（demote）。
 * 帯が主の釦を持つ間（ダウンロードしてインストール）は、主の釦を 2 つにしないよう「もう一度試す」を外す。
 * kind は札の種類。Node が無いときは新しいバージョンを入れても Node は入らないので、直るとは言わない。
 */
export function updateView(lang, u, current, kind) {
  const L = UPDATE[LANGS.includes(lang) ? lang : LANGS[0]];
  const cur = text(current, '?') || '?';
  const reason = (r) => L.reason[Object.hasOwn(L.reason, r) ? r : 'other'];
  const idle = { hidden: false, disabled: false, label: L.check };
  const away = { hidden: true, disabled: true, label: L.check };
  const band = (b) => ({ tone: 'info', detail: '', action: null, progress: null, progressLabel: L.progressLabel, ...b });
  switch (u?.phase) {
    case 'checking':
      return { check: { hidden: false, disabled: true, label: L.checking }, note: null, band: null, demote: false };
    case 'latest':
      return { check: away, note: L.latest, band: null, demote: false };
    case 'available':
      return { check: away, note: null, band: band({ title: L.availableTitle(u.version), detail: L.availableDetail(cur) + (kind === 'node-missing' ? '' : L.mayFix), action: L.download }), demote: true };
    case 'downloading': {
      const known = typeof u.total === 'number' && u.total > 0;
      const ratio = known ? Math.min(1, Math.max(0, u.done / u.total)) : null;
      return { check: away, note: null, band: band({ title: L.downloadingTitle(u.version), detail: known ? L.percent(Math.round(ratio * 100)) : L.downloadingUnknown, progress: ratio }), demote: true };
    }
    case 'installing':
      return { check: away, note: null, band: band({ title: L.downloadingTitle(u.version), detail: L.installing }), demote: true };
    case 'failed':
      if (u.step === 'check') return { check: idle, note: null, band: band({ tone: 'error', title: L.failedCheck, detail: reason(u.reason) }), demote: false };
      return { check: away, note: null, band: band({ tone: 'error', title: u.step === 'install' ? L.failedInstall : L.failedDownload, detail: L.failedDetail(cur, reason(u.reason)), action: L.download }), demote: true };
    default:
      return { check: idle, note: null, band: null, demote: false };
  }
}
