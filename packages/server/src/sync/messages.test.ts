import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_VERSION, type FileMetaIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb } from '../db/open.ts';
import { errorText, MessageError } from '../i18n/message.ts';
import { CloudError, CompatError, LimitError } from './client.ts';
import { decryptStream, deriveFileKey, encryptBuffer, sha256Hex } from './crypto.ts';
import { limitedMessage, limitedWhilePausedMessage, resyncedMessage } from './engine.ts';
import { RemotePuller, remoteTranscriptPath } from './puller.ts';
import { SyncStateStore } from './state.ts';

/**
 * 同期の利用者に見える文が、辞書の鍵と引数を持つこと。
 * 日本語の文は今までと同じで（既存の試験が見る）、ここでは英語でも出ることと、鍵が失われないことを見る。
 */

describe('クラウドの失敗の文', () => {
  it('互換の版の失敗は、どちらを上げるかを日本語と英語で言う', () => {
    const device = new CompatError('device', COMPAT_VERSION, 3);
    expect(errorText('ja', device)).toContain('この PC の hangar が古いので');
    expect(errorText('en', device)).toBe(`This computer's hangar is out of date, so the cloud refused to sync (this computer's compatibility version is ${COMPAT_VERSION}; the cloud requires 3 or later). Update hangar on this computer`);
    // 版の下限が読めなかったとき
    expect(errorText('en', new CompatError('device', COMPAT_VERSION, null))).toContain('requires a newer version');
    const worker = new CompatError('worker', 1, 2);
    expect(errorText('ja', worker)).toContain('「今すぐ同期」');
    expect(errorText('en', worker)).toContain('"Sync now"');
    expect(errorText('en', worker)).toContain('hangar setup cloud');
  });

  it('message は日本語のままで、言語を知らない呼び手とログは今までどおり読める', () => {
    expect(new CompatError('worker', 1, 2).message).toBe(errorText('ja', new CompatError('worker', 1, 2)));
    expect(new LimitError('d1-write', 429).message).toBe('Cloudflare の無料枠の上限（D1 の 1 日の書き込み）に達しました');
  });

  it('無料枠の上限の失敗は、どの上限かを言語ごとに言う', () => {
    expect(errorText('en', new LimitError('d1-read', 429))).toBe('Reached the Cloudflare free tier limit (D1 reads per day)');
    expect(errorText('en', new LimitError('d1-write', 429))).toBe('Reached the Cloudflare free tier limit (D1 writes per day)');
    expect(errorText('en', new LimitError('requests', 429))).toBe('Reached the Cloudflare free tier limit (Workers requests per day)');
    expect(errorText('ja', new LimitError('requests', 429))).toBe('Cloudflare の無料枠の上限（Workers の 1 日のリクエスト）に達しました');
  });

  it('応答の本文をそのまま持つ失敗は、言語に依らずその文字列を返す', () => {
    const e = new CloudError(500, 'boom');
    expect(e).toBeInstanceOf(MessageError);
    expect(errorText('en', e)).toBe('boom');
  });
});

describe('同期の知らせの文', () => {
  it('上限で止めた知らせは、戻る時刻をその言語の書き方で言う', () => {
    const noon = Date.UTC(2026, 9, 9, 15);
    expect(limitedMessage(noon, 'UTC')).toBe('Cloudflare の無料枠の上限に達したので、15:00 まで同期を停止します。枠がリセットされると自動で再開します');
    expect(limitedMessage(noon, 'UTC', 'en')).toBe('The Cloudflare free tier limit was reached, so sync is paused until 3:00 PM. It resumes automatically after the limit resets');
  });

  it('一時停止のまま頼んだ 1 巡が上限で断られた知らせは、時刻も自動の再開も言わない', () => {
    expect(limitedWhilePausedMessage()).toBe('Cloudflare の無料枠の上限に達したので、同期できませんでした。同期は一時停止のままです');
    expect(limitedWhilePausedMessage('en')).toBe('Could not sync because the Cloudflare free tier limit was reached. Sync is still paused');
  });

  it('変更ログが古くなって作り直した知らせ', () => {
    expect(resyncedMessage()).toBe('クラウドの変更ログが古くなっていたので、全体を再同期しました');
    expect(resyncedMessage('en')).toBe("The cloud's change log had expired, so sync was redone from the beginning");
  });
});

describe('復号の失敗の文', () => {
  const decrypt = async (bytes: Buffer): Promise<unknown> => {
    const out: Buffer[] = [];
    try {
      for await (const c of Readable.from([bytes]).pipe(decryptStream(deriveFileKey('s')))) out.push(c as Buffer);
    } catch (e) { return e; }
    return null;
  };

  it('暗号化ファイルでないものと、切り詰められたものは、辞書の文を持つ失敗になる', async () => {
    const notEncrypted = await decrypt(Buffer.alloc(64, 1));
    expect(notEncrypted).toBeInstanceOf(MessageError);
    expect(errorText('ja', notEncrypted)).toBe('暗号化ファイルの形式が違います');
    expect(errorText('en', notEncrypted)).toBe('Not an encrypted file (unrecognized format)');

    const whole = await encryptBuffer(deriveFileKey('s'), Buffer.from('hello'));
    const cut = await decrypt(whole.subarray(0, whole.length - 5));
    expect(errorText('ja', cut)).toBe('暗号化ファイルが切り詰められています（truncated）');
    expect(errorText('en', cut)).toBe('The encrypted file is truncated');

    const extra = await decrypt(Buffer.concat([whole, Buffer.alloc(40, 7)]));
    expect(errorText('en', extra)).toBe('There is data after the final chunk');
  });
});

describe('本文を降ろす失敗の文', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const key = deriveFileKey('join-secret');
  let cloud: FakeCloudClient;
  let home: string;
  beforeEach(() => {
    cloud = new FakeCloudClient({ deviceId: 'dev-a' });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('怪しい端末の ID と相対パスは、辞書の文を持つ失敗で断る', () => {
    const bad = (fn: () => void): unknown => { try { fn(); } catch (e) { return e; } return null; };
    const id = bad(() => remoteTranscriptPath('/h', '../evil', 'projects/x.jsonl'));
    expect(errorText('ja', id)).toBe('PC の ID が不正です: ../evil');
    expect(errorText('en', id)).toBe('Invalid computer ID: ../evil');
    const rel = bad(() => remoteTranscriptPath('/h', 'dev-b', 'skills/x.md'));
    expect(errorText('en', rel)).toBe('Invalid transcript path: skills/x.md');
  });

  it('SHA-256 が合わない本文は、諦めた項目の理由に、いまの言語の文で残る', async () => {
    const text = '{"a":1}\n';
    const enc = await encryptBuffer(key, gzipSync(Buffer.from(text)));
    const k = `transcripts/dev-b/${UUID}.jsonl.gz`;
    const meta: FileMetaIn = { key: k, path: `projects/-w-alpha/${UUID}.jsonl`, kind: 'transcript', sha256: sha256Hex('different'), size: 8, mtime: 1_700_000_000_000, encrypted: true };
    await cloud.asDevice('dev-b').putFile(meta, Readable.from([enc]));
    for (const [language, expected] of [['ja', `トランスクリプトの SHA-256 が一致しません: ${k}`], ['en', `Transcript SHA-256 does not match: ${k}`]] as const) {
      // 言語ごとに新しい DB で試す。諦めた回数と理由は DB（sync_state）に残る。
      const fresh = openDb(':memory:');
      const p = new RemotePuller({ db: fresh, deviceId: 'dev-a', home, client: cloud, key, state: new SyncStateStore(fresh), language: () => language });
      // 3 回続けて失敗した項目だけが、諦めた項目として利用者に見える。
      for (let i = 0; i < 3; i++) await p.pullNow();
      expect(p.skippedEntries().map((s) => s.message)).toEqual([expected]);
    }
  });
});
