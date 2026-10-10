import { useEmit } from '../action/chain.tsx';
import { bindingLabel, GROUP_KEY, isMacClient, keyLabel, KEYMAP, type KeyGroup } from '../keys.ts';
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
  const mac = isMacClient();
  return (
    <Dialog title={t('shortcuts.dialog.title')} className="dialog-wide" onClose={() => emit({ type: 'overlay.close' })}>
      {GROUPS.map((g) => (
        <div key={g} className="keys-group">
          <div className="faint">{t(GROUP_KEY[g])}</div>
          {KEYMAP.filter((b) => b.group === g).map((b) => (
            <div key={b.id} className="keys-row">
              <span className="mono">{keyLabel(b.keys, mac)}</span>
              <span>{bindingLabel(t, b, mac)}</span>
            </div>
          ))}
        </div>
      ))}
      {/* ターミナルは打鍵の持ち主が違うので、一覧の下に一言添える。 */}
      {/* macOS の外には ⌘ が無く、Ctrl の打鍵はターミナルのものなので、ターミナルの中ではこの画面の操作が効かない（Root.tsx）。 */}
      <div className="faint">{t(mac ? 'shortcuts.dialog.terminalNote' : 'shortcuts.dialog.terminalNoteCtrl')}</div>
    </Dialog>
  );
}
