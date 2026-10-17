/**
 * 名簿：参加している PC とスマホの一覧と、リカバリーキーの公開鍵を 1 つの文書にして、`/roster` の鍵で封じる。
 *
 * AAD は名簿の版の番号で、古い版の封じを新しい版として差し出されても開けない。
 * スマホ用の鍵（phoneKey）もここに入れ、PC だけが読める（スマホは `/roster` の鍵を持たない）。
 *
 * epochClaim は、世代を回す PC が確保した世代の番号と、確保した PC の ID である。
 * 名簿の書き換えは版の条件付き更新なので、2 台が同時に回しても同じ番号は確保できない。
 * 古い名簿には無いので、任意の項目にする。
 */

import { fromBase64Url } from './bytes.ts';
import { E2eOpenError, openJson, sealJson } from './seal.ts';

export type RosterEntry = { id: string; kind: 'pc' | 'phone'; name: string; os: string; pub: string; joinedAt: number };

export type EpochClaim = { epoch: number; by: string };

export type Roster = { v: 1; entries: RosterEntry[]; recoveryPub: string; phoneKey: { epoch: number; key: string } | null; epochClaim?: EpochClaim };

const aad = (version: number): string => JSON.stringify(['roster', version]);

export async function sealRoster(key: CryptoKey, version: number, r: Roster): Promise<Uint8Array> {
  return sealJson(key, aad(version), { v: r.v, entries: r.entries, recoveryPub: r.recoveryPub, phoneKey: r.phoneKey, ...(r.epochClaim ? { epochClaim: r.epochClaim } : {}) });
}

const isKey32 = (s: unknown): s is string => typeof s === 'string' && fromBase64Url(s)?.length === 32;

function isEntry(e: unknown): e is RosterEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return typeof o.id === 'string' && (o.kind === 'pc' || o.kind === 'phone') && typeof o.name === 'string' && typeof o.os === 'string' && isKey32(o.pub) && typeof o.joinedAt === 'number';
}

function isClaim(c: unknown): c is EpochClaim {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  return Number.isSafeInteger(o.epoch) && (o.epoch as number) >= 1 && typeof o.by === 'string' && o.by !== '';
}

/** 封じた名簿を開く。鍵、版の番号、形のどれが違っても E2eOpenError を投げる。 */
export async function openRoster(key: CryptoKey, version: number, sealed: Uint8Array): Promise<Roster> {
  const v = (await openJson(key, aad(version), sealed)) as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || v.v !== 1 || !Array.isArray(v.entries) || !v.entries.every(isEntry) || !isKey32(v.recoveryPub)) throw new E2eOpenError();
  const pk = v.phoneKey as { epoch?: unknown; key?: unknown } | null | undefined;
  if (pk !== null && (typeof pk !== 'object' || typeof pk.epoch !== 'number' || !isKey32(pk.key))) throw new E2eOpenError();
  if (v.epochClaim !== undefined && !isClaim(v.epochClaim)) throw new E2eOpenError();
  const claim = v.epochClaim as EpochClaim | undefined;
  return {
    v: 1,
    entries: v.entries.map((e: RosterEntry) => ({ id: e.id, kind: e.kind, name: e.name, os: e.os, pub: e.pub, joinedAt: e.joinedAt })),
    recoveryPub: v.recoveryPub,
    phoneKey: pk === null ? null : { epoch: pk.epoch as number, key: pk.key as string },
    ...(claim ? { epochClaim: { epoch: claim.epoch, by: claim.by } } : {}),
  };
}
