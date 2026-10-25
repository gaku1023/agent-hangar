import { providerFactOf, type OpencodeConnectedDto, type OpencodeLoginDto, type ProviderPrice, type Translate } from '@agent-hangar/shared';
import { homePath } from '../lib/paths.ts';
import type { State } from '../mediator/types.ts';
import { CUSTOM_PROVIDER_ROW, type OpencodeProviderOp, type Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';

/**
 * 設定の「連携 › opencode › プロバイダー」（試作 model-picker.html の設定の面）。
 * つないだ先の行（各行に「モデル ID を追加」「API キーを変更」「接続を解除」）と、「＋ プロバイダーを追加」の一覧（おすすめが先頭）、
 * OpenAI 互換のサーバーの欄、ログインの進み、モデルの小窓から来たときの「‹ 新しいセッションに戻る」を組む。
 */

/** つないだ先の 1 行。desc は接続の仕方と料金の型、url は baseURL の宛先とパス。busy は送っている操作、error はこの行の失敗、fresh は直前に接続した行。 */
export type OpencodeProviderRowProps = {
  id: string; name: string; desc: string; url: string | null;
  canChangeKey: boolean; canDisconnect: boolean;
  busy: OpencodeProviderOp | null; error: string | null; fresh: boolean;
};
/** 追加の一覧の 1 行。side は右に出す料金の型（分からなければ null）、key は API キーの欄を出すか、login はログインの方法（API キーが無いときに使う）。 */
export type OpencodeCatalogRowProps = { id: string; name: string; side: string | null; recommended: boolean; key: boolean; login: { id: string; label: string } | null; busy: boolean; error: string | null };
/** 始めたログイン。note は進みの一文。 */
export type OpencodeLoginProps = { id: string; name: string; url: string; instructions: string; mode: OpencodeLoginDto['mode']; state: 'pending' | 'complete' | 'failed' | 'expired'; note: string; busy: boolean; error: string | null };

export type OpencodeProvidersProps = {
  status: 'loading' | 'ready' | 'failed';
  /** 一覧を取れなかった理由。 */
  failure: string | null;
  rows: OpencodeProviderRowProps[];
  catalog: OpencodeCatalogRowProps[];
  /** 追加の一覧の社数（検索の欄に出す）。 */
  total: number;
  /** 書き換える opencode.json（ホームの下は ~ で縮める）。 */
  configPath: string;
  custom: { busy: boolean; error: string | null };
  login: OpencodeLoginProps | null;
  /** 「‹ 新しいセッションに戻る」を出すか（モデルの小窓の「プロバイダーを管理…」から来たとき）。 */
  back: boolean;
};

/** 料金の型の一文。定額は月額か要ログインを添える。 */
export function priceText(t: Translate, p: ProviderPrice | null): string | null {
  if (!p) return null;
  switch (p.kind) {
    case 'metered': return t('settings.opencode.providers.price.metered');
    case 'metered-free': return t('settings.opencode.providers.price.meteredFree');
    case 'free': return t('settings.opencode.providers.price.free');
    case 'local': return t('settings.opencode.providers.price.local');
    case 'plan': {
      const extra = p.monthlyUsd !== null ? t('settings.opencode.providers.price.monthly', { n: String(p.monthlyUsd) }) : p.loginOnly ? t('settings.opencode.providers.price.loginOnly') : null;
      return [t('settings.opencode.providers.price.plan'), extra].filter(Boolean).join(' · ');
    }
  }
}

/** つないだ先の説明。接続の仕方と、分かれば料金の型。 */
function descOf(t: Translate, r: OpencodeConnectedDto): string {
  const price = priceText(t, r.price);
  const parts: (string | null)[] = (() => {
    switch (r.via) {
      case 'key': case 'login': return [price, t('settings.opencode.providers.via.connected')];
      case 'env': return [t('settings.opencode.providers.via.env', { name: r.envName ?? '' })];
      case 'config': return [t('settings.opencode.providers.via.compatible')];
      case 'auto':
        return r.where === 'remote'
          ? [t('settings.opencode.providers.via.noKey'), providerFactOf(r.id).limitedFree ? t('settings.opencode.providers.via.limited') : null]
          : [price ?? t('settings.opencode.providers.price.local'), t('settings.opencode.providers.via.auto')];
    }
  })();
  return parts.filter((x): x is string => !!x).join(' · ');
}

/** URL の表示。方式（http://）を落として宛先とパスだけにする。 */
const shortUrl = (url: string | null): string | null => (url ? url.replace(/^https?:\/\//, '').replace(/\/+$/, '') : null);

export function presentOpencodeProviders(state: State, store: Store): OpencodeProvidersProps {
  const t = translatorOf(store);
  const p = store.opencodeProviders;
  const data = p?.data ?? null;
  const busyOf = (id: string) => (p?.busy?.id === id ? p.busy.op : null);
  const errorOf = (id: string) => (p?.error && p.error.id === id && p.error.op !== 'load' ? p.error.message : null);
  const rows: OpencodeProviderRowProps[] = (data?.connected ?? []).map((r) => ({
    id: r.id, name: r.name, desc: descOf(t, r), url: shortUrl(r.url),
    canChangeKey: r.canChangeKey, canDisconnect: r.canDisconnect,
    busy: busyOf(r.id), error: errorOf(r.id), fresh: p?.added === r.id,
  }));
  const catalog: OpencodeCatalogRowProps[] = (data?.catalog ?? []).map((c) => ({
    id: c.id, name: c.name, side: priceText(t, c.price), recommended: c.recommended, key: c.key,
    login: c.key ? null : c.logins[0] ?? null, busy: busyOf(c.id) !== null, error: errorOf(c.id),
  }));
  const l = p?.login ?? null;
  const loginName = l ? data?.catalog.find((c) => c.id === l.id)?.name ?? data?.connected.find((c) => c.id === l.id)?.name ?? l.id : '';
  const note = (s: NonNullable<typeof l>['status']) => t(s === 'expired' ? 'settings.opencode.providers.login.expired' : s === 'failed' ? 'settings.opencode.providers.login.failed' : 'settings.opencode.providers.login.waiting');
  return {
    status: p ? (p.data ? 'ready' : p.status) : 'loading',
    failure: p?.error?.op === 'load' ? p.error.message : null,
    rows, catalog, total: catalog.length,
    configPath: homePath(data?.configPath ?? '~/.config/opencode/opencode.json', store.home),
    custom: { busy: busyOf(CUSTOM_PROVIDER_ROW) !== null, error: errorOf(CUSTOM_PROVIDER_ROW) },
    login: l ? { id: l.id, name: loginName, url: l.attempt.url, instructions: l.attempt.instructions, mode: l.attempt.mode, state: l.status, note: note(l.status), busy: busyOf(l.id) === 'login', error: errorOf(l.id) } : null,
    back: !!state.opencodeReturn,
  };
}
