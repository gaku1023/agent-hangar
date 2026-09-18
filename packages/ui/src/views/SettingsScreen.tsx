import { useState } from 'react';
import type { TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SettingsProps } from '../presenters/settings.ts';

/** 設定画面。保持する状態は入力途中の値だけで、保存で settings.update を出す。 */
export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const [ws, setWs] = useState(props.workspaceRoot);
  const [tmuxPath, setTmuxPath] = useState(props.tmuxPath ?? '');
  const [terminalApp, setTerminalApp] = useState<TerminalApp>(props.terminalApp);
  const [codePath, setCodePath] = useState(props.codePath ?? '');
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
          <button className="btn btn-primary" onClick={() => emit({ type: 'settings.update', patch: { tmuxPath: tmuxPath.trim() || null, terminalApp, codePath: codePath.trim() || null } })}>ツールの設定を保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>iTerm2 は AppleScript で開くため、初回に macOS の自動化の許可ダイアログが出ます。失敗したときは Terminal.app で開きます。</div>
      </section>
      <section>
        <h2 className="h2">MCP</h2>
        <div className="muted">Claude Code の user スコープに hangar の MCP サーバを登録すると、どのセッションからも検索と要約が使えます。ターミナルで次を実行してください。</div>
        <pre className="mono" style={{ margin: '8px 0 0' }}>{props.mcpInstallCommand}</pre>
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
      <section>
        <h2 className="h2">次のフェーズで追加される設定</h2>
        <div className="faint">statusline への追記、要約器、クラウド同期。</div>
      </section>
    </div>
  );
}
