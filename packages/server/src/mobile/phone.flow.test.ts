import { describe, expect, it } from 'vitest';
import {
  aadAnswer,
  aadFeed,
  aadLaunch,
  decodePairing,
  encodePairing,
  generateKeyPair,
  generatePhoneKeyPair,
  importMobileKey,
  open,
  openPhoneKeybox,
  seal,
  sealPhoneJoinRequest,
  type MobileFeed,
  type MobileLaunchAnswer,
  type MobileLaunchPayload,
} from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { Keyring } from '../sync/keyring.ts';
import { phoneKeysOf } from '../sync/phoneKeys.ts';
import { RosterStore, type ConfigWriter } from '../sync/roster.ts';
import { FakeCloudClient, seedCloud } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { MobileLaunchInbox } from './launchInbox.ts';
import { PhonePairer } from './pairer.ts';
import { MobileFeedPublisher } from './publisher.ts';

// PC とスマホの通し（偽のクラウドの上）。
// PC は QR を出し（券）、スマホは shared の関数で鍵ペアを作って接続し、PC が置いた keybox を開いて M を得て、受信箱の素を開き、起動の依頼を出す。
// QR に鍵が無いこと、Worker（偽物）に M も平文も残らないことも見る。

const feed: MobileFeed = {
  v: 1,
  deviceId: 'pc-a',
  deviceName: 'pc-a',
  accounts: [],
  projects: [{ id: 'project-a', name: 'project-a', lastUsedAt: null }],
  live: [],
  returns: [],
  done: [{ sessionId: 's1', projectName: 'project-a', title: '会話 1', oneLiner: null, doneAt: 1 }],
};

describe('PC とスマホの通し', () => {
  it('QR で接続し、keybox を開き、受信箱の素を開き、起動の依頼の答えを開ける', async () => {
    const seeded = await seedCloud([{ id: 'pc-a', name: 'pc-a', keyPair: await generateKeyPair() }]);
    const wire = seeded.wire;
    let cfg: CloudConfig = seeded.configs['pc-a']!;
    const writer: ConfigWriter = { read: () => cfg, write: (p) => { cfg = { ...cfg, ...p }; } };
    const keyring = await Keyring.fromConfig(cfg);
    const roster = new RosterStore(wire, keyring, writer, 'pc-a');
    const phoneKeys = phoneKeysOf(keyring, roster);
    const client = new FakeCloudClient({ wire, keyring });
    const timers = new FakeTimers();
    const pub = new MobileFeedPublisher({ build: () => feed, client, phoneKeys, deviceId: 'pc-a', timers, canWrite: () => true, hasPhones: () => true });

    // スマホを接続する前は、受信箱の素を書かない（M が無い）。
    expect(await pub.flushNow()).toBe('skipped');

    // PC：QR を出す。中身は url、券、PC の名前、期限だけ。
    const pairer = new PhonePairer({ wire, roster, timers: { set: () => null, clear: () => {} } });
    const ticket = await wire.createPairing();
    await pairer.watch(ticket);
    const pairText = encodePairing({ url: 'https://w.example', code: ticket.code, pcName: 'pc-a', expiresAt: ticket.expiresAt });

    // スマホ：QR を読み、鍵ペアを作り、公開鍵を券で封じて接続する。
    const blob = decodePairing(pairText);
    expect(Object.keys(blob).sort()).toEqual(['code', 'expiresAt', 'pcName', 'url']);
    const pair = await generatePhoneKeyPair();
    const joined = wire.joinPhone({ code: blob.code, deviceId: 'phone-1', sealed: await sealPhoneJoinRequest(blob.code, 'phone-1', { pub: pair.pub, name: 'phone-1' }) });
    expect(joined.deviceId).toBe('phone-1');
    // PC が置くまで、スマホの keybox は無い（GET /m/keybox は 404）。
    expect(wire.phoneKeybox('phone-1')).toBeNull();

    // PC：QR を出している間の問い合わせで、名簿にスマホを足し、M の keybox を置く。
    await pairer.pollOnce();
    const box = wire.phoneKeybox('phone-1');
    expect(box).not.toBeNull();

    // スマホ：keybox を自分の秘密鍵で開いて M を得る。
    const m = await importMobileKey(await openPhoneKeybox(pair.key, pair.pub, 'phone-1', box!));

    // PC：受信箱の素を M で封じ、世代を添えて置く。
    expect(await pub.flushNow()).toBe('written');
    const [row] = wire.inboxFeeds();
    expect(row).toMatchObject({ deviceId: 'pc-a', epoch: box!.epoch });
    // スマホ：素の世代の M で開く。
    expect(await open<MobileFeed>(m, aadFeed('pc-a'), row!.sealed)).toEqual(feed);

    // スマホ：同じ世代の M で起動の依頼を封じて出す。PC は依頼の世代の M で開き、同じ世代で答えを封じる。
    const db = openDb(':memory:');
    const inbox = new MobileLaunchInbox({
      db, client, phoneKeys, deviceId: 'pc-a', dropsDir: '/nonexistent-drops',
      start: () => ({ run: { id: 'run-1', sessionId: 's-new' } as never, sessionId: 's-new', tabs: [] }),
      hasProjectHere: () => true, hasAccount: () => true, canProcess: () => true, now: Date.now,
    });
    const payload: MobileLaunchPayload = { v: 1, createdAt: Date.now(), projectId: 'project-a', scratch: false, accountId: 'primary', permissionMode: '', model: '', prompt: '会話 2 を始める' };
    wire.postLaunch({ id: 'l1', targetDevice: 'pc-a', sealed: await seal(m, aadLaunch('l1', 'pc-a'), payload), epoch: box!.epoch });
    await inbox.receive((await client.pullChanges(0, 100)).launches ?? []);
    const answer = await open<MobileLaunchAnswer>(m, aadAnswer('l1'), wire.launches.get('l1')!.sealedAnswer!);
    expect(answer).toMatchObject({ ok: true, sessionId: 's-new' });

    // Worker（偽物）に M も、スマホの名前も、素の平文も残らない。
    const stored = JSON.stringify([...wire.storeForScan().mobileFeeds.values(), ...wire.storeForScan().mobilePairings.values(), [...wire.storeForScan().phoneKeyboxes.values()].map((x) => [...x.values()])]);
    expect(stored).not.toContain(cfg.phoneKey!.key);
    expect(stored).not.toContain('会話 1');
    expect(stored).not.toContain(ticket.code);
  });
});
