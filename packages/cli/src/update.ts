import fs from 'node:fs';
import path from 'node:path';

/** tar で入れたときの形。prefix/versions/<版>/app/cli.mjs と prefix/current（今の版への symlink）。 */
export type TarLayout = { prefix: string; version: string; current: string };

/**
 * cli.mjs の置き場（here）から、tar で入れた形かを調べる。
 * 版ごとのディレクトリの下（versions/<版>）で、VERSION があるときだけ tar の入れ方とみなす。
 * リポジトリや .app の束は VERSION を持たないので null になり、hangar update は使えない。
 */
export function tarLayout(here: string): TarLayout | null {
  const root = path.dirname(here);
  const versionsDir = path.dirname(root);
  if (path.basename(versionsDir) !== 'versions') return null;
  let version: string;
  try {
    version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!version) return null;
  const prefix = path.dirname(versionsDir);
  return { prefix, version, current: path.join(prefix, 'current') };
}

/**
 * ユニットに書く node と server.mjs の場所。版ごとの実体ではなく current の下を指すので、
 * 更新で current が移っても、ユニットを書き換えずに再起動だけで新しいバージョンになる。
 */
export function stableServicePaths(layout: TarLayout): { nodePath: string; serverArgs: string[]; workingDir: string } {
  return {
    nodePath: path.join(layout.current, 'node', 'bin', 'node'),
    serverArgs: [path.join(layout.current, 'app', 'server.mjs')],
    workingDir: path.join(layout.current, 'app'),
  };
}

const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

function parseTag(tag: string): [number, number, number, number] {
  const m = TAG_RE.exec(tag);
  if (!m) throw new Error(`版の形が読めません: ${tag}`);
  // rc の無い正式な版は、同じ版の rc より新しい。
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4])];
}

/** 版の比べ。正なら a が新しい。 */
export function compareTags(a: string, b: string): number {
  const x = parseTag(a);
  const y = parseTag(b);
  for (let i = 0; i < 4; i++) {
    if (x[i]! === y[i]!) continue;
    return x[i]! > y[i]! ? 1 : -1;
  }
  return 0;
}

/** GitHub の最新の Release の JSON からタグを取る。 */
export function latestTagFrom(json: unknown): string {
  const tag = (json as { tag_name?: unknown } | null)?.tag_name;
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new Error('最新の版を読み取れませんでした。');
  return tag;
}

export type RestartResult = 'restarted' | 'none' | 'failed';

export type UpdateOptions = {
  /** cli.mjs の置き場。 */
  here: string;
  platform: NodeJS.Platform;
  /** 指定すると最新を引かず、その版を入れる（古い版にも戻せる）。 */
  version?: string;
  /** 新しいバージョンを告げるだけで入れない。 */
  check?: boolean;
  fetchLatest: () => Promise<string>;
  /** その版を入れる。成功なら true。 */
  install: (tag: string, layout: TarLayout) => Promise<boolean>;
  /** 入っている systemd のユニットを再起動する。ユニットが無ければ 'none'。 */
  restart: () => Promise<RestartResult>;
  log: (line: string) => void;
};

export async function runUpdate(o: UpdateOptions): Promise<{ ok: boolean }> {
  const log = o.log;
  if (o.platform !== 'linux') { log('hangar update は、Linux で tar から入れた hangar だけで使えます。'); return { ok: false }; }
  const layout = tarLayout(o.here);
  if (!layout) {
    log('hangar update は、install.sh で入れた hangar だけで使えます。この hangar は別の方法で入っています。');
    return { ok: false };
  }

  const target = o.version ?? (await o.fetchLatest());
  const cmp = compareTags(target, layout.version);
  if (o.version === undefined) {
    if (cmp === 0) { log(`今の版（${layout.version}）が最新です。`); return { ok: true }; }
    if (cmp < 0) { log(`今の版（${layout.version}）は、最新（${target}）より新しいため、変えません。`); return { ok: true }; }
  } else if (cmp === 0) {
    log(`すでに ${target} です。`);
    return { ok: true };
  }

  if (o.check) { log(`新しいバージョンがあります: ${layout.version} → ${target}`); return { ok: true }; }

  log(`${layout.version} から ${target} に更新します。`);
  if (!(await o.install(target, layout))) { log('インストールに失敗しました。今の版はそのままです。'); return { ok: false }; }

  const restarted = await o.restart();
  if (restarted === 'restarted') {
    log('サーバーを再起動しました。tmux の会話は保持されます。');
    return { ok: true };
  }
  if (restarted === 'none') {
    log('常駐は入っていません。常駐させるには hangar service install を実行してください。起動中の hangar は、停止してから起動し直すと新しいバージョンになります。');
    return { ok: true };
  }
  log('新しいバージョンは入りましたが、サーバーを再起動できませんでした。次を実行してください: systemctl --user restart hangar.service（システムユニットなら sudo systemctl restart hangar.service）');
  return { ok: false };
}
