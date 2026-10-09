// 部品を試作と並べて撮るための頁。`npm run dev -w @agent-hangar/ui` のあと /preview/primitives.html を開く。
// 本番の bundle には入らない（vite の入口は index.html だけ）。
// ?open=info|perm で、その部品のポップオーバーを開いた形で出す。例の値は作り物である。
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/controls.css';
import { CountChip, SettingChip } from '../src/views/primitives/Chip.tsx';
import { InfoPopover, Popover } from '../src/views/primitives/Popover.tsx';

const open = new URLSearchParams(location.search).get('open');
const noop = () => {};

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 };
const card: CSSProperties = { padding: '16px 20px', borderRadius: 14, background: 'var(--surface)', boxShadow: 'var(--surface-shadow)' };
const h2: CSSProperties = { margin: '0 0 8px', fontSize: 'var(--fs)' };

/** ホームの帯（試作 B 案の .band と .band-pill）。 */
function Band() {
  return (
    <div id="band" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 6px 0 12px', borderRadius: 14, background: 'rgba(255, 255, 255, 0.55)', boxShadow: 'var(--glass-edge)' }}>
      <CountChip label="要対応" count={4} tone="wait" icon="alert" expanded onClick={noop} />
      <CountChip label="実行中" count={2} icon="tool" expanded={false} onClick={noop} />
      <CountChip label="確認待ち" count={3} tone="cand" icon="check" expanded={false} onClick={noop} />
      <CountChip label="確認待ち" count={0} tone="cand" icon="check" expanded={false} onClick={noop} />
    </div>
  );
}

/** 小さい札（セッション画面の試作の .lead-chips）。 */
function Small() {
  return (
    <div id="small" style={row}>
      <CountChip size="sm" label="変更したファイル" count={7} icon="fileEdited" expanded={false} onClick={noop} />
      <CountChip size="sm" label="アーティファクト" count={1} icon="artifacts" expanded onClick={noop} />
      <CountChip size="sm" label="確認待ち" count={2} tone="cand" />
    </div>
  );
}

const PERMS = ['既定', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask"];

/** 新しいセッションの札の列（試作 N2 の .set-row）。権限モードの札は、開いた先をポップオーバーで出す。 */
function Settings() {
  return (
    <div id="settings" style={row}>
      <SettingChip name="プロジェクト" value="web-shop" icon="folder" onClick={noop} aria-haspopup="dialog" aria-expanded={false} />
      <SettingChip name="モデル" value="opus" showName onClick={noop} />
      <SettingChip name="effort レベル" value="high" showName onClick={noop} />
      <Popover label="権限モード" width={240} align="start" defaultOpen={open === 'perm'}
        face={(p) => <SettingChip name="権限モード" value="Accept edits" showName {...p} />}>
        <div className="pop-title" style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-3)' }}>権限モード</div>
        {PERMS.map((x) => <button key={x} type="button" className="menu-item"><span className="menu-item-text"><span>{x}</span></span></button>)}
      </Popover>
      <SettingChip name="worktree" value="なし" showName tone="muted" onClick={noop} />
      <SettingChip name="権限モード" value="Bypass permissions" showName tone="danger" onClick={noop} />
    </div>
  );
}

/** 見出しの右端の (i)（試作 C 案の popC）。行は試作の文のまま。 */
function InfoHeader() {
  const rows = [
    { name: 'モデル', value: 'opus', mono: true },
    { name: 'effort レベル', value: 'high', mono: true },
    { name: '権限モード', value: 'Accept edits', mono: true },
    { name: '開始', value: '今日 08:52', mono: true },
    { name: '作業ディレクトリ', value: '~/code/web-shop', mono: true },
    { name: 'アカウント', value: '仕事用', mono: true },
    { name: '起動', value: '新しいセッション · 08:52', mono: true },
  ];
  return (
    <div id="info" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44 }}>
      <b style={{ fontSize: 'var(--fs-md)' }}>金額の上限のテストを足す</b>
      <span style={{ flex: 1 }} />
      <InfoPopover rows={rows} defaultOpen={open === 'info'} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
    <h1 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>部品の試験用の頁</h1>
    <section style={card}><h2 style={h2}>数の札（ホームの帯）</h2><Band /></section>
    <section style={card}><h2 style={h2}>数の札（小さい）</h2><Small /></section>
    <section style={card}><h2 style={h2}>設定の札（新しいセッション）</h2><Settings /></section>
    <section style={card}><h2 style={h2}>見出しの (i)</h2><InfoHeader /></section>
  </div>,
);
