import { decodeEpochList, E2eOpenError, fromBase64Url, importPrivate, openKeybox, openRoster, sealRoster, toBase64Url, type Roster } from '@agent-hangar/shared';
import type { CloudConfig } from '../config/cloud.ts';
import type { WireCloudClient } from './client.ts';
import type { Keyring } from './keyring.ts';

/** 名簿の読み書きが使う線の口。 */
export type RosterWire = Pick<WireCloudClient, 'getRoster' | 'putRoster' | 'getKeyboxes'>;

/**
 * cloud.json の読み書き。
 * 読むのは鍵ペアと、最後に読んだ名簿の版である。
 * 書くのは keybox から足した世代鍵（Keyring.toConfigPatch）と、名簿の版である。
 */
export type ConfigWriter = {
  read(): CloudConfig;
  write(patch: Partial<Pick<CloudConfig, 'epochs' | 'currentEpoch' | 'phoneKey' | 'rosterVersion'>>): void;
};

/** 名簿がまだ無い（GET /roster が 404）ときの中身。版 0 で、最初の update が `ifVersion: 0` で作る。 */
export const EMPTY_ROSTER: Roster = { v: 1, entries: [], recoveryPub: '', phoneKey: null };

/** update が 409 を受けて読み直し、当て直す回数の上限（最初の 1 回を含む）。 */
export const ROSTER_MAX_TRIES = 3;

/** update が ROSTER_MAX_TRIES 回とも版の食い違いで断られた。 */
export class RosterConflictError extends Error {
  constructor() {
    super(`the roster kept changing; gave up after ${ROSTER_MAX_TRIES} tries`);
    this.name = 'RosterConflictError';
  }
}

export type RosterRead = { version: number; roster: Roster };

const copy = (r: RosterRead): RosterRead => ({ version: r.version, roster: structuredClone(r.roster) });

/**
 * 封じた名簿（`GET /roster`、`PUT /roster`）と、自分宛ての keybox（`GET /keyboxes`）の読み書き。
 *
 * 名簿は今の世代の `/roster` の鍵で封じ、AAD に書いた後の版の番号を入れる。
 * 開くときは手元の世代を新しい順に試す（GET /roster の応答は封じた世代を名乗らない）。
 * 読んだ名簿はメモリに持ち、invalidate されるまで、版が cloud.json の rosterVersion と同じ間は Worker に読みに行かない。
 * 名簿の印の行を見たら invalidate し、次の read で読み直す。読み直した版が手元と同じなら開き直さない。
 *
 * 書き換え（update）は版の番号つきの条件付き更新で、409 なら読み直して fn を当て直す。
 * 2 台が同時に書き換えても、後から書く方が先の変更の上に当て直すので、どちらの変更も残る。
 *
 * 読んだ名簿と書いた名簿のスマホ用の鍵（phoneKey）は、Keyring と cloud.json に写す（adoptPhoneKey）。
 * スマホ用の鍵の keybox は名簿の印の行を進めないので、PC は名簿からだけ M を知る。
 *
 * 名簿がまだ無い（404）ことと、自分宛ての keybox がまだ無いことは、ふつうの状態で投げない。
 * 開けない名簿と keybox も、refresh では投げずに飛ばす（console.warn は英語で、中身を出さない）。
 * SealedCloudClient の onRoster が投げると pull が区切りを進めないので、投げてよいのは通信と Worker の失敗だけである。
 */
export class RosterStore {
  private readonly ring: Promise<Keyring>;
  private cache: RosterRead | null = null;
  private stale = false;

  constructor(
    private readonly wire: RosterWire,
    keyring: Keyring | Promise<Keyring>,
    private readonly cfg: ConfigWriter,
    /** keybox の AAD の受け手。Worker がこの PC の端末トークンで知る ID と同じもの。 */
    private readonly deviceId: string,
  ) {
    this.ring = Promise.resolve(keyring);
    // 読めない Keyring は、呼んだときにその失敗で倒す。作っただけで未処理の拒否にしない。
    this.ring.catch(() => {});
  }

  /** 名簿か keybox が変わったかもしれない（印の行を見た）。次の read は Worker から読み直す。 */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * 手元に持っている名簿の写しを返す。Worker には読みに行かない。
   * まだ一度も読んでいなければ null を返す。invalidate された後も、読み直すまでは前の写しを返す。
   * 何度も呼ぶ道（本文の走査）が、呼ぶたびに GET /roster を増やさないための口である。
   */
  cached(): RosterRead | null {
    return this.cache ? copy(this.cache) : null;
  }

  /**
   * 名簿を読む。
   * 手元の写しがあり、invalidate されておらず、その版が cloud.json の rosterVersion と同じなら、Worker に読みに行かない。
   * 手元のどの世代の鍵でも開けなければ E2eOpenError を投げる。
   */
  async read(): Promise<RosterRead> {
    if (this.cache && !this.stale && this.cache.version === this.cfg.read().rosterVersion) return copy(this.cache);
    const ring = await this.ring;
    const got = await this.wire.getRoster();
    if (!got) return this.remember({ version: 0, roster: EMPTY_ROSTER });
    if (this.cache && this.cache.version === got.version) return this.remember(this.cache);
    const sealed = fromBase64Url(got.sealed);
    if (!sealed) throw new E2eOpenError();
    for (const epoch of ring.epochs()) {
      let roster: Roster;
      try {
        roster = await openRoster(ring.at(epoch)!.roster, got.version, sealed);
      } catch (e) {
        if (!(e instanceof E2eOpenError)) throw e;
        continue;
      }
      await this.adoptPhoneKey(roster);
      return this.remember({ version: got.version, roster });
    }
    throw new E2eOpenError();
  }

  /**
   * 名簿を書き換える。
   * 手元の名簿に fn を当て、今の世代で封じ、読んだ版を条件に置く。
   * 409 なら読み直して fn を当て直し、ROSTER_MAX_TRIES 回とも断られたら RosterConflictError を投げる。
   * fn は当て直しのたびに呼ばれるので、同じ名簿には同じ結果を返すこと。
   */
  async update(fn: (r: Roster) => Roster): Promise<RosterRead> {
    const ring = await this.ring;
    let base = await this.read();
    for (let tries = 1; ; tries++) {
      const next = fn(structuredClone(base.roster));
      const cur = ring.current();
      const version = base.version + 1;
      const sealed = toBase64Url(await sealRoster(cur.roster, version, next));
      const r = await this.wire.putRoster({ ifVersion: base.version, epoch: cur.epoch, sealed });
      if (r.ok) {
        await this.adoptPhoneKey(next);
        return this.remember({ version, roster: next });
      }
      if (tries >= ROSTER_MAX_TRIES) throw new RosterConflictError();
      this.stale = true;
      base = await this.read();
    }
  }

  /**
   * 自分宛ての keybox を読み、世代鍵の一覧を Keyring に足して cloud.json に書き戻す。
   * keybox はいちばん新しい 1 つだけが返り、中身は世代 1 から n までの一覧である。
   * 新しい世代の鍵が 1 つでも増えたら true を返す。
   * keybox がまだ無いとき、開けないときは false を返し、投げない。
   */
  async refreshKeyboxes(): Promise<boolean> {
    const ring = await this.ring;
    const { boxes } = await this.wire.getKeyboxes();
    const box = boxes.reduce<(typeof boxes)[number] | null>((a, b) => (a === null || b.epoch > a.epoch ? b : a), null);
    if (!box) return false;
    let list;
    try {
      const sealed = fromBase64Url(box.sealed);
      if (!sealed) throw new E2eOpenError();
      const { keyPair } = this.cfg.read();
      list = decodeEpochList(await openKeybox(await importPrivate(keyPair.priv), keyPair.pub, { epoch: box.epoch, recipient: this.deviceId }, sealed));
    } catch {
      // 別の相手宛ての箱か、壊れた箱か、手元の鍵ペアが読めない。読み直しても変わらないので飛ばす。
      console.warn(`[roster] the newest keybox for this PC (epoch ${box.epoch}) could not be opened`);
      return false;
    }
    const before = ring.epochs().length;
    await ring.addEpochs(list);
    if (ring.epochs().length === before) return false;
    this.cfg.write(ring.toConfigPatch());
    return true;
  }

  /**
   * 名簿の印の行か、知らない世代の行を受けたときの読み直し（SealedCloudClient の onRoster から）。
   * keybox を先に読む（新しい世代で封じた名簿は、その世代の鍵が無いと開けない）。
   * 次に名簿を読み直す。開けない名簿は飛ばす。
   * 新しい世代の鍵が届いたら true を返す。
   */
  async refresh(): Promise<boolean> {
    const gained = await this.refreshKeyboxes();
    this.stale = true;
    try {
      await this.read();
    } catch (e) {
      if (!(e instanceof E2eOpenError)) throw e;
      console.warn('[roster] the roster could not be opened with the epoch keys this PC holds');
    }
    return gained;
  }

  /**
   * 名簿のスマホ用の鍵（phoneKey）を Keyring と cloud.json に写す。
   * 他の PC が最初のスマホを接続して M[1] を作ったときと、スマホを解除して次の世代にしたときに、この PC も同じ鍵で封じて開けるようにする。
   * 手元より古い世代には戻さない。名簿に phoneKey が無いときは手元のままにする。
   * 鍵の形が違う、cloud.json に書けないときも投げない（読んだ名簿は使えるので、pull を倒さない）。
   */
  private async adoptPhoneKey(r: Roster): Promise<void> {
    const pk = r.phoneKey;
    if (!pk) return;
    const ring = await this.ring;
    const have = ring.toConfigPatch().phoneKey;
    if (have && (have.epoch > pk.epoch || (have.epoch === pk.epoch && have.key === pk.key))) return;
    try {
      await ring.setPhoneKey(pk);
    } catch (e) {
      console.warn('[roster] the phone key in the roster could not be read', e instanceof Error ? e.constructor.name : typeof e);
      return;
    }
    try {
      this.cfg.write({ phoneKey: ring.toConfigPatch().phoneKey });
    } catch (e) {
      console.error('[roster] could not save the phone key to cloud.json', e instanceof Error ? e.constructor.name : typeof e);
    }
  }

  /**
   * 読んだ名簿をメモリに持ち、版を cloud.json に書く。
   * 書けなくても（手元のディスクの失敗）投げない。投げると onRoster から pull が倒れ、区切りが進まなくなる。
   * 書けなかった版は、次の read で写しと食い違うので Worker から読み直す。
   */
  private remember(r: RosterRead): RosterRead {
    this.cache = copy(r);
    this.stale = false;
    if (this.cfg.read().rosterVersion !== r.version) {
      try {
        this.cfg.write({ rosterVersion: r.version });
      } catch (e) {
        console.error('[roster] could not save the roster version to cloud.json', e instanceof Error ? e.constructor.name : typeof e);
      }
    }
    return copy(r);
  }
}

/**
 * SealedCloudClient に渡す onRoster。
 * 名簿と keybox を読み直し、新しい世代の鍵が届いたら onGained を呼ぶ。
 * onGained は飛ばした行と本文の区切りを巻き戻す（SyncEngine.rewindSkippedRows、RemotePuller.rewindSkipped）。
 * 巻き戻しは走っている pull の終わりを待つので、onGained はそれを待たずに返すこと（pull の中から呼ばれる）。
 */
export function rosterRefresh(store: Pick<RosterStore, 'refresh'>, onGained: () => void): () => Promise<void> {
  return async () => {
    if (await store.refresh()) onGained();
  };
}
