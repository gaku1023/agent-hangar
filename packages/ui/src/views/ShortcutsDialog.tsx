import { useEmit } from '../intent/chain.tsx';
import { GROUP_LABEL, KEYMAP, type KeyGroup } from '../keys.ts';

const GROUPS: KeyGroup[] = ['global', 'session', 'list'];

/**
 * キーの一覧。
 * 並ぶ中身は照合に使うのと同じ `KEYMAP` なので、実装と覚え書きがずれない。
 */
export function ShortcutsDialog() {
  const emit = useEmit();
  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-label="キーボード" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title">キーボード</b>
        {GROUPS.map((g) => (
          <div key={g} className="keys-group">
            <div className="faint">{GROUP_LABEL[g]}</div>
            {KEYMAP.filter((b) => b.group === g).map((b) => (
              <div key={b.id} className="keys-row">
                <span className="mono">{b.keys}</span>
                <span>{b.label}</span>
              </div>
            ))}
          </div>
        ))}
        {/* ターミナルは打鍵の持ち主が違うので、一覧の下に一言添える。 */}
        <div className="faint">ターミナルに文字を打っている間は、⌘ の付いた打鍵だけをこの画面が受け取ります。</div>
      </div>
    </div>
  );
}
