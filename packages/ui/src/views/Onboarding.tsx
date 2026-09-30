import { useEmit } from '../intent/chain.tsx';
import type { OnboardingProps } from '../presenters/onboarding.ts';
import type { CheckItem } from '../presenters/readiness.ts';
import { PageHeading } from './PageHeading.tsx';
import { CommandLine } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';

/** 確認の 1 行。印は色だけでなく形（✓、✗、!）でも分け、読み上げの名前にも状態を入れる。 */
function CheckRow(props: { item: CheckItem }) {
  const emit = useEmit();
  const c = props.item;
  const tone = c.ok ? 'ok' : c.soft ? 'soft' : 'ng';
  return (
    <li className="ck" data-tone={tone} aria-label={`${c.label} ${c.ok ? '準備できています' : 'まだです'}`}>
      <Icon name={c.ok ? 'ok' : c.soft ? 'alert' : 'ng'} />
      <div className="ck-t">
        <b>{c.label}</b>{c.path && <> <span className="ck-p">{c.path}</span></>}
        <div className="ck-d">{c.detail}</div>
        {c.command && <CommandLine command={c.command} />}
      </div>
      <div className="ck-act">
        {c.action === 'settings' && <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'nav.go', to: { name: 'settings' } })}>設定で変える</button>}
      </div>
    </li>
  );
}

/**
 * 空のホームの真ん中に置く 1 枚の札（初回の A1）。
 * 準備の確認リストと、始めるための 3 つのボタンを持つ。
 * 判定は設定画面の欄の下の検証と同じもの（presenters/readiness.ts）を使う。
 */
export function Onboarding(props: OnboardingProps) {
  const emit = useEmit();
  return (
    <div className="screen onboarding">
      <PageHeading title="ホーム" />
      <div className="ob-body">
        <h1 className="ob-title">ようこそ</h1>
        <p className="ob-lead">Claude Code のセッションを、ここから始めて見渡せます。</p>
        <section className="ck-card" aria-labelledby="ck-title">
          <div className="ck-head">
            <Icon name="checks" />
            <h2 id="ck-title">始める前の確認</h2>
            {props.checks && <span className="ck-prog">{props.checks.progress}</span>}
          </div>
          {props.checks
            ? <ul className="ck-list">{props.checks.items.map((i) => <CheckRow key={i.key} item={i} />)}</ul>
            : <div className="ck-wait faint">確かめています</div>}
          <div className="ck-foot">
            <span className="faint">tmux と claude があれば、残りが ✗ でも始められます</span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'readiness.check' })}><Icon name="recheck" />もう一度確かめる</button>
          </div>
        </section>
        <div className="ob-acts">
          <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="scratch" />スクラッチで始める</button>
          <button type="button" className="btn" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" />新しいセッション</button>
          <button type="button" className="btn" onClick={() => emit({ type: 'nav.go', to: { name: 'settings' } })}><Icon name="settings" />設定を開く</button>
        </div>
      </div>
    </div>
  );
}
