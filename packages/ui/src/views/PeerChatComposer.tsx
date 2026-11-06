import { useContext, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { PEER_CHAT_IMAGES_MAX, type PeerChatOpIn } from '@agent-hangar/shared';
import type { PeerChatView } from '../presenters/peerChat.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { PromptAssistContext } from './primitives/promptAssist.ts';
import { acceptText, attachmentFromPath, dropFileName, triggerAt, type Attachment } from './primitives/promptComposerModel.ts';
import { splitLast } from '../lib/paths.ts';

/** 画像 1 枚の上限。元の PC の取り込みと同じ（5 MiB、PNG と JPEG と WebP）。 */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_HEIGHT = 120;
const FILE_DEBOUNCE_MS = 120;

type Props = { view: PeerChatView; onSend: (body: PeerChatOpIn) => void; onTakeOver: () => void };

/**
 * ほかの PC の会話の入力欄（試作の 1A、2A、4A）。
 * 送る口の名前は状態で変わる。アイドルは「送る」、作業中と入力待ちは「預ける」、停止中は「{device} で再開して送る」（再開してから渡す）。
 * 作業中と入力待ちは「中断」（Esc の代わり）も出す。
 * 接続が切れているときは入力欄を閉じ、理由と「この PC で再開」を並べる（U8）。
 * 画像（4 枚まで）は貼り付けか添付ボタンで置き場へ送り、パスで渡す。@ は元の PC のプロジェクトのファイルを探して指す。
 * 送った文は、すぐ欄から消す。断られたら、断りの理由とともに文が戻ってくる（view.restore）。
 */
export function PeerChatComposer(props: Props) {
  const t = useT();
  const assist = useContext(PromptAssistContext);
  const { view } = props;
  const c = view.composer;
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<{ query: string; list: string[] | 'failed' } | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const seenRestore = useRef(view.restore?.n ?? 0);

  // 断られた文（と画像）を欄へ戻す。打ちかけがあれば、その前に足す。
  useEffect(() => {
    const r = view.restore;
    if (!r || r.n === seenRestore.current) return;
    seenRestore.current = r.n;
    setText((cur) => (cur ? `${r.text}\n${cur}` : r.text));
    if (r.images.length > 0) setImages((cur) => [...cur, ...r.images.filter((p) => !cur.some((a) => a.path === p)).map(attachmentFromPath)]);
    ta.current?.focus();
  }, [view.restore]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [text]);

  const trigger = triggerAt(text, caret);
  const mention = trigger && trigger.kind === '@' && dismissed !== `${trigger.start}:${trigger.query}` ? trigger : null;
  const query = mention?.query ?? null;
  useEffect(() => {
    if (query === null) { setFiles(null); return; }
    let live = true;
    const run = () => {
      const ask = assist.peerFiles;
      if (!ask) { setFiles({ query, list: [] }); return; }
      ask(view.sessionId, query).then((list) => { if (live) setFiles({ query, list }); }, () => { if (live) setFiles({ query, list: 'failed' }); });
    };
    const timer = setTimeout(run, query === '' ? 0 : FILE_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [assist, query, view.sessionId]);
  const list = files && files.query === query && Array.isArray(files.list) ? files.list : null;
  const current = Math.min(active, Math.max((list?.length ?? 1) - 1, 0));

  const accept = (path: string) => {
    if (!mention) return;
    const r = acceptText(text, caret, mention, path);
    setText(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(r.caret, r.caret); });
  };

  const addImages = (picked: File[]) => {
    setProblem(null);
    for (const f of picked) {
      if (!IMAGE_TYPES.includes(f.type)) { setProblem(t('peerChat.image.kind')); continue; }
      if (f.size > IMAGE_MAX_BYTES) { setProblem(t('peerChat.image.tooLarge', { name: f.name })); continue; }
      setUploading((n) => n + 1);
      assist.upload(f).then(
        (d) => setImages((cur) => (cur.length >= PEER_CHAT_IMAGES_MAX ? (setProblem(t('peerChat.image.tooMany', { max: PEER_CHAT_IMAGES_MAX })), cur) : [...cur, { path: d.path, name: d.name, size: d.size }])),
        (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
      ).finally(() => setUploading((n) => n - 1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pics = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (pics.length > 0) { e.preventDefault(); addImages(pics); }
  };

  const blocked = c.kind === 'blocked';
  const ready = !blocked && !c.sending && uploading === 0 && (text.trim() !== '' || images.length > 0);
  const send = () => {
    if (!ready) return;
    const body = { text: text.trim(), ...(images.length > 0 ? { images: images.map((a) => a.path) } : {}) };
    props.onSend(c.kind === 'resume' ? { t: 'resume-send', ...body } : { t: 'send', ...body });
    setText('');
    setImages([]);
    setProblem(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && list && list.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((current + 1) % list.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((current - 1 + list.length) % list.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !isComposing(e)) { e.preventDefault(); accept(list[current]!); return; }
    }
    if (mention && e.key === 'Escape') { e.preventDefault(); setDismissed(`${mention.start}:${mention.query}`); return; }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) { e.preventDefault(); send(); }
  };

  if (c.offline) {
    return (
      <div className="pchat-comp" data-blocked="true">
        <div className="pchat-offline" role="status"><Icon name="disconnected" /><span>{c.offline}</span>{c.canTakeOver && <button type="button" className="btn btn-primary" onClick={props.onTakeOver}><Icon name="resumeHere" />{t('session.action.resumeHere')}</button>}</div>
      </div>
    );
  }
  return (
    <div className="pchat-comp">
      {view.notice && <div key={view.notice.n} className="pchat-notice pchat-in" role="status">{view.notice.text}</div>}
      {(images.length > 0 || uploading > 0) && (
        <ul className="pchat-images">
          {images.map((a) => {
            const file = dropFileName(a.path);
            return (
              <li key={a.path} className="pchat-image" title={a.name}>
                {file ? <img src={`/api/drops/${encodeURIComponent(file)}`} alt={a.name} /> : <span>{a.name}</span>}
                <button type="button" aria-label={t('peerChat.composer.removeImage', { name: a.name })} onClick={() => setImages((cur) => cur.filter((x) => x.path !== a.path))}><Icon name="close" /></button>
              </li>
            );
          })}
          {uploading > 0 && <li className="pchat-image" aria-busy="true"><span className="pchat-image-wait" /></li>}
        </ul>
      )}
      {problem && <div className="pchat-notice" role="status">{problem}</div>}
      <div className="pchat-box" data-blocked={blocked ? 'true' : undefined}>
        <button type="button" className="pchat-ib" aria-label={t('peerChat.composer.attach')} title={t('peerChat.composer.attach')} disabled={blocked || images.length >= PEER_CHAT_IMAGES_MAX} onClick={() => picker.current?.click()}><Icon name="attach" /></button>
        <input ref={picker} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden data-testid="pchat-picker" onChange={(e) => { addImages([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button type="button" className="pchat-ib" aria-label={t('peerChat.composer.mention')} title={t('peerChat.composer.mention')} disabled={blocked} onMouseDown={(e) => e.preventDefault()}
          onClick={() => { const el = ta.current; if (!el) return; const at = el.selectionStart ?? text.length; const next = `${text.slice(0, at)}${at > 0 && !/\s$/.test(text.slice(0, at)) ? ' ' : ''}@${text.slice(at)}`; setText(next); const pos = at + (next.length - text.length); setCaret(pos); requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); }); }}>@</button>
        <textarea ref={ta} rows={1} value={text} aria-label={t('peerChat.composer.label')} placeholder={c.placeholder} disabled={blocked}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} onKeyDown={onKeyDown} onPaste={onPaste} />
        {c.canInterrupt && <button type="button" className="pchat-stop" onClick={() => props.onSend({ t: 'interrupt' })}>{t('peerChat.composer.interrupt')} <kbd>Esc</kbd></button>}
        <button type="button" className="pchat-send" data-kind={c.kind} disabled={!ready} onClick={send}>{c.sendLabel}<Icon name="seeAll" /></button>
        {mention && list && (
          <div className="pchat-mention" role="listbox" aria-label={t('peerChat.composer.mention')} onMouseDown={(e) => e.preventDefault()}>
            {list.length === 0 && <div className="pchat-mention-empty">{t('common.empty.noMatch')}</div>}
            {list.map((f, i) => {
              const { dir, base } = splitLast(f);
              return (
                <div key={f} role="option" aria-selected={i === current} className="pchat-mention-opt" data-active={i === current ? 'true' : undefined} onMouseDown={(e) => { e.preventDefault(); accept(f); }} onMouseMove={() => setActive(i)}>
                  <span>{base}</span>{dir !== '' && <small>{dir.slice(0, -1)}</small>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {c.hint && <div className="pchat-hint"><Icon name="reminder" />{c.hint}</div>}
    </div>
  );
}
