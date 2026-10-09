import { useEmit } from '../intent/chain.tsx';
import { GROUP_KEY, KEYMAP, type KeyGroup } from '../keys.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { useT } from './primitives/language.tsx';

const GROUPS: KeyGroup[] = ['global', 'session', 'list'];

/**
 * キーボードショートカットの一覧。
 * 並ぶ中身は照合に使うのと同じ `KEYMAP` なので、実装と覚え書きがずれない。
 */
export function ShortcutsDialog() {
  const emit = useEmit();
  const t = useT();
  return (
    <Dialog title={t('shortcuts.dialog.title')} className="dialog-wide" onClose={() => emit({ type: 'overlay.close' })}>
      {GROUPS.map((g) => (
        <div key={g} className="keys-group">
          <div className="faint">{t(GROUP_KEY[g])}</div>
          {KEYMAP.filter((b) => b.group === g).map((b) => (
            <div key={b.id} className="keys-row">
              <span className="mono">{b.keys}</span>
              <span>{t(b.labelKey)}</span>
            </div>
          ))}
        </div>
      ))}
      {/* ターミナルは打鍵の持ち主が違うので、一覧の下に一言添える。 */}
      <div className="faint">{t('shortcuts.dialog.terminalNote')}</div>
    </Dialog>
  );
}
