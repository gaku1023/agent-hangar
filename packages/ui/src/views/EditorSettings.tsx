import { Fragment, useEffect, useState } from 'react';
import { customArgv, dirCommandOf, previewCommand, type EditorId, type EditorTerminal } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { SaveMark } from '../mediator/types.ts';
import type { EditorChoice, EditorSettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { SetRow } from './primitives/SetRow.tsx';

/** 任意のコマンドの例。押すとファイルのコマンドの欄に入る。 */
const EXAMPLES = ['subl {path}:{line}', 'nvim +{line} {path}', 'hx {path}:{line}', 'emacsclient -n +{line} {path}', 'fleet {path}'];
const PATH_TOKEN = '{path}';
const LINE_TOKEN = '{line}';

/** 見本に使うパス。画面を開いている OS の形にする。 */
const SAMPLE = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
  ? { file: 'C:\\Users\\you\\work\\alpha\\src\\app.ts', dir: 'C:\\Users\\you\\work\\alpha' }
  : { file: '~/work/alpha/src/app.ts', dir: '~/work/alpha' };

/** 1 つの候補の行（ラジオの行）。選んだ行だけ「テスト」を持つ。 */
function Choice(props: { c: EditorChoice; loading: boolean; testing: boolean; onPick: (id: EditorId) => void; onTest: () => void }) {
  const t = useT();
  const { c } = props;
  return (
    <div className="editor-choice" role="radio" aria-checked={c.selected} tabIndex={c.selected ? 0 : -1}
      onClick={() => props.onPick(c.id)}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); props.onPick(c.id); } }}>
      <span className="editor-radio" aria-hidden="true" />
      <span className="editor-tile" aria-hidden="true">{c.tile}</span>
      <span className="editor-choice-main">
        <span className="editor-choice-name">{c.name}{c.version && <span className="faint num editor-choice-ver">{c.version}</span>}</span>
        <span className="editor-choice-path mono" title={c.path ?? undefined}>{c.path ?? (c.id === 'custom' ? '' : '—')}</span>
      </span>
      {c.badge ? <span className="badge" data-tone={c.badge.tone === 'mute' ? 'off' : c.badge.tone}>{c.badge.text}</span> : props.loading && c.id !== 'custom' ? <span className="faint editor-choice-wait">{t('settings.editor.checking')}</span> : <span />}
      {c.selected
        ? <button type="button" className="btn btn-sm" disabled={props.testing} onClick={(e) => { e.stopPropagation(); props.onTest(); }}><Icon name="play" />{t('settings.editor.test.run')}</button>
        : <span />}
    </div>
  );
}

/**
 * 任意のコマンドの欄（試作の 1-4 の A）。2 つの欄と、打つそばから変わる見本。
 * 欄を出たら保存する。{path} が無ければ保存せず、欄の下に言う（サーバも断る）。
 */
function CustomCommand(props: { fileCmd: string; dirCmd: string; terminal: EditorTerminal; save: (patch: { fileCmd?: string; dirCmd?: string; terminal?: EditorTerminal }) => void }) {
  const t = useT();
  const [file, setFile] = useState(props.fileCmd);
  const [dir, setDir] = useState(props.dirCmd);
  useEffect(() => { setFile(props.fileCmd); }, [props.fileCmd]);
  useEffect(() => { setDir(props.dirCmd); }, [props.dirCmd]);
  const okPath = file.includes(PATH_TOKEN);
  const commit = (next: { fileCmd?: string; dirCmd?: string }) => {
    const f = (next.fileCmd ?? file).trim();
    const d = (next.dirCmd ?? dir).trim();
    if (!f.includes(PATH_TOKEN) || (d !== '' && !d.includes(PATH_TOKEN))) return;
    if (f === props.fileCmd && d === props.dirCmd) return;
    props.save({ fileCmd: f, dirCmd: d });
  };
  const fileArgv = customArgv({ fileCmd: file, dirCmd: dir }, { path: SAMPLE.file, line: 42, dir: false });
  const dirArgv = customArgv({ fileCmd: file, dirCmd: dir }, { path: SAMPLE.dir, line: null, dir: true });
  const empty = t('settings.editor.preview.empty');
  return (
    <div className="editor-custom">
      <p className="faint editor-custom-desc">{t('settings.editor.cmd.desc', { pathToken: PATH_TOKEN, lineToken: LINE_TOKEN })}</p>
      <label className="field">
        <span>{t('settings.label.editorFileCmd')}</span>
        <input className="input mono" value={file} spellCheck={false} autoComplete="off" onChange={(e) => setFile(e.target.value)} onBlur={() => commit({})}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); commit({}); } }} />
      </label>
      <div className="editor-tokens">
        {[PATH_TOKEN, LINE_TOKEN].map((tok) => (
          <button key={tok} type="button" className="editor-token mono" aria-label={t('settings.editor.cmd.insert', { token: tok })} onClick={() => { const next = `${file.trimEnd()} ${tok}`.trim(); setFile(next); commit({ fileCmd: next }); }}>{tok}</button>
        ))}
        <span className="faint">{t('settings.editor.cmd.examples')}</span>
        {EXAMPLES.map((x) => <button key={x} type="button" className="btn-link mono editor-example" onClick={() => { setFile(x); setDir(''); commit({ fileCmd: x, dirCmd: '' }); }}>{x}</button>)}
      </div>
      {!okPath && <span className="verify" data-tone="ng"><Icon name="close" />{t('settings.editor.cmd.noPath', { token: PATH_TOKEN })}</span>}
      <label className="field">
        <span>{t('settings.editor.cmd.dirLabel')}</span>
        <input className="input mono" value={dir} placeholder={dirCommandOf(file)} spellCheck={false} autoComplete="off" onChange={(e) => setDir(e.target.value)} onBlur={() => commit({})}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); commit({}); } }} />
      </label>
      <div className="field">
        <span>{t('settings.editor.cmd.terminal')}</span>
        <Segmented label={t('settings.editor.cmd.terminal')} size="sm" value={props.terminal}
          options={(['none', 'shell', 'ext'] as const).map((v) => ({ value: v, label: t(`settings.editor.terminal.${v}`) }))}
          onChange={(v) => props.save({ terminal: v as EditorTerminal })} />
      </div>
      <pre className="editor-preview mono" aria-live="polite">
        <span className="editor-preview-c">{t('settings.editor.preview.file', { line: 42 })}</span>{'\n'}
        {fileArgv ? previewCommand(fileArgv) : empty}{'\n'}
        <span className="editor-preview-c">{t('settings.editor.preview.dir')}</span>{'\n'}
        {dirArgv ? previewCommand(dirArgv) : empty}
        {props.terminal !== 'none' && <>{'\n'}<span className="editor-preview-c">{t(props.terminal === 'shell' ? 'settings.editor.preview.shell' : 'settings.editor.preview.ext')}</span></>}
      </pre>
    </div>
  );
}

/**
 * 設定の一般の節のエディタの欄（試作の 1-1 の A）。
 * この PC で見つけたエディタを候補の一覧で並べ、選んだ時点で保存する。
 * 場所は「パスを指定…」に畳み、ふだんは自動で見つけた場所を使う。テストは見本のファイルを 3 行目で開く。
 */
export function EditorSettings(props: { editor: EditorSettingsProps; mark: SaveMark | undefined }) {
  const emit = useEmit();
  const t = useT();
  const e = props.editor;
  const [pathOpen, setPathOpen] = useState(e.setting.path !== null);
  const [path, setPath] = useState(e.setting.path ?? '');
  useEffect(() => { setPath(e.setting.path ?? ''); }, [e.setting.path]);
  // 一般の節を開いたら、候補の一覧を読み直す（入れ直した直後でも合うように）。
  useEffect(() => { emit({ type: 'editors.load' }); }, [emit]);
  const save = (patch: Partial<EditorSettingsProps['setting']>) => emit({ type: 'settings.update', patch: { editor: { ...e.setting, ...patch } }, field: 'editor' });
  const pick = (id: EditorId) => {
    if (id === e.setting.id) return;
    // 別のエディタへ移るときは、前のエディタのパスを持ち越さない。
    save({ id, path: null });
    emit({ type: 'editors.load' });
  };
  const savePath = () => {
    const next = path.trim();
    if (next === (e.setting.path ?? '')) return;
    save({ path: next === '' ? null : next });
  };
  const error = props.mark?.kind === 'error' ? props.mark.message : null;
  const testText = e.test.running ? t('settings.editor.test.running', { name: e.name ?? t('external.editor.generic') }) : null;
  const r = e.test.result;
  const testResult = testText
    ? <div className="editor-result" role="status">{testText}</div>
    : r ? <div className="editor-result" data-tone={r.tone} role="status"><Icon name={r.tone === 'ng' ? 'close' : r.tone === 'warn' ? 'alert' : 'check'} />{r.text}</div> : null;
  return (
    <SetRow id="settings-field-editor" title={t('settings.editor.title')} desc={t('settings.editor.desc')}
      control={<button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'editors.load' })}><Icon name="recheck" />{t('settings.editor.recheck')}</button>}
      below={(
        <div className="editor-settings">
          {/* テストの答えは、選んだ行（テストのボタン）のすぐ下に出す。欄の下端に出すと、右下の知らせの札に隠れることがあるためである。 */}
          <div className="editor-choices" role="radiogroup" aria-label={t('settings.editor.title')}>
            {e.choices.map((c) => (
              <Fragment key={c.id}>
                <Choice c={c} loading={e.loading} testing={e.test.running} onPick={pick} onTest={() => emit({ type: 'editor.test' })} />
                {c.selected && testResult}
              </Fragment>
            ))}
          </div>
          {e.setting.id === 'custom'
            ? <CustomCommand fileCmd={e.setting.fileCmd} dirCmd={e.setting.dirCmd} terminal={e.setting.terminal} save={(p) => save(p)} />
            : (
              <div className="editor-path">
                <button type="button" className="btn-link" aria-expanded={pathOpen} onClick={() => setPathOpen(!pathOpen)}>{t(pathOpen ? 'settings.editor.pathClose' : 'settings.editor.pathOpen')}</button>
                {pathOpen && (
                  <label className="field">
                    <span>{t('settings.editor.pathLabel', { name: e.name ?? '' })}</span>
                    <input className="input mono" value={path} spellCheck={false} autoComplete="off" onChange={(ev) => setPath(ev.target.value)} onBlur={savePath}
                      onKeyDown={(ev) => { if (ev.key === 'Enter' && !isComposing(ev)) { ev.preventDefault(); savePath(); } }} />
                    <span className="faint editor-path-hint">{t('settings.editor.pathHint')}</span>
                  </label>
                )}
              </div>
            )}
          {error && <span className="verify" data-tone="ng" role="alert"><Icon name="close" />{error}</span>}
        </div>
      )} />
  );
}
