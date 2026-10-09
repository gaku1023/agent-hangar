import { describe, expect, it } from 'vitest';
import { languageReader } from './language.ts';
import { errorText, MessageError, msg, render, translatorOf } from './message.ts';

describe('languageReader', () => {
  it('設定の language を読み、無いときと知らない値は日本語にする', () => {
    let settings: { language?: unknown } = {};
    const language = languageReader(() => settings as never);
    expect(language()).toBe('ja');
    settings = { language: 'en' };
    expect(language()).toBe('en');
    settings = { language: 'fr' };
    expect(language()).toBe('ja');
  });
});

describe('msg と render', () => {
  it('鍵と引数を持ち回り、出すときの言語で文にする', () => {
    const m = msg('sessions.list.count', { n: 3 });
    expect(render('ja', m)).toBe('3 件のセッション');
    expect(render('en', m)).toBe('3 sessions');
  });

  it('引数に入れた文も、同じ言語で文にする', () => {
    const m = msg('session.kill.confirm', { name: msg('common.button.cancel') });
    expect(render('ja', m)).toBe('「キャンセル」を停止しますか');
    expect(render('en', m)).toBe('Stop "Cancel"?');
  });

  it('引数に入れた並びは、その言語の区切りでつなぐ', () => {
    const m = msg('mcp.args.oneOf', { field: 'state', values: ['a', 'b', 'c'] });
    expect(render('ja', m)).toBe('state は a、b、c のいずれかです');
    expect(render('en', m)).toBe('state must be one of a, b, c');
  });

  it('引数の数と名前は型で止まる', () => {
    // @ts-expect-error 引数の要る鍵に、引数を渡していない
    msg('sessions.list.count');
    // @ts-expect-error 引数の名前が違う
    msg('sessions.list.count', { count: 3 });
    // @ts-expect-error 辞書に無い鍵
    msg('no.such.key');
  });
});

describe('MessageError', () => {
  it('message は既定の言語（日本語）の文で、境目では言語を選んで出せる', () => {
    const e = new MessageError(msg('sessions.list.count', { n: 2 }));
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('2 件のセッション');
    expect(errorText('ja', e)).toBe('2 件のセッション');
    expect(errorText('en', e)).toBe('2 sessions');
  });

  it('文字列で作ったものは、どの言語でもその文字列を出す', () => {
    const e = new MessageError('そのまま');
    expect(e.message).toBe('そのまま');
    expect(errorText('en', e)).toBe('そのまま');
  });

  it('ほかの失敗は message を、失敗でない値は文字列にして出す', () => {
    expect(errorText('en', new Error('boom'))).toBe('boom');
    expect(errorText('en', 'plain')).toBe('plain');
  });
});

describe('translatorOf', () => {
  it('引くたびに、そのときの言語を読む', () => {
    let language: 'ja' | 'en' = 'ja';
    const t = translatorOf(() => language);
    expect(t('common.button.cancel')).toBe('キャンセル');
    language = 'en';
    expect(t('common.button.cancel')).toBe('Cancel');
  });

  it('言語を渡さなければ日本語で引く', () => {
    expect(translatorOf()('sessions.list.count', { n: 1 })).toBe('1 件のセッション');
  });
});
