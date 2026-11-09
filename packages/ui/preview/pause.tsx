// Paused のダイアログ（PauseDialog）の、起こす条件（#563 A4）を撮るための頁。`npm run dev -w @agent-hangar/ui` のあと /preview/pause.html
// 本番の bundle には入らない。値はすべて作り物である。
// ?case=suggested（既定。提案の文のカード）|empty（点線の「＋」）|picked（「＋」を押した形）|none（クラウド無し）|en
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/workbench.css';
import '../src/styles/rows.css';
import '../src/styles/controls.css';
import { createRoot } from 'react-dom/client';
import { translator } from '@agent-hangar/shared';
import { ActionRoot } from '../src/action/chain.tsx';
import { pauseChoices, type PauseProps } from '../src/presenters/pause.ts';
import { LanguageRoot } from '../src/views/primitives/language.tsx';
import { PauseDialog } from '../src/views/PauseDialog.tsx';

const kind = new URLSearchParams(location.search).get('case') ?? 'suggested';
const lang = kind === 'en' ? 'en' : 'ja';
const NOW = new Date(2026, 10, 10, 9, 0).getTime();
const props: PauseProps = {
  sessionId: 's1', sessionName: 'Windows の移植', from: 'candidate', draft: 'CI が終わったら結果を見る', candidateNote: 'CI が終わったら結果を見る',
  initialReturnOn: '2026-11-11', initialReturnTime: '', candidateReturnTime: null, today: '2026-11-10', choices: pauseChoices(NOW, translator(lang)),
  wake: kind === 'none' ? null : { suggested: kind === 'suggested' || kind === 'en' ? { repo: 'acme/app', pr: 567, when: 'ci_done' } : null, repo: 'acme/app', pr: 571 },
};

createRoot(document.getElementById('root')!).render(
  <LanguageRoot language={lang}>
    <ActionRoot onAction={(a) => { console.log(JSON.stringify(a)); (window as unknown as { __last?: unknown }).__last = a; }}>
      <PauseDialog {...props} />
    </ActionRoot>
  </LanguageRoot>,
);
