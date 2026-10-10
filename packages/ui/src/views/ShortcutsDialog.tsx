import { useEmit } from '../action/chain.tsx';
import { bindingLabel, displayKeys, GROUP_KEY, isMacClient, KEYMAP, terminalKeysLabel, type KeyGroup } from '../keys.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { useT } from './primitives/language.tsx';

const GROUPS: KeyGroup[] = ['global', 'session', 'list'];

/**
 * キーボードショートカットの一覧。
 * 並ぶ中身は照合に使うのと同じ `KEYMAP` なので、実装と覚え書きがずれない。
 * macOS の外では、ターミナルの中で使う打鍵（Ctrl+Shift+<キー>）の欄を足す。macOS はターミナルの中でも同じ ⌘ の打鍵なので足さない。
 */
export function ShortcutsDialog() {
  const emit = useEmit();
  const t = useT();
  const mac = isMacClient();
  return (
    <Dialog title={t('shortcuts.dialog.title')} className="dialog-wide" onClose={() => emit({ type: 'overlay.close' })}>
      {!mac && (
        <div className="keys-row keys-head faint" data-terminal="">
          <span>{t('shortcuts.dialog.columnKeys')}</span>
          <span>{t('shortcuts.dialog.columnTerminal')}</span>
          <span>{t('shortcuts.dialog.columnAction')}</span>
        </div>
      )}
      {GROUPS.map((g) => (
        <div key={g} className="keys-group">
          <div className="faint">{t(GROUP_KEY[g])}</div>
          {KEYMAP.filter((b) => b.group === g).map((b) => (
            <div key={b.id} className="keys-row" data-terminal={mac ? undefined : ''}>
              <span className="mono">{displayKeys(b, mac)}</span>
              {!mac && <span className="mono">{terminalKeysLabel(b, mac) ?? <span className="faint" aria-hidden="true">—</span>}</span>}
              <span>{bindingLabel(t, b, mac)}</span>
            </div>
          ))}
        </div>
      ))}
      {/* ターミナルは打鍵の持ち主が違うので、一覧の下に一言添える。 */}
      <div className="faint">{t(mac ? 'shortcuts.dialog.terminalNote' : 'shortcuts.dialog.terminalNoteCtrl')}</div>
    </Dialog>
  );
}
