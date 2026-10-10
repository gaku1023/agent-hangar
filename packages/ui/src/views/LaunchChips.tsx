import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { isComposing } from './ime.ts';
import { SettingChip } from './primitives/Chip.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { MenuButton } from './primitives/MenuButton.tsx';
import { PermissionList } from './primitives/PermissionList.tsx';
import { PERMISSION_BYPASS, PERMISSION_DEFAULT, permissionLabel } from './primitives/permissionModel.ts';
import { PickList, type PickItem } from './primitives/PickList.tsx';
import { Popover } from './primitives/Popover.tsx';

/** 札の列が持つ値。空は「既定」で、起動の params に含めない。addDirs は 1 行に 1 つの文字で持つ（起動ダイアログと同じ）。 */
export type LaunchChipValues = { model: string; effort: string; permissionMode: string; worktree: string; name: string; addDirs: string };

/** アカウントの札の選択肢。color は色の点、disabled は選べないもので、理由は tag に書く（未ログインなど）。 */
export type LaunchAccountOption = { value: string; label: string; color?: string; disabled?: boolean; tag?: string };

const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
/** 「＋」から足せる札。並びはここの順で、足した順ではない。 */
const EXTRAS = ['name', 'addDirs'] as const;
type Extra = (typeof EXTRAS)[number];

const dirCount = (text: string) => text.split('\n').filter((d) => d.trim()).length;

/** 札と、押すと開く小さい面。面の見出しは札の名前で、開く元は SettingChip である。 */
function ChipPopover(props: { name: string; value: string; tone?: 'default' | 'muted' | 'danger'; icon?: IconName; dot?: string; showName?: boolean; width?: number; defaultOpen?: boolean; children: (close: () => void) => ReactNode }) {
  return (
    <Popover label={props.name} width={props.width ?? 240} align="start" className="launch-pop" defaultOpen={props.defaultOpen}
      face={(p) => <SettingChip name={props.name} value={props.value} showName={props.showName ?? true} tone={props.tone} icon={props.icon} dot={props.dot} {...p} />}>
      {({ close }) => (
        <>
          <div className="pick-head">{props.name}</div>
          {props.children(close)}
        </>
      )}
    </Popover>
  );
}

/** 一行の入力。Enter で決めて閉じ、外（起動のダイアログ）へは伝えない。変換を確定する Enter では閉じない。 */
function TextEditor(props: { name: string; placeholder: string; value: string; onChange: (v: string) => void; close: () => void; mono?: boolean }) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    props.close();
  };
  return <input className={`input launch-input${props.mono ? ' mono' : ''}`} data-autofocus="true" aria-label={props.name} placeholder={props.placeholder} value={props.value} onChange={(e) => props.onChange(e.target.value)} onKeyDown={onKeyDown} />;
}

/**
 * モデルの一覧と、一覧に無い名前の入力欄。一覧にある値のときは欄を空にしておく。
 * 欄は打つたびに値を渡す（Enter を押さずに外を押して閉じても残る）。Enter は閉じるだけである。
 */
function ModelEditor(props: { value: string; onChange: (v: string) => void; close: () => void }) {
  const t = useT();
  const listed = MODELS.includes(props.value);
  const [other, setOther] = useState(listed ? '' : props.value);
  const items: PickItem[] = MODELS.map((m) => ({ value: m, label: m || t('launch.value.default') }));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    props.close();
  };
  return (
    <>
      <PickList label={t('launch.chip.model')} value={listed ? props.value : ''} items={items} onPick={(v) => { props.onChange(v); props.close(); }} />
      <input className="input launch-input mono" aria-label={t('launch.edit.modelOther')} placeholder={t('launch.edit.modelOther')} value={other} onChange={(e) => { setOther(e.target.value); props.onChange(e.target.value); }} onKeyDown={onKeyDown} />
    </>
  );
}

/**
 * 新しいセッションの札の列（N2）。プロジェクト、アカウント、モデル、effort レベル、権限モード、worktree を 1 行に並べ、最後に「＋」を置く。
 * 札には値が常に見え、押すと小さい一覧か入力欄が開く。既定のままの札は薄く、Bypass permissions の札は赤い縁と警告の印になる。
 * 名前と追加ディレクトリは「＋」から足す札で、押すと札が増えて入力欄が開く。値が入っているとき（下書き、前回の値）は、はじめから出す。
 * 札は一度出したら、値を消しても残す。打っている途中で札が消えないようにするためである。
 * 札の名前は用語集のとおりで、幅が足りなければ折り返す（短い語に替えない）。
 * lead は先頭の札（プロジェクト。呼ぶ側の Listbox が描く）、account はアカウントが 2 件以上あるときだけ渡す。
 * 値は props で受け、変えるたびに onChange へ変えた欄だけを渡す。
 */
export function LaunchChips(props: {
  values: LaunchChipValues;
  onChange: (patch: Partial<LaunchChipValues>) => void;
  lead?: ReactNode;
  account?: { value: string; options: LaunchAccountOption[]; onChange: (value: string) => void };
  /** 前回の権限モード。一覧のその行に「前回」を添える。 */
  previousPermission?: string;
}) {
  const t = useT();
  const { values, onChange } = props;
  // 一度出した札の集まり。値が入った札は、描きながら足す。
  const [added, setAdded] = useState<Set<Extra>>(() => new Set(EXTRAS.filter((k) => values[k].trim() !== '')));
  const arrived = EXTRAS.filter((k) => values[k].trim() !== '' && !added.has(k));
  if (arrived.length) setAdded(new Set([...added, ...arrived]));
  // 「＋」から足した札は、開いた状態で出す（入力欄へ焦点を送る）。
  const [fresh, setFresh] = useState<Extra | null>(null);
  const add = (k: Extra) => { setFresh(k); setAdded(new Set([...added, k])); };

  const none = t('launch.value.none');
  const def = t('launch.value.default');
  const bypass = values.permissionMode === PERMISSION_BYPASS;
  const account = props.account;
  const accountNow = account?.options.find((o) => o.value === account.value);
  const accountLabel = account ? accountNow?.label ?? account.value : '';
  const names: Record<Extra, string> = { name: t('launch.chip.name'), addDirs: t('launch.chip.addDirs') };
  const extraItems = EXTRAS.filter((k) => !added.has(k)).map((k) => ({ key: k, label: names[k], onSelect: () => add(k) }));

  return (
    <div className="launch-chips" role="group" aria-label={t('launch.chips.label')}>
      {props.lead}
      {account && (
        <ChipPopover name={t('launch.chip.account')} value={accountLabel} dot={accountNow?.color} showName={false} width={260}>
          {(close) => (
            <PickList label={t('launch.chip.account')} value={account.value}
              items={account.options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled, tag: o.tag, lead: o.color ? <span className="st-dot" style={{ color: o.color }} aria-hidden="true" /> : undefined }))}
              onPick={(v) => { account.onChange(v); close(); }} />
          )}
        </ChipPopover>
      )}
      <ChipPopover name={t('launch.chip.model')} value={values.model || def} tone={values.model ? 'default' : 'muted'}>
        {(close) => <ModelEditor value={values.model} onChange={(v) => onChange({ model: v })} close={close} />}
      </ChipPopover>
      <ChipPopover name={t('launch.chip.effort')} value={values.effort || def} tone={values.effort ? 'default' : 'muted'}>
        {(close) => (
          <PickList label={t('launch.chip.effort')} value={values.effort}
            items={EFFORTS.map((e, i) => ({ value: e, label: e || def, lead: e ? <EffortBars level={i} /> : undefined }))}
            onPick={(v) => { onChange({ effort: v }); close(); }} />
        )}
      </ChipPopover>
      <ChipPopover name={t('launch.permission.label')} value={permissionLabel(values.permissionMode, t)} tone={bypass ? 'danger' : values.permissionMode === PERMISSION_DEFAULT ? 'muted' : 'default'} icon={bypass ? 'warning' : undefined}>
        {(close) => <PermissionList value={values.permissionMode} previous={props.previousPermission} onChange={(v) => { onChange({ permissionMode: v }); close(); }} />}
      </ChipPopover>
      <ChipPopover name={t('launch.chip.worktree')} value={values.worktree.trim() || none} tone={values.worktree.trim() ? 'default' : 'muted'} width={280}>
        {(close) => <TextEditor name={t('launch.chip.worktree')} placeholder={t('launch.edit.worktreePlaceholder')} value={values.worktree} onChange={(v) => onChange({ worktree: v })} close={close} mono />}
      </ChipPopover>
      {added.has('name') && (
        <ChipPopover name={names.name} value={values.name.trim() || none} tone={values.name.trim() ? 'default' : 'muted'} width={280} defaultOpen={fresh === 'name'}>
          {(close) => <TextEditor name={names.name} placeholder={t('launch.edit.namePlaceholder')} value={values.name} onChange={(v) => onChange({ name: v })} close={close} />}
        </ChipPopover>
      )}
      {added.has('addDirs') && (
        <ChipPopover name={names.addDirs} value={dirCount(values.addDirs) ? t('launch.value.dirCount', { n: dirCount(values.addDirs) }) : none} tone={dirCount(values.addDirs) ? 'default' : 'muted'} width={320} defaultOpen={fresh === 'addDirs'}>
          {() => (
            <>
              <textarea className="input launch-input mono" data-autofocus="true" rows={3} aria-label={names.addDirs} value={values.addDirs} onChange={(e) => onChange({ addDirs: e.target.value })} />
              <div className="launch-hint">{t('launch.edit.addDirsHint')}</div>
            </>
          )}
        </ChipPopover>
      )}
      {extraItems.length > 0 && <MenuButton label={t('launch.add.label')} title={t('launch.add.label')} items={extraItems} face={<Icon name="add" />} faceClassName="set-add" minWidth={200} align="start" />}
    </div>
  );
}

/** effort の強さを 5 段の棒で添える。 */
function EffortBars(props: { level: number }) {
  return <span className="effort-bars" aria-hidden="true">{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={i <= props.level ? 'true' : undefined} />)}</span>;
}
