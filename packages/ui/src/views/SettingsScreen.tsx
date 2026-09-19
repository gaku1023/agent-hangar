import { useEffect, useState } from 'react';
import type { SettingsDto, TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import { costLabel, tokensLabel } from '../presenters/format.ts';
import type { SettingsProps } from '../presenters/settings.ts';

/** 設定画面。保持する状態は入力途中の値だけで、保存で settings.update を出す。 */
export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const [ws, setWs] = useState(props.workspaceRoot);
  const [tmuxPath, setTmuxPath] = useState(props.tmuxPath ?? '');
  const [terminalApp, setTerminalApp] = useState<TerminalApp>(props.terminalApp);
  const [codePath, setCodePath] = useState(props.codePath ?? '');
  const [lmUrl, setLmUrl] = useState(props.lmStudioUrl);
  const [lmModel, setLmModel] = useState(props.lmStudioModel ?? '');
  const [fallback, setFallback] = useState(props.summaryFallback);
  const [cap, setCap] = useState(String(props.summaryHourlyCap));
  const [allowExternal, setAllowExternal] = useState(props.allowExternalSummarizer);
  const [capError, setCapError] = useState(false);
  // サーバが正規化した値、たとえば tmux の絶対パスを入力欄に反映する。
  useEffect(() => { setWs(props.workspaceRoot); }, [props.workspaceRoot]);
  useEffect(() => { setTmuxPath(props.tmuxPath ?? ''); }, [props.tmuxPath]);
  useEffect(() => { setTerminalApp(props.terminalApp); }, [props.terminalApp]);
  useEffect(() => { setCodePath(props.codePath ?? ''); }, [props.codePath]);
  useEffect(() => { setLmUrl(props.lmStudioUrl); }, [props.lmStudioUrl]);
  useEffect(() => { setLmModel(props.lmStudioModel ?? ''); }, [props.lmStudioModel]);
  useEffect(() => { setFallback(props.summaryFallback); }, [props.summaryFallback]);
  useEffect(() => { setCap(String(props.summaryHourlyCap)); }, [props.summaryHourlyCap]);
  useEffect(() => { setAllowExternal(props.allowExternalSummarizer); }, [props.allowExternalSummarizer]);
  useEffect(() => { setCapError(false); }, [props.summaryHourlyCap]);
  // 1 時間の上限は 1 以上 200 以下の整数だけを受け付ける。
  // 空のまま送ると 0 になって、Claude への切り替えが黙って止まってしまう。
  // 数字でない文字は NaN になるので、これも送らない。
  const capNumber = cap.trim() === '' ? Number.NaN : Number(cap);
  const capValid = Number.isInteger(capNumber) && capNumber >= 1 && capNumber <= 200;
  // 要約器は 4 項目をまとめて送る。
  // 空の patch にならないので、ツールの保存のような無効化はいらない。
  const saveSummarizer = () => {
    if (!capValid) { setCapError(true); return; }
    setCapError(false);
    emit({ type: 'settings.update', patch: { lmStudioUrl: lmUrl, lmStudioModel: lmModel || null, summaryFallback: fallback, summaryHourlyCap: capNumber, allowExternalSummarizer: allowExternal } });
  };

  // 変えた項目だけを送る。
  // terminalApp を毎回入れると、iTerm2 の許可案内が保存のたびに出る。
  const toolsPatch: Partial<SettingsDto> = {};
  const tmux = tmuxPath.trim() || null;
  const code = codePath.trim() || null;
  if (tmux !== props.tmuxPath) toolsPatch.tmuxPath = tmux;
  if (terminalApp !== props.terminalApp) toolsPatch.terminalApp = terminalApp;
  if (code !== props.codePath) toolsPatch.codePath = code;
  // 空の patch はサーバが 400 にして、英語のエラートーストになってしまう。
  const toolsDirty = Object.keys(toolsPatch).length > 0;
  return (
    <div className="screen" style={{ maxWidth: 720 }}>
      <h1 className="h1">Settings</h1>
      <section>
        <h2 className="h2">ワークスペース</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="ワークスペースのルート" value={ws} onChange={(e) => setWs(e.target.value)} />
          <button className="btn btn-primary" onClick={() => emit({ type: 'settings.update', patch: { workspaceRoot: ws } })}>保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>直下のディレクトリのうち、Claude のセッションがあるものをプロジェクトとして登録します。</div>
      </section>
      <section>
        <h2 className="h2">ツール</h2>
        <div className="grid2">
          <label className="field">tmux のパス
            <input className="input mono" aria-label="tmux のパス" value={tmuxPath} onChange={(e) => setTmuxPath(e.target.value)} placeholder="見つかりません。brew install tmux のあとにパスを入れてください" />
          </label>
          <label className="field">ターミナルアプリ
            <select className="select" aria-label="ターミナルアプリ" value={terminalApp} onChange={(e) => setTerminalApp(e.target.value as TerminalApp)}>
              <option value="terminal">Terminal.app</option>
              <option value="iterm">iTerm2</option>
            </select>
          </label>
          <label className="field">code のパス
            <input className="input mono" aria-label="code のパス" value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="VS Code の code コマンド" />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={!toolsDirty} onClick={() => emit({ type: 'settings.update', patch: toolsPatch })}>ツールの設定を保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>iTerm2 は AppleScript で開くため、初回に macOS の自動化の許可ダイアログが出ます。失敗したときは Terminal.app で開きます。</div>
      </section>
      <section>
        <h2 className="h2">MCP</h2>
        <div className="muted">Claude Code の user スコープに hangar の MCP サーバを登録すると、どのセッションからも検索と要約が使えます。ターミナルで次を実行してください。</div>
        <pre className="mono" style={{ margin: '8px 0 0' }}>{props.mcpInstallCommand}</pre>
      </section>
      <section>
        <h2 className="h2">statusline</h2>
        {props.statusline === null && <div className="faint">読み込んでいます</div>}
        {props.statusline && props.statusline.scriptPath === null && (
          <>
            <div className="muted">statusLine の設定が見つかりません</div>
            <div className="faint" style={{ marginTop: 4 }}>Claude Code の /statusline でスクリプトを作ってから、下のコマンドを実行してください。</div>
          </>
        )}
        {props.statusline?.scriptPath && (
          <>
            <div className="muted">{props.statusline.installed ? '追記済みです' : 'まだ追記されていません'}</div>
            <div className="faint mono">{props.statusline.scriptPath}</div>
          </>
        )}
        <div className="faint" style={{ marginTop: 4 }}>使用量ゲージはこの追記だけが供給源です。追記は端末から行い、UI からは書き換えません。</div>
        <pre className="mono snippet">{props.statuslineCommand}</pre>
        {/* 追記されるスニペットの宛先はこのコマンドの --port で決まる。 */}
        {/* 既定の 4177 のまま追記すると、別のポートで動かしているサーバには届かない。 */}
        <div className="faint" style={{ marginTop: 4 }}>{'サーバが 4177 以外で動いているときは --port <番号> を付けてください。'}</div>
      </section>
      <section>
        <h2 className="h2">要約器</h2>
        <div className="grid2">
          <label className="field"><span>LM Studio の URL</span>
            <input className="input mono" aria-label="LM Studio の URL" value={lmUrl} onChange={(e) => setLmUrl(e.target.value)} />
          </label>
          <label className="field"><span>モデル</span>
            <select className="select" aria-label="モデル" value={lmModel} onChange={(e) => setLmModel(e.target.value)}>
              <option value="">自動（最初のモデル）</option>
              {(props.summarizerModels ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>
        {props.summarizerModels === null && <div className="faint" style={{ marginTop: 4 }}>読み込んでいます</div>}
        {props.summarizerModels?.length === 0 && <div className="faint" style={{ marginTop: 4 }}>LM Studio に繋がりません</div>}
        <label className="settings-row"><input type="checkbox" aria-label="外部の要約器を許す" checked={allowExternal} onChange={(e) => setAllowExternal(e.target.checked)} /><span>手元の外にある要約器を許す</span></label>
        {allowExternal && <div className="error" role="alert" style={{ marginTop: 4 }}>会話の本文（利用者の発言とアシスタントの応答）が {lmUrl || 'この宛先'} へ送られます。宛先を確かめてください。</div>}
        <label className="settings-row"><input type="checkbox" aria-label="Claude へ切り替える" checked={fallback} onChange={(e) => setFallback(e.target.checked)} /><span>LM Studio が使えないとき Claude へ切り替える</span></label>
        <label className="settings-row"><span>1 時間の上限</span><input className="input mono" type="number" min={1} max={200} step={1} style={{ width: 72 }} aria-label="1 時間の上限" value={cap} onChange={(e) => { setCap(e.target.value); setCapError(false); }} /><span className="faint">件。1 から 200 まで。7 日の使用率が 80% を超えたら切り替えません。</span></label>
        {capError && <div className="error" role="alert" style={{ marginTop: 4 }}>1 から 200 までの整数を入れてください</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={saveSummarizer}>要約器の設定を保存</button>
          <button className="btn" onClick={() => emit({ type: 'summarizer.test' })}>要約器を試す</button>
        </div>
        {props.summarizerTest?.ok === true && (
          <div style={{ marginTop: 4 }}>
            <div className="muted">{props.summarizerTest.id} で成功しました（{props.summarizerTest.ms} ミリ秒）</div>
            <div className="faint">{props.summarizerTest.summary.oneLiner}</div>
          </div>
        )}
        {props.summarizerTest?.ok === false && (
          <ul className="faint" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {props.summarizerTest.tried.map((t) => <li key={t.id}>{t.id}: {t.message}</li>)}
          </ul>
        )}
      </section>
      <section>
        <h2 className="h2">クラウド同期</h2>
        {!props.cloud.configured && <div className="faint">hangar setup cloud か hangar join &lt;token&gt; で始められます</div>}
        {props.cloud.configured && (
          <>
            <div className="mono muted">{props.cloud.url}</div>
            <div className="faint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
              <span>状態 {props.cloud.state}</span>
              <span>最終 pull {props.cloud.lastPullAt}</span>
              <span>未送信 {props.cloud.pending} 件</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
              <button className="btn" onClick={() => emit({ type: 'sync.pause', paused: !props.cloud.paused })}>{props.cloud.paused ? '同期を再開' : '一時停止'}</button>
              {/* 参加トークンは全セッションの読み書き権を持つ秘密なので、押すまで取りに行かない。 */}
              {/* 出したあとはランタイムが 120 秒で store から消すので、props が null に戻ればこのボタンの姿に戻る。 */}
              {props.cloud.joinToken === null && <button className="btn" onClick={() => emit({ type: 'sync.joinToken.show' })}>参加トークンを表示</button>}
            </div>
            {props.cloud.joinToken !== null && (
              <div style={{ marginTop: 8 }}>
                <div className="mono" style={{ wordBreak: 'break-all' }}>{props.cloud.joinToken}</div>
                <div className="faint">このトークンを持つ人は、あなたのセッションを読み書きできます。渡す相手に気をつけてください。</div>
                <div className="faint">120 秒で自動的に消えます。1Password などに写してください。</div>
              </div>
            )}
            <div className="list" style={{ marginTop: 8 }}>
              {props.cloud.devices.map((d) => (
                <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto auto', cursor: 'default' }}>
                  <span>{d.name}{d.self && <span className="faint"> この端末</span>}</span>
                  <span className="faint">{d.platform}</span>
                  <span className="faint">{d.lastSeen}</span>
                </div>
              ))}
            </div>
            <label className="settings-row">
              <input type="checkbox" aria-label="Claude Code の設定を同期する" checked={props.cloud.syncClaudeConfig} onChange={(e) => emit({ type: 'settings.update', patch: { syncClaudeConfig: e.target.checked } })} />
              <span>Claude Code の設定を同期する</span>
            </label>
            <div className="faint" style={{ marginTop: 4 }}>CLAUDE.md、settings.json、statusline のスクリプト、skills、memory、projects の memory を端末間で合わせます。</div>
            {/* 利用者の決定 2。~/.claude を書き換える前に必ず控えを取り、何を書き換えたかを後から読めるようにする。 */}
            <div className="faint">~/.claude に書き込むので、取り込む前に内容を確認します。上書きの前の控えは ~/.agent-hangar/backups/claude-config/&lt;日時&gt;/ に残ります。</div>
            {props.cloud.syncClaudeConfig && <div className="faint">{props.cloud.configConfirmed ? '取り込みを確認済みです。' : 'まだ取り込みを確認していません。確認するまで ~/.claude には書き込みません。'}</div>}
            <button className="btn" style={{ marginTop: 8 }} disabled={!props.cloud.syncClaudeConfig} onClick={() => emit({ type: 'sync.config.preview' })}>取り込み内容を確認</button>
          </>
        )}
      </section>
      <section>
        <h2 className="h2">使用量</h2>
        {props.usageAggregate === null && <div className="faint">使用量を読み込んでいます</div>}
        {props.usageAggregate && (
          <div className="grid2">
            <table className="mini"><caption className="faint">直近 30 日</caption>
              <thead><tr><th>日</th><th className="cell-right">入力</th><th className="cell-right">出力</th><th className="cell-right">件</th></tr></thead>
              <tbody>{props.usageAggregate.days.map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="mono cell-right">{tokensLabel(d.inputTokens)}</td><td className="mono cell-right">{tokensLabel(d.outputTokens)}</td><td className="mono cell-right">{d.sessions}</td></tr>)}</tbody>
            </table>
            <table className="mini"><caption className="faint">プロジェクト別</caption>
              <thead><tr><th>名前</th><th className="cell-right">トークン</th><th className="cell-right">コスト</th><th className="cell-right">件</th></tr></thead>
              <tbody>{props.usageAggregate.projects.map((p) => <tr key={p.projectId ?? 'none'}><td>{p.name}</td><td className="mono cell-right">{tokensLabel(p.inputTokens + p.outputTokens)}</td><td className="mono cell-right">{costLabel(p.costUsd)}</td><td className="mono cell-right">{p.sessions}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <div className="faint" style={{ marginTop: 4 }}>コストは statusline が渡した値の合計です。渡されていないセッションは含みません。</div>
        {/* コストの供給源は cost.total_cost_usd で、そのセッションの走り全体の累計である。 */}
        {/* 日ごとの内訳が無いので、期間で切り分けられない。 */}
        <div className="faint">トークン数は期間のとおりですが、推定コストはそのセッションの走り全体の累計です。</div>
      </section>
      <section>
        <h2 className="h2">索引</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono muted">{props.index.phase === 'idle' ? `${props.sessionCount} セッション、${props.projectCount} プロジェクト` : `${props.index.phase} ${props.index.done} / ${props.index.total}`}</span>
          <button className="btn" onClick={() => emit({ type: 'index.rebuild' })}>索引を作り直す</button>
        </div>
        <div className="faint mono" style={{ marginTop: 4 }}>読み取り元 {props.claudeDir}</div>
        <div className="faint" style={{ marginTop: 4 }}>読み取り元を変えたときは、再起動後に反映されます。</div>
      </section>
      <section>
        <h2 className="h2">この端末</h2>
        <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
        <div className="faint mono">agent-hangar {props.version}</div>
      </section>
    </div>
  );
}
