import { useRef, useState, type KeyboardEvent } from 'react';
import type { LaunchParams } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { ChoiceChips } from './primitives/Chip.tsx';
import { Fold } from './primitives/Fold.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import type { ListboxOption } from './primitives/listboxModel.ts';
import { OptionCards, type OptionCardItem } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';

// 値は claude --help の --model の別名、--effort と --permission-mode の選択肢に合わせる。
// 空の値は「既定」で、params に含めず利用者の Claude Code の設定に従わせる。
const MODELS = [{ value: '', label: '既定' }, { value: 'fable', label: 'fable' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }, { value: 'haiku', label: 'haiku' }];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSIONS: OptionCardItem[] = [
  { value: '', label: '既定', description: 'Claude Code の設定に従う', icon: 'permissionDefault' },
  { value: 'manual', label: '都度たずねる', description: '編集もコマンドも確認する', code: 'manual', icon: 'permissionManual' },
  { value: 'acceptEdits', label: '編集は任せる', description: 'ファイルの編集は確認しない', code: 'acceptEdits', icon: 'permissionAcceptEdits' },
  { value: 'plan', label: '計画だけ', description: '読むだけで何も変えない', code: 'plan', icon: 'permissionPlan' },
  { value: 'auto', label: '自動', description: '安全なものは自動で許す', code: 'auto', icon: 'permissionAuto' },
  { value: 'dontAsk', label: 'たずねずに断る', description: '許可済みのもの以外は断る', code: 'dontAsk', icon: 'permissionDontAsk' },
  { value: 'bypassPermissions', label: '確認なし', description: 'すべて確認せずに実行する', code: 'bypassPermissions', icon: 'permissionBypass', danger: true },
];

/** effort の強さを 5 段の棒で添える。既定には付けない。 */
function EffortBars(props: { level: number }) {
  return <span className="effort-bars">{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={i <= props.level ? 'true' : undefined} />)}</span>;
}
const EFFORT_OPTIONS = EFFORTS.map((e, i) => ({ value: e, label: e || '既定', lead: e ? <EffortBars level={i} /> : undefined }));

/** プロジェクトの一覧の先頭に置くスクラッチの行。値はプロジェクトの id と重ならない綴りにする。 */
const SCRATCH = ':scratch';
const SCRATCH_OPTION: ListboxOption = { value: SCRATCH, label: 'スクラッチ', sub: '名前は決めずに始めて、あとでプロジェクトに昇格できる', subKind: 'prose', faceSub: '~/.agent-hangar/scratch/<日時>/', icon: 'scratch' };

/**
 * 起動ダイアログ。必須はプロジェクトだけで、空欄と既定は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * プロジェクト、model、effort、permission mode はここの状態で持つ。詳細の見出しに、選んだ値を送信の前から出すため。
 * スクラッチはプロジェクトの一覧の先頭の 1 行として選ぶ。props.scratch は開いたときにその行を選んでおくかどうかである。
 * 名前、初期プロンプト、worktree、追加ディレクトリは非制御のまま、送信のときにフォームから読む。
 * プロジェクトが未選択のまま送っても止めない。未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const form = useRef<HTMLFormElement>(null);
  const [choice, setChoice] = useState(() => {
    // サーバも scratch を projectId より優先する。
    if (props.scratch) return SCRATCH;
    return props.projectId && props.projects.some((p) => p.id === props.projectId) ? props.projectId : '';
  });
  const scratch = choice === SCRATCH;
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');

  const submit = () => {
    if (props.submitting || !form.current) return;
    const data = new FormData(form.current);
    const text = (key: string): string => { const v = data.get(key); return typeof v === 'string' ? v.trim() : ''; };
    const params: LaunchParams = {};
    // スクラッチはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (scratch) params.scratch = true;
    else if (choice) params.projectId = choice;
    for (const key of ['name', 'prompt'] as const) { const v = text(key); if (v) params[key] = v; }
    if (model.trim()) params.model = model.trim();
    if (effort) params.effort = effort;
    if (permissionMode) params.permissionMode = permissionMode;
    const worktree = text('worktree'); if (worktree) params.worktree = worktree;
    const dirs = text('addDirs').split('\n').map((d) => d.trim()).filter(Boolean);
    if (dirs.length) params.addDirs = dirs;
    emit({ type: 'session.new.submit', params });
  };

  // Esc で閉じ、Enter で起動する。
  // 変換中の Enter は確定のための打鍵なので、起動に使わない。
  // 一覧を開いている間の Esc と Enter は、Listbox が止めるのでここまで来ない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { emit({ type: 'overlay.close' }); return; }
    if (e.key !== 'Enter' || isComposing(e)) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    // 選択の部品、ボタン、詳細の見出しの Enter は、その部品の操作である。起動には使わない。
    if ((e.target as HTMLElement).closest('button, summary, [role="radio"]')) return;
    e.preventDefault();
    submit();
  };

  const recent = new Set(props.recentIds);
  const options = [SCRATCH_OPTION, ...props.projects.map((p) => ({ value: p.id, label: p.name, sub: p.path ?? undefined, meta: p.lastActivity || undefined, status: p.status }))];
  const groups = [{ title: 'すぐ始める', values: [SCRATCH] }, { title: '最近', values: props.recentIds }, { title: 'すべて', values: props.projects.filter((p) => !recent.has(p.id)).map((p) => p.id) }];
  const chosen = [model.trim(), effort, PERMISSIONS.find((p) => p.value && p.value === permissionMode)?.label].filter(Boolean);
  // 区切りに全角空白を使わない。読み上げと試験の正規化で空白が詰められ、見た目と一致しなくなるため。
  const foldSummary = chosen.length ? `詳細（${chosen.join('、')}）` : '詳細（model、effort、permission mode、worktree、追加ディレクトリ）';

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="新しいセッション" onKeyDown={onKeyDown}>
      <form ref={form} className="dialog dialog-wide" onSubmit={(e) => e.preventDefault()}>
        <b>{scratch ? 'スクラッチで始める' : '新しいセッション'}</b>
        <div className="field">
          <span aria-hidden="true">プロジェクト</span>
          <Listbox id="new-session-project" label="プロジェクト" value={choice || null} options={options} groups={groups} onChange={setChoice} showSubInFace searchPlaceholder="名前かパスで探す" minWidth={360} />
        </div>
        {scratch && <div className="faint">~/.agent-hangar/scratch/ の下に日時のディレクトリを作って起動します。後からプロジェクトに昇格できます。</div>}
        <label className="field" htmlFor="new-session-name">名前（任意）
          <input id="new-session-name" className="input" name="name" defaultValue="" placeholder="一覧での表示名" />
        </label>
        <label className="field" htmlFor="new-session-prompt">初期プロンプト（任意）
          <textarea id="new-session-prompt" className="input" name="prompt" rows={4} defaultValue="" />
        </label>
        <Fold summary={foldSummary}>
          <div className="launch-options">
            <span className="launch-option-label" aria-hidden="true">model</span>
            <ChoiceChips label="model" value={model} options={MODELS} onChange={setModel} other={{ label: 'ほか', placeholder: 'model の名前' }} />
            <span className="launch-option-label" aria-hidden="true">effort</span>
            <div><Segmented label="effort" value={effort} options={EFFORT_OPTIONS} onChange={setEffort} size="xs" /></div>
            <span className="launch-option-label launch-option-label-top" aria-hidden="true">permission</span>
            <div>
              <OptionCards label="permission mode" value={permissionMode} options={PERMISSIONS} onChange={setPermissionMode} />
              {permissionMode === 'bypassPermissions' && <div className="error launch-danger">ファイルの削除やコマンドも、確認せずに実行します</div>}
            </div>
          </div>
          <label className="field" htmlFor="new-session-worktree">worktree
            <input id="new-session-worktree" className="input mono" name="worktree" defaultValue="" placeholder="空なら通常の作業ディレクトリ" />
          </label>
          <label className="field" htmlFor="new-session-add-dirs">追加ディレクトリ（1 行 1 つ）
            <textarea id="new-session-add-dirs" className="input mono" name="addDirs" rows={2} defaultValue="" />
          </label>
        </Fold>
        <div className="faint">新しいディレクトリでは Claude が信頼確認のダイアログを出します。起動したあとにターミナルで答えてください。</div>
        {props.error && <div className="error" role="alert">{props.error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={submit}>{props.submitting ? '起動しています' : '起動'}</button>
        </div>
      </form>
    </div>
  );
}
