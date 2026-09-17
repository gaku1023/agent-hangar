import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';

// Root は Task 26 で差し替える。
// ここでは骨格だけを描画する。
createRoot(document.getElementById('root')!).render(<div className="app-boot">agent-hangar</div>);
