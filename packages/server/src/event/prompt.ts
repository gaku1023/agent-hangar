import { SCHEDULE_PROMPT_MAX, t, type EventBindingDto, type EventFacts, type Language } from '@agent-hangar/shared';

/** エージェントへ渡す指示の全体の長さの上限（文字数）。予定の指示と同じ。 */
export const EVENT_PROMPT_MAX = SCHEDULE_PROMPT_MAX;

/** 1 行に収める事実の項目の長さ。 */
const FIELD_MAX = 300;

const oneLine = (s: string): string => {
  const flat = s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  const cs = [...flat];
  return cs.length > FIELD_MAX ? `${cs.slice(0, FIELD_MAX - 1).join('')}…` : flat;
};

/** 囲みの印を本文の中で作らせない。囲みの外へ抜けて、後ろの文を指示に見せるのを防ぐ。 */
const defang = (s: string): string => s.replace(/<<<|>>>/g, (m) => m.split('').join(' '));

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * 外から来た文（題名と本文）を渡してよいか。
 * passBody が真で、GitHub の投稿者が自分か allowAuthors に入っているときだけ。投稿者が分からないときも渡さない。
 * 外の webhook は投稿者を持たないので、passBody だけで決める（渡すときは必ず囲む）。
 */
function mayPassText(b: Pick<EventBindingDto, 'passBody' | 'allowAuthors'>, f: EventFacts, me: string | null | undefined): boolean {
  if (!b.passBody) return false;
  if (f.source === 'hook') return true;
  const actor = f.actor;
  if (!actor) return false;
  return (me ? sameLogin(actor, me) : false) || b.allowAuthors.some((a) => sameLogin(a, actor));
}

/** 事実の 1 行。機械の語のまま書き、言語によらない。外から来た文は含めない。 */
function factLine(f: EventFacts): string {
  const parts = [f.event];
  if (f.repo) parts.push(f.number !== undefined ? `${oneLine(f.repo)}#${f.number}` : oneLine(f.repo));
  if (f.outcome) parts.push(`outcome=${f.outcome}`);
  if (f.actor) parts.push(`actor=${oneLine(f.actor)}`);
  if (f.url) parts.push(`url=${oneLine(f.url)}`);
  return `- ${parts.join(' ')}`;
}

const len = (s: string): number => [...s].length;

/** 余りを短いものから順に分ける。短いものは全部入れ、残りを長いもので等分する。 */
function share(lengths: number[], total: number): number[] {
  const order = lengths.map((l, i) => ({ l, i })).sort((a, b) => a.l - b.l);
  const caps = new Array<number>(lengths.length).fill(0);
  let rest = Math.max(0, total);
  order.forEach(({ l, i }, k) => {
    const each = Math.floor(rest / (order.length - k));
    caps[i] = Math.min(l, each);
    rest -= caps[i]!;
  });
  return caps;
}

/**
 * できごとで動かすときの指示を組む。
 * 利用者が決めた指示のあとに、事実の行を並べる。
 * 題名と本文は、passBody が真で、投稿者が自分か allowAuthors に入っているときだけ、外から来た文の囲みに入れて渡す。
 * 外の webhook の本文も、渡すときは必ず囲む。囲みの中の指示には従わないよう、囲みの前に 1 度だけ断る。
 * 全体は EVENT_PROMPT_MAX 文字までで、あふれるときは囲みの中を削る（囲みは閉じたまま残す）。
 * me は今の PC の gh のユーザー名。分からなければ null か省き、誰も自分とみなさない。
 */
export function renderEventPrompt(binding: Pick<EventBindingDto, 'prompt' | 'passBody' | 'allowAuthors'>, facts: EventFacts[], language: Language, me?: string | null): string {
  const texts = facts.map((f) => {
    if (!mayPassText(binding, f, me)) return null;
    const joined = [f.title, f.body].filter((x): x is string => typeof x === 'string' && x !== '').join('\n\n');
    return joined === '' ? null : defang(joined);
  });
  const begin = t(language, 'schedules.event.textBegin');
  const end = t(language, 'schedules.event.textEnd');
  const slots = texts.flatMap((x, i) => (x === null ? [] : [i]));

  const head: string[] = [binding.prompt.trim(), '', t(language, 'schedules.event.header')];
  if (slots.length > 0) head.push(t(language, 'schedules.event.external'));
  // 本文を除いた長さ。囲みの印と改行も数える。
  const lines = facts.map((f, i) => ({ fact: factLine(f), text: texts[i] ?? null }));
  const fixed = [...head, ...lines.flatMap((l) => (l.text === null ? [l.fact] : [l.fact, begin, end]))];
  const overhead = fixed.reduce((n, s) => n + len(s), 0) + fixed.length - 1 + slots.length * 2;
  const caps = share(slots.map((i) => len(texts[i]!)), EVENT_PROMPT_MAX - overhead);

  const out = [...head];
  let k = 0;
  for (const l of lines) {
    out.push(l.fact);
    if (l.text === null) continue;
    const cap = caps[k++]!;
    const cs = [...l.text];
    const body = cs.length <= cap ? l.text : cap > 0 ? `${cs.slice(0, cap - 1).join('')}…` : '';
    out.push(begin, body, end);
  }
  const whole = out.join('\n');
  // 指示そのものが大きすぎて囲みまで入らないときの最後の砦。
  return len(whole) > EVENT_PROMPT_MAX ? [...whole].slice(0, EVENT_PROMPT_MAX).join('') : whole;
}
