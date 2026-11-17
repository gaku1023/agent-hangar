import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isVoicePatch, NEW_PERSONA_READING, VOICE_STYLE_NORMAL, type VoiceCatalog, type VoiceMode, type VoicePersona, type VoiceSetting, type VoiceSourceId } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { SaveMark } from '../mediator/types.ts';
import type { VoiceSettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { FoldBox } from './primitives/FoldBox.tsx';
import { useLanguage, useT } from './primitives/language.tsx';
import { collapseOut, growIn } from './primitives/motionKit.ts';
import { Segmented } from './primitives/Segmented.tsx';
import { SetRow } from './primitives/SetRow.tsx';

const MAX_PERSONAS = 8;
/** 文字を打ち終えたとみなす間。blur か、この間のどちらか早いほうで保存する。 */
const TYPING_MS = 600;
/** エンジンを起こしたあと、声の一覧を読み直す間隔と回数。 */
const ENGINE_POLL_MS = 1000;
const ENGINE_POLL_TIMES = 10;
const SOURCES: readonly VoiceSourceId[] = ['kokoro', 'voicevox', 'aivis', 'os'];
const ENGINE_SOURCES = ['voicevox', 'aivis'] as const;
type EngineSource = (typeof ENGINE_SOURCES)[number];
const isEngine = (s: VoiceSourceId): s is EngineSource => s === 'voicevox' || s === 'aivis';
const APP_NAME: Record<EngineSource, string> = { voicevox: 'VOICEVOX', aivis: 'AivisSpeech' };

/** 声の id の出どころ。 */
const sourceOfVoice = (voice: string): VoiceSourceId => (voice.startsWith('voicevox:') ? 'voicevox' : voice.startsWith('aivis:') ? 'aivis' : voice.startsWith('os:') ? 'os' : 'kokoro');
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('');
const newId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 話者と声の一言。VOICEVOX のクレジットの形で、スタイルがノーマルなら括弧を付けない。Kokoro は声の名前、Mac の声も名前。 */
const labelOf = (source: VoiceSourceId, speaker: string, style: string, normal: string): string =>
  cut(isEngine(source) ? `${APP_NAME[source]}:${speaker}${style && style !== normal ? `（${style}）` : ''}` : speaker, 40);

/** 行の下の一言。声が一覧から消えていても、選んだときに書き残した voiceLabel を出す。 */
function lineOf(p: VoicePersona): string {
  const src = sourceOfVoice(p.voice);
  const label = src === 'kokoro' ? `Kokoro ${p.voice.replace(/^kokoro:/, '')}` : p.voiceLabel ? p.voiceLabel : p.voice;
  return `${label} · ${p.speed.toFixed(1)}`;
}

/** 声の一覧から、いまの声が当たる話者とスタイル。見つからなければ null（話者の入れ替えで消えた声）。 */
function findVoice(catalog: VoiceCatalog | null, voice: string): { source: VoiceSourceId; speaker: string; styles: Array<{ name: string; voice: string }> } | null {
  for (const s of catalog?.sources ?? []) {
    for (const sp of s.speakers) if (sp.styles.some((st) => st.voice === voice)) return { source: s.id, speaker: sp.name, styles: sp.styles };
  }
  return null;
}

/** 声の欄（試作 X）。出どころの切り替えと、話者・スタイルの選択、止まっているエンジンを開くボタン。 */
function VoiceField(props: { persona: VoicePersona; catalog: VoiceCatalog | null; save: (patch: Partial<VoicePersona>) => void }) {
  const t = useT();
  const emit = useEmit();
  const { persona, catalog } = props;
  const normal = VOICE_STYLE_NORMAL;
  const own = sourceOfVoice(persona.voice);
  // 止まっているエンジンを選んだときの、まだ保存していない出どころ。声は動いているエンジンからしか選べないので、動き出すまで保存しない。
  const [pending, setPending] = useState<EngineSource | null>(null);
  const shown = pending ?? own;
  const entry = (id: VoiceSourceId) => catalog?.sources.find((s) => s.id === id);
  // 一覧がまだ無いうちは、止まっているとは言わない。
  const running = (id: VoiceSourceId) => (catalog ? entry(id)?.running === true : true);
  const pick = (id: VoiceSourceId) => {
    if (id === shown) return;
    if (!running(id)) { setPending(isEngine(id) ? id : null); return; }
    setPending(null);
    const first = entry(id)?.speakers[0];
    const st = first?.styles[0];
    if (first && st) props.save({ voice: st.voice, voiceLabel: labelOf(id, first.name, st.name, normal) });
  };
  // 開いたエンジンが動き出したら、話者の欄に戻して先頭の声に替える。
  const polls = useRef(0);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (pending === null || !running(pending)) return;
    const first = entry(pending)?.speakers[0];
    const st = first?.styles[0];
    setPending(null);
    setWaiting(false);
    if (first && st) props.save({ voice: st.voice, voiceLabel: labelOf(pending, first.name, st.name, normal) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, catalog]);
  useEffect(() => {
    if (!waiting) return;
    polls.current = 0;
    const id = window.setInterval(() => {
      polls.current += 1;
      emit({ type: 'voice.catalog.load' });
      if (polls.current >= ENGINE_POLL_TIMES) { window.clearInterval(id); setWaiting(false); }
    }, ENGINE_POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting, emit]);

  const found = findVoice(catalog, persona.voice);
  const speakers = entry(shown)?.speakers ?? [];
  const styles = found?.source === shown ? found.styles : [];
  const setVoice = (source: VoiceSourceId, speaker: string, style: { name: string; voice: string }) => props.save({ voice: style.voice, voiceLabel: labelOf(source, speaker, style.name, normal) });
  const appButton = pending !== null || (isEngine(shown) && !running(shown));
  const engine = isEngine(shown) ? shown : null;
  return (
    <div className="voice-field">
      <Segmented label={t('settings.voice.source')} size="sm" value={shown}
        options={SOURCES.map((id) => ({ value: id, label: t(`settings.voice.src.${id}`), dim: !running(id) }))}
        onChange={(v) => pick(v as VoiceSourceId)} />
      <div className="voice-pick">
        {appButton && engine
          ? <button type="button" className="btn btn-sm voice-open" disabled={waiting} onClick={() => { emit({ type: 'voice.engine', source: engine }); setWaiting(true); }}>{t('settings.voice.openApp', { app: APP_NAME[engine] })}</button>
          : (
            <>
              <select className="input" aria-label={t('settings.voice.speaker')} value={found && found.source === shown ? found.speaker : ''}
                onChange={(e) => {
                  const sp = speakers.find((x) => x.name === e.target.value);
                  const st = sp?.styles[0];
                  if (sp && st) setVoice(shown, sp.name, st);
                }}>
                {!(found && found.source === shown) && <option value="">{persona.voiceLabel ? persona.voiceLabel : persona.voice}</option>}
                {speakers.map((sp) => <option key={sp.name} value={sp.name}>{sp.name}</option>)}
              </select>
              {styles.length >= 2 && found && (
                <select className="input" aria-label={t('settings.voice.style')} value={persona.voice}
                  onChange={(e) => { const st = styles.find((x) => x.voice === e.target.value); if (st) setVoice(shown, found.speaker, st); }}>
                  {styles.map((st) => <option key={st.voice} value={st.voice}>{st.name}</option>)}
                </select>
              )}
            </>
          )}
      </div>
    </div>
  );
}

/** 人格の中身。名前・読み・口調は打ち終わり（blur か 600ms）、速さは動かして 600ms で保存する。決まりに合わない値は保存しない。 */
function PersonaBody(props: { persona: VoicePersona; voiceOn: boolean; catalog: VoiceCatalog | null; speakingId: string | null; canRemove: boolean; save: (patch: Partial<VoicePersona>) => void; onRemove: () => void }) {
  const t = useT();
  const emit = useEmit();
  const { persona: p } = props;
  const [draft, setDraft] = useState({ name: p.name, reading: p.reading, tone: p.tone, speed: p.speed });
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const latest = useRef({ draft, p, save: props.save });
  latest.current = { draft, p, save: props.save };
  // 外から変わったとき（別の PC の操作、保存の返り）は取り込む。打っている最中は、返ってきた古い値で上書きしない。
  useEffect(() => { if (!dirty.current) setDraft({ name: p.name, reading: p.reading, tone: p.tone, speed: p.speed }); }, [p.name, p.reading, p.tone, p.speed]);
  const flush = (next?: typeof draft) => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    const d = next ?? latest.current.draft;
    const cur = latest.current.p;
    dirty.current = false;
    const candidate = { ...cur, name: d.name.trim(), reading: d.reading.trim(), tone: d.tone.trim(), speed: d.speed };
    if (candidate.name === cur.name && candidate.reading === cur.reading && candidate.tone === cur.tone && candidate.speed === cur.speed) return;
    // 決まりに合わない値（名前が空、読みがひらがなでない、口調が長い）は、保存しない。欄には打った値を残す。
    if (!isVoicePatch({ personas: [candidate] })) return;
    latest.current.save({ name: candidate.name, reading: candidate.reading, tone: candidate.tone, speed: candidate.speed });
  };
  const edit = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    dirty.current = true;
    latest.current.draft = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(), TYPING_MS);
  };
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const playing = props.speakingId !== null && props.speakingId.startsWith('preview-');
  const field = (key: 'name' | 'reading') => (
    <input className="input" aria-label={t(`settings.voice.${key}`)} value={draft[key]} spellCheck={false} autoComplete="off"
      onChange={(e) => edit(key === 'name' ? { name: e.target.value } : { reading: e.target.value })} onBlur={() => flush()}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); flush(); } }} />
  );
  return (
    <div className="voice-body">
      <div className="voice-f"><b>{t('settings.voice.name')}</b>{field('name')}</div>
      <div className="voice-f"><b>{t('settings.voice.reading')}</b>{field('reading')}</div>
      <div className="voice-f top"><b>{t('settings.voice.tone')}</b>
        <textarea className="input" aria-label={t('settings.voice.tone')} placeholder={t('settings.voice.tone.placeholder')} rows={2} value={draft.tone} spellCheck={false}
          onChange={(e) => edit({ tone: e.target.value })} onBlur={() => flush()} />
      </div>
      {props.voiceOn && <div className="voice-f top"><b>{t('settings.voice.voice')}</b><VoiceField persona={p} catalog={props.catalog} save={props.save} /></div>}
      <div className="voice-f"><b>{t('settings.voice.speed')}</b>
        <div className="voice-speed">
          <input type="range" min={0.5} max={2} step={0.1} aria-label={t('settings.voice.speed')} value={draft.speed} onChange={(e) => edit({ speed: Number(e.target.value) })} />
          <span className="voice-val">{draft.speed.toFixed(1)}</span>
        </div>
      </div>
      <div className="voice-acts">
        {props.voiceOn
          ? (
            <button type="button" className="btn btn-sm voice-play" data-playing={playing ? 'true' : undefined} onClick={() => emit({ type: 'voice.preview', voice: p.voice, speed: p.speed })}>
              <i className="voice-tri" aria-hidden="true" />
              <span className="voice-bars" aria-hidden="true"><i /><i /><i /></span>
              {t('settings.voice.preview')}
            </button>
          )
          : <span />}
        <button type="button" className="btn btn-sm btn-danger" disabled={!props.canRemove} onClick={props.onRemove}>{t('settings.voice.remove')}</button>
      </div>
    </div>
  );
}

/**
 * 設定の「統括の声」（試作 C「行が垂れて開く」と、声の欄 X「出どころを切り替える」）。
 * 聞き方の切り替え、人格の行（丸で選ぶ、行を押すと開く、開くのは 1 つ）、中身、「+ 足す」。
 * 保存は設定の voice の全体を送る。補助が使えない環境（available が偽）では、声の欄と試し聞きを出さない。
 */
export function VoiceSettings(props: VoiceSettingsProps & { mark: SaveMark | undefined }) {
  const t = useT();
  const lang = useLanguage();
  const emit = useEmit();
  const { voice, available } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const fresh = useRef<string | null>(null);
  const latest = useRef(voice);
  latest.current = voice;
  const write = (next: VoiceSetting) => emit({ type: 'settings.update', patch: { voice: next }, field: 'voice' });
  const active = voice.personas.find((p) => p.id === voice.personaId) ?? voice.personas[0]!;

  // 補助があるときは、開いたときに声の一覧を読む。
  useEffect(() => { if (available) emit({ type: 'voice.catalog.load' }); }, [available, emit]);

  // 足した人格の行は、props に届いたとき高さを伸ばして入れる。
  useLayoutEffect(() => {
    const id = fresh.current;
    const el = id ? rows.current.get(id) : undefined;
    if (id && el) { fresh.current = null; growIn(el); }
  }, [voice.personas.length]);

  const select = (id: string) => { if (id !== voice.personaId) write({ ...voice, personaId: id }); };
  const toggle = (id: string) => { setOpenId(openId === id ? null : id); select(id); };
  const add = () => {
    if (voice.personas.length >= MAX_PERSONAS) return;
    const p: VoicePersona = { id: newId(), name: t('settings.voice.newName'), reading: lang === 'ja' ? NEW_PERSONA_READING : '', tone: '', voice: 'kokoro:jf_alpha', voiceLabel: 'jf_alpha', speed: 1.2 };
    fresh.current = p.id;
    setOpenId(p.id);
    write({ ...voice, personas: [...voice.personas, p], personaId: p.id });
  };
  const remove = (id: string) => {
    if (voice.personas.length < 2 || leaving !== null) return;
    const i = voice.personas.findIndex((p) => p.id === id);
    if (i < 0) return;
    const rest = voice.personas.filter((p) => p.id !== id);
    // 使っている人格を消したら、前の人格（先頭なら次）を選ぶ。
    const personaId = voice.personaId === id ? rest[Math.max(0, i - 1)]!.id : voice.personaId;
    setLeaving(id);
    const el = rows.current.get(id);
    void (el ? collapseOut(el) : Promise.resolve()).then(() => {
      setLeaving(null);
      if (openId === id) setOpenId(null);
      write({ ...latest.current, personas: latest.current.personas.filter((p) => p.id !== id), personaId });
    });
  };
  const savePersona = (id: string, patch: Partial<VoicePersona>) => write({ ...latest.current, personas: latest.current.personas.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const modes: Array<{ value: VoiceMode; label: string }> = [
    { value: 'off', label: t('settings.voice.listen.off') },
    { value: 'toggle', label: t('settings.voice.listen.toggle') },
    { value: 'always', label: t('settings.voice.listen.always') },
  ];
  const wakeOn = voice.mode === 'always' && active.reading !== '';
  const error = props.mark?.kind === 'error' ? props.mark.message : null;
  return (
    <section className="voice-settings" aria-label={t('settings.voice.title')}>
      <h3 className="h2">{t('settings.voice.title')}</h3>
      <SetRow title={t('settings.voice.listen')}
        control={(
          <>
            <span className="voice-wake" data-testid="voice-wake" data-on={wakeOn ? 'true' : 'false'} aria-hidden={wakeOn ? undefined : 'true'}>{active.reading !== '' ? t('settings.voice.wake', { reading: active.reading }) : ''}</span>
            <Segmented label={t('settings.voice.listen')} value={voice.mode} options={modes} onChange={(v) => write({ ...voice, mode: v as VoiceMode })} />
          </>
        )} />
      <div className="voice-sec-h">{t('settings.voice.personas')}</div>
      <div className="voice-rows">
        {voice.personas.map((p) => {
          const open = openId === p.id && leaving !== p.id;
          return (
            <div key={p.id} className="voice-row" ref={(el) => { if (el) rows.current.set(p.id, el); else rows.current.delete(p.id); }} data-sel={p.id === voice.personaId ? 'true' : undefined} data-open={open ? 'true' : undefined}>
              <div className="voice-row-h">
                <button type="button" role="radio" className="voice-radio" aria-checked={p.id === voice.personaId} aria-label={p.name} onClick={() => select(p.id)} />
                <button type="button" className="voice-row-t" aria-expanded={open} onClick={() => toggle(p.id)}>
                  <span className="voice-n">{p.name}</span>
                  <span className="voice-s">{lineOf(p)}</span>
                  <Icon name="chevronDown" />
                </button>
              </div>
              <FoldBox open={open} className="voice-fold">
                <PersonaBody persona={p} voiceOn={available} catalog={props.catalog} speakingId={props.speakingId} canRemove={voice.personas.length > 1}
                  save={(patch) => savePersona(p.id, patch)} onRemove={() => remove(p.id)} />
              </FoldBox>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn btn-sm voice-add" disabled={voice.personas.length >= MAX_PERSONAS} onClick={add}>{t('settings.voice.add')}</button>
      {error && <span className="verify" data-tone="ng" role="alert"><Icon name="close" />{error}</span>}
    </section>
  );
}
