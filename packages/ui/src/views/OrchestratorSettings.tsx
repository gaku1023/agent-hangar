import { useEffect, useLayoutEffect, useRef } from 'react';
import { EFFORT_VALUES, type AgentKind, type OrchestratorSetting } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { OrchestratorSettingsProps, SettingsProps } from '../presenters/settings.ts';
import { enterAgent, leaveAgent, type AgentSwapSnapshot } from './agentSwap.ts';
import { AgentChip, ChipPopover, CodexChips, EffortBars, ModelEditor } from './LaunchChips.tsx';
import { PickList } from './primitives/PickList.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Switch } from './primitives/Switch.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';
import { VoiceSettings } from './VoiceSettings.tsx';

/**
 * 設定の「統括」の節。入り切りの行の下に、起動の札（アカウント、モデル、effort）と声を置く。
 * 切ると札の行と声は畳まれ（collapseOut）、入れると伸びて出る（growIn）。設定を開いたときに最初からあるものは動かさない。
 * 札は新しいセッションのダイアログと同じ部品で、選ぶたびに変えた項目だけを保存する。
 * 先頭のアプリの札（設定で有効なアプリが 2 つ以上のとき）でアプリを替えると、モデルと effort とアカウントを空に戻して一緒に保存する。
 * Codex のときの札は新しいセッションの Codex の札（モデルの一覧、推論）で、権限の札は出さない（read-only に固定）。入れ替えの動きは新しいセッションと同じ（agentSwap.ts）。
 */
export function OrchestratorSettings(props: { orchestrator: OrchestratorSettingsProps; voice?: SettingsProps['voice']; voiceMark?: SettingsProps['save']['voice'] }) {
  const t = useT();
  const emit = useEmit();
  const o = props.orchestrator;
  const save = (patch: Partial<OrchestratorSetting>) => emit({ type: 'settings.update', patch: { orchestrator: patch as OrchestratorSetting } });
  const body = usePresence<HTMLDivElement>(o.on, (el) => (motionOn(el) ? collapseOut(el) : null));
  const voice = usePresence<HTMLDivElement>(o.on, (el) => (motionOn(el) ? collapseOut(el) : null));
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (o.on && body.ref.current) growIn(body.ref.current);
    if (o.on && voice.ref.current) growIn(voice.ref.current);
    // 入る向きの変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.on]);
  const swap = useRef<{ snap: AgentSwapSnapshot; to: AgentKind } | null>(null);
  const switchAgent = async (to: AgentKind) => {
    if (to === o.agent) return;
    const box = body.ref.current;
    if (box) swap.current = { snap: await leaveAgent(box, o.agent), to };
    save({ agent: to, model: '', effort: '', account: null });
  };
  useLayoutEffect(() => {
    const s = swap.current;
    if (!s || s.to !== o.agent) return;
    swap.current = null;
    enterAgent(s.snap, o.agent);
  }, [o.agent]);
  // Codex の一覧は、Codex が統括のアプリのときに読む。
  useEffect(() => { if (o.on && o.agent === 'codex') emit({ type: 'codex.options' }); }, [o.on, o.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const def = t('launch.value.default');
  const accountId = o.account ?? o.accounts.find((a) => !a.disabled)?.value ?? '';
  const accountNow = o.accounts.find((a) => a.value === accountId);
  return (
    <>
      <section aria-label={t('settings.label.orchestrator')}>
        <SetRow title={t('settings.label.orchestrator')}
          control={<Switch label={t('settings.label.orchestrator')} checked={o.on} onChange={(next) => save({ enabled: next })} />} />
      {body.mounted && (
        <div ref={body.ref} aria-hidden={body.leaving ? true : undefined}>
          <SetRow title={t('launch.chips.label')} control={
          <div className="launch-chips" role="group" aria-label={t('launch.chips.label')}>
            {o.agents.length >= 2 && <AgentChip value={o.agent} onChange={(v) => { void switchAgent(v as AgentKind); }} opencodeNote={null} codexNote={o.agentNote} offered={o.agents} />}
            {o.accounts.length >= 2 && (
              <ChipPopover agentOnly="accounts" name={t('launch.chip.account')} value={accountNow?.label ?? accountId} dot={accountNow?.color} showName={false} tone={accountNow?.disabled ? 'muted' : 'default'} suffix={accountNow?.disabled ? accountNow.tag : undefined} width={260}>
                {(close) => (
                  <PickList label={t('launch.chip.account')} value={accountId}
                    items={o.accounts.map((a) => ({ value: a.value, label: a.label, disabled: a.disabled, tag: a.tag, lead: a.color ? <span className="st-dot" style={{ color: a.color }} aria-hidden="true" /> : undefined }))}
                    onPick={(v) => { save({ account: v }); close(); }} />
                )}
              </ChipPopover>
            )}
            {o.codex ? (
              <CodexChips model={o.codex.model} models={o.codex.models} onModel={(v) => { save({ model: v }); }} effort={o.codex.effort} efforts={o.codex.efforts} onEffort={(v) => { save({ effort: v }); }} />
            ) : (
              <>
              <ChipPopover name={t('launch.chip.model')} value={o.model || def} tone={o.model ? 'default' : 'muted'} agentOnly="modelText">
                {(close) => <ModelEditor value={o.model} noDefault onChange={(v) => { if (v.trim() !== '') save({ model: v.trim() }); }} close={close} />}
              </ChipPopover>
              <ChipPopover name={t('launch.chip.effort')} value={o.effort || def} tone={o.effort ? 'default' : 'muted'} agentOnly="effort">
                {(close) => (
                  <PickList label={t('launch.chip.effort')} value={o.effort}
                    items={EFFORT_VALUES.map((e, i) => ({ value: e, label: e || def, lead: e ? <EffortBars level={i} /> : undefined }))}
                    onPick={(v) => { save({ effort: v }); close(); }} />
                )}
              </ChipPopover>
              </>
            )}
          </div>} />
        </div>
      )}
      </section>
      {voice.mounted && props.voice !== undefined && (
        <div ref={voice.ref} aria-hidden={voice.leaving ? true : undefined}>
          <VoiceSettings {...props.voice} mark={props.voiceMark} />
        </div>
      )}
    </>
  );
}
