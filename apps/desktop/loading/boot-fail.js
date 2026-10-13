// 起動に失敗したときの札の文。
// この頁は殻の中の静的な頁で、UI の辞書（packages/shared/src/i18n）を持たない。
// なので、失敗の札の文だけを入れた小さい日英の表をここに持つ。用語は UI の辞書と同じ用語集の語に合わせる。
// 殻は種類と数だけを渡し（lib.rs の fail_js と bootfail.rs）、文はここで作る。殻は札の文を書かない（詳細だけを頁の言語で書く）。

/** 札を出せる失敗の種類。bootfail.rs の KINDS と同じ並びにする（config.test.ts が突き合わせる）。 */
export const FAIL_KINDS = ['server-exited', 'port-in-use', 'db-too-old', 'db-backup-failed', 'compat-mismatch', 'node-missing', 'node-version-mismatch', 'node-arch-mismatch', 'other'];

/** Node の札の種類。見つからない、版が古い（Node-API が足りない）、アーキテクチャが違う（node.rs の failure_kind）。 */
export const NODE_KINDS = ['node-missing', 'node-version-mismatch', 'node-arch-mismatch'];

/** 札の言語。packages/shared の LANGUAGES と同じ（config.test.ts が突き合わせる）。先頭が既定である。 */
export const LANGS = ['ja', 'en'];

const DEFAULT_PORT = 4177;
/**
 * 同梱のサーバが要る Node（Node-API の版と、それを持つ最初の Node の版）。殻が渡さなかったときだけ使う（殻は server-dist/manifest.json の nodeApi と nodeMin を渡す）。
 * 規則の値（packages/server/src/config/nodeRule.ts の NODE_API_MIN と NODE_MIN_LABEL）と同じにする（bundle-server.test.ts が突き合わせる）。
 */
export const DEFAULT_NODE_MIN = '22.14';
export const DEFAULT_NODE_API = 10;

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

// Node を入れるコマンド。
// 何も入っていないとき（fresh）は一般の入れ方にする。macOS は Homebrew で Node と tmux を一度に入れ、Windows は winget の LTS（psmux はホームの帯と始める前の案内が別に出す）、ほか（Linux）は nvm の LTS。
// 合わない Node がすでにあるとき（beside）は、今の Node を置き換えない入れ方にする。
// macOS は Homebrew の node@<版>（版つきの formula は既定の node を置き換えない。殻は opt/node@N も探す）、Linux は nvm。
// Windows の winget の Node は C:\Program Files\nodejs に入り、今の Node を置き換えるので出さない。代わりに公式の zip を別のフォルダに展開して選ぶ手順を出す。
// node.rs の詳細の文と同じ命令にする。
const NODE_INSTALL = {
  mac: { fresh: () => 'brew install node tmux', beside: (lts) => `brew install node@${lts}` },
  windows: { fresh: () => 'winget install -e --id OpenJS.NodeJS.LTS', beside: () => null },
  other: { fresh: () => 'nvm install --lts', beside: (lts) => `nvm install ${lts}` },
};

/** Node の札の文（日本語）。理由は、見つからない（missing）、版が古い（version）、アーキテクチャが違う（arch）の 3 つ。 */
function nodeJa(c) {
  const { min, napi, lts, arch, reason, found, foundArch } = c.node;
  const tryAgain = '入れたのでもう一度試す';
  if (reason === 'missing') {
    return {
      title: 'Node.js が見つかりません',
      what: `Hangar のデータベースと端末の部品は Node-API ${napi} を使うため、Node.js ${min} 以上が要ります。`,
      lead: c.windows ? 'PowerShell で次を実行してください：' : 'ターミナルで次を実行してください：',
      steps: [],
      command: c.node.install.fresh(lts),
      tryAgain,
    };
  }
  const title = reason === 'version' ? `Node.js ${found} は見つかりましたが、Hangar は Node.js ${min} 以上が要ります` : `${foundArch} 用の Node.js は見つかりましたが、Hangar は ${arch} 用が要ります`;
  const keep = '今の Node.js は置き換えずに、別の場所に入れられます。';
  const what = reason === 'version' ? `Hangar のデータベースと端末の部品が Node-API ${napi} を使うためです。${keep}` : `${c.mac ? 'この Mac' : 'この PC'} で Hangar を動かすには、${arch} 用の Node.js ${min} 以上が要ります。${keep}`;
  if (c.windows) {
    return {
      title,
      what,
      lead: '今の Node.js を置き換えずに入れるには：',
      steps: [`nodejs.org から Node.js ${lts} の Windows 用 zip（${arch}）を取得します`, `今の Node.js とは別のフォルダ（例 %LOCALAPPDATA%\\Programs\\node${lts}）に展開します`, `「${c.node.pickLabel}」を押して、展開したフォルダの node.exe を選びます`],
      command: null,
      tryAgain: 'もう一度試す',
    };
  }
  return { title, what, lead: '今の Node.js を置き換えずに入れるには、ターミナルで次を実行してください：', steps: [], command: c.node.install.beside(lts), tryAgain };
}

/** 同上（英語）。 */
function nodeEn(c) {
  const { min, napi, lts, arch, reason, found, foundArch } = c.node;
  const tryAgain = 'I installed it, try again';
  if (reason === 'missing') {
    return {
      title: 'Node.js was not found',
      what: `Hangar's database and terminal parts use Node-API ${napi}, so Hangar needs Node.js ${min} or later.`,
      lead: c.windows ? 'Run this in PowerShell:' : 'Run this in Terminal:',
      steps: [],
      command: c.node.install.fresh(lts),
      tryAgain,
    };
  }
  const title = reason === 'version' ? `Node.js ${found} was found, but Hangar needs Node.js ${min} or later` : `Node.js for ${foundArch} was found, but Hangar needs one for ${arch}`;
  const keep = 'You can install it in another place without replacing your current Node.js.';
  const what = reason === 'version' ? `Hangar's database and terminal parts use Node-API ${napi}. ${keep}` : `Hangar on ${c.mac ? 'this Mac' : 'this PC'} needs Node.js ${min} or later for ${arch}. ${keep}`;
  if (c.windows) {
    return {
      title,
      what,
      lead: 'To install it without replacing your current Node.js:',
      steps: [`Get the Windows zip of Node.js ${lts} (${arch}) from nodejs.org`, `Extract it to a folder separate from your current Node.js (for example %LOCALAPPDATA%\\Programs\\node${lts})`, `Press "${c.node.pickLabel}" and choose node.exe in that folder`],
      command: null,
      tryAgain: 'Try again',
    };
  }
  return { title, what, lead: 'To install it without replacing your current Node.js, run this in Terminal:', steps: [], command: c.node.install.beside(lts), tryAgain };
}

/** 「node を選ぶ…」の釦の名前。Windows では実行ファイルの名前どおり node.exe と言う。 */
const PICK_LABEL = {
  ja: (windows) => (windows ? 'node.exe を選ぶ…' : 'node を選ぶ…'),
  en: (windows) => (windows ? 'Choose node.exe…' : 'Choose node…'),
};

// 種類ごとの文。c は params から作った値（port、theirs、ours、found、baseline、file、dir）と、置き場の名前（home）と、パスの区切り（sep）と、OS の命令の組（cmd）と、
// アプリの呼び名（app）と、macOS かどうか（mac）。Hangar.app は macOS の呼び名なので、Windows と Linux では Hangar と呼ぶ。
const TABLE = {
  ja: {
    'server-exited': (c) => ({
      title: 'サーバを起動できませんでした',
      what: `同梱のサーバが起動の途中で終了しました。Node が見つからないか、${c.home} に書けないときに多く起きます。`,
      // 殻と hangar コマンドは、Node-API が要る版以上の Node を使う（上限は無い）。
      steps: ['「もう一度試す」を押します', '直らなければ、ログを開いて最後の数行を読みます', `Node ${c.node.min} 以上が入っているか確認します`, '直らないときは、ログの全文を添えて報告してください'],
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
    'node-version-mismatch': nodeJa,
    'node-arch-mismatch': nodeJa,
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
      steps: ['Press "Try again"', 'If that does not help, open the log and read the last lines', `Check that Node ${c.node.min} or later is installed`, 'If it still fails, report it with the full log'],
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
    'node-version-mismatch': nodeEn,
    'node-arch-mismatch': nodeEn,
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
 * Node の札の材料。殻（node.rs の failure_params）が渡す min、napi、arch、found、foundArch を読む。
 * 理由は種類から決める。版が古いのに見つかった版が無い、アーキテクチャが違うのに見つかった作りが無いときは、見つからない札に落とす。
 * 版は数と点だけ、作りは英小文字と数字だけを採る（文に埋めるので、ほかの字が混じったら捨てる）。
 */
function nodeOf(kind, p, install, pickLabel) {
  const minText = text(p.min);
  const min = /^\d+(\.\d+){0,2}$/.test(minText) ? minText : DEFAULT_NODE_MIN;
  const napi = num(p.napi) ?? DEFAULT_NODE_API;
  const word = (v) => (/^[a-z0-9]+$/.test(text(v)) ? text(v) : '');
  const arch = word(p.arch);
  const found = /^\d+\.\d+\.\d+$/.test(text(p.found)) ? text(p.found) : '';
  const foundArch = word(p.foundArch);
  const reason = kind === 'node-version-mismatch' && found !== '' ? 'version' : kind === 'node-arch-mismatch' && foundArch !== '' && arch !== '' ? 'arch' : 'missing';
  return { min, napi, lts: Number(min.split('.')[0]), arch, reason, found, foundArch, install, pickLabel };
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
    node: nodeOf(kind, p, mac ? NODE_INSTALL.mac : windows ? NODE_INSTALL.windows : NODE_INSTALL.other, PICK_LABEL[lang](windows)),
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
  const isNode = NODE_KINDS.includes(kind);
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
    // 詳細を畳んでおくか。Node の札は、入れ方を主にし、調べた場所は畳む。
    collapsed: isNode,
    // 「node を選ぶ…」の釦（Node の札だけ）。コマンドの無い札（Windows で古い Node があるとき）は、これを主の釦にする。
    pick: isNode ? { label: PICK_LABEL[lang](windows), primary: row.command === null } : null,
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
 * kind は札の種類。Node の札では新しいバージョンを入れても Node は入らないので、直るとは言わない。
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
      return { check: away, note: null, band: band({ title: L.availableTitle(u.version), detail: L.availableDetail(cur) + (NODE_KINDS.includes(kind) ? '' : L.mayFix), action: L.download }), demote: true };
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

// 「node を選ぶ…」で選んだ Node が合わなかったときの文。殻（lib.rs の pick_node）の答えから作る。
const PICK = {
  ja: {
    notNode: (r) => `${r.path} は Node.js として答えませんでした。node の実行ファイルを選んでください。`,
    version: (r) => `選んだ Node.js は ${r.found} です。Node.js ${r.min} 以上を選んでください。`,
    arch: (r) => `選んだ Node.js は ${r.foundArch} 用です。${r.arch} 用を選んでください。`,
    saveFailed: (r) => `設定に保存できませんでした（${r.error}）。`,
    other: () => '選んだ Node.js を確かめられませんでした。',
  },
  en: {
    notNode: (r) => `${r.path} did not answer as Node.js. Choose the node executable.`,
    version: (r) => `The Node.js you chose is ${r.found}. Choose Node.js ${r.min} or later.`,
    arch: (r) => `The Node.js you chose is for ${r.foundArch}. Choose one for ${r.arch}.`,
    saveFailed: (r) => `Couldn't save the setting (${r.error}).`,
    other: () => "Couldn't check the Node.js you chose.",
  },
};

/**
 * 選んだ Node の答え r（{ result, path, found, foundArch, min, arch, error }）から、札に添える文を作る。
 * 取り消した（cancel）、合って保存した（ok）、答えが無いときは null（何も添えない）。知らない答えは確かめられなかったと言う。
 */
export function pickText(lang, r) {
  if (!r || typeof r !== 'object' || r.result === 'cancel' || r.result === 'ok') return null;
  const t = PICK[LANGS.includes(lang) ? lang : LANGS[0]];
  const v = { path: text(r.path, '?'), found: text(r.found, '?'), foundArch: text(r.foundArch, '?'), min: text(r.min, DEFAULT_NODE_MIN), arch: text(r.arch, '?'), error: text(r.error, '?') };
  return Object.hasOwn(t, r.result) && r.result !== 'other' ? t[r.result](v) : t.other();
}
