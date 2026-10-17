import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { takePairFragment } from './api.ts';
import { App } from './App.tsx';
import { takeOpenFragment } from './push.ts';
import './styles.css';

// 何より先に #pair= を URL から消し、中身は手元の変数にだけ持つ。
const pairText = takePairFragment();
// 通知を押して開いたときの #open=<会話の ID>（public/sw.js が付ける）。読んだら URL から消す。
const openSession = pairText ? null : takeOpenFragment();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App pairText={pairText} openSession={openSession} />
  </StrictMode>,
);

// ホーム画面のアプリとして入れられるよう、サービスワーカーを置く（開発中は置かない）。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => undefined);
}
