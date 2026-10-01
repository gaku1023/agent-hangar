import type { SessionStateDto } from '@agent-hangar/shared';

/** 1 行に収める。改行やタブなどの制御文字は空白 1 つに寄せる。claude.zsh は行で区切って読むためである。 */
const oneLine = (s: string | null): string => (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** YYYY-MM-DD を M/D に。端末の 1 行に収まる短い形にする。 */
const monthDay = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * claude.zsh が抜けるときに読む text。
 * 1 行目は ask か skip。状態がもう付いていれば skip にし、問いを出させない。
 * 2 行目は問いの頭に出す提案（無ければ空）、3 行目は明日の Paused の理由の下書き（提案の根拠、無ければ空）である。
 * 根拠は 1 行に寄せてから渡す。claude.zsh は JSON に入れるときに \ と " だけを逃がすので、制御文字をここで落としておく。
 */
export function exitPromptText(state: SessionStateDto | null): string {
  if (state?.status) return 'skip\n';
  const c = state?.candidate ?? null;
  if (!c) return 'ask\n\n\n';
  const note = oneLine(c.note);
  const label = c.status === 'done' ? 'Done' : `Paused${c.returnOn ? ` · ${monthDay(c.returnOn)}` : ''}`;
  return `ask\nClaude の提案：${label}${note ? `（${note}）` : ''}\n${note}\n`;
}
