import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

export const CHUNK_SIZE = 1 << 20;
const MAGIC = Buffer.from('HGR1');
const PREFIX_LEN = 8;
const HEADER_LEN = MAGIC.length + PREFIX_LEN;
const TAG_LEN = 16;
const FRAME_HEAD = 5; // flag(1) + len(4)

/** 参加用の秘密から HKDF（SHA-256）でファイル鍵を導く。salt と info は全端末で同じ定数にする。 */
export function deriveFileKey(joinSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(joinSecret, 'utf8'), 'hangar-salt-v1', 'hangar-file-v1', 32));
}

const nonceOf = (prefix: Buffer, idx: number): Buffer => { const n = Buffer.alloc(12); prefix.copy(n, 0); n.writeUInt32BE(idx, 8); return n; };
const aadOf = (idx: number, flag: number): Buffer => { const a = Buffer.alloc(5); a.writeUInt32BE(idx, 0); a[4] = flag; return a; };

/** 平文を 1MB ごとに AES-256-GCM で包む Transform。最後のチャンクは flag = 1 で出す。 */
export function encryptStream(key: Buffer, noncePrefix: Buffer = randomBytes(PREFIX_LEN)): Transform {
  if (noncePrefix.length !== PREFIX_LEN) throw new Error('nonce 接頭辞は 8 バイト');
  let pending: Buffer[] = [];
  let buffered = 0;
  let idx = 0;
  let headerSent = false;
  const emit = (self: Transform, plain: Buffer, last: boolean) => {
    if (!headerSent) { self.push(Buffer.concat([MAGIC, noncePrefix])); headerSent = true; }
    const flag = last ? 1 : 0;
    const c = createCipheriv('aes-256-gcm', key, nonceOf(noncePrefix, idx));
    c.setAAD(aadOf(idx, flag));
    const body = Buffer.concat([c.update(plain), c.final()]);
    const head = Buffer.alloc(FRAME_HEAD);
    head[0] = flag;
    head.writeUInt32BE(body.length, 1);
    self.push(Buffer.concat([head, body, c.getAuthTag()]));
    idx++;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      pending.push(chunk);
      buffered += chunk.length;
      // 最終チャンクを flush で出すため、ちょうど 1MB 残るまでは出さない。
      while (buffered > CHUNK_SIZE) {
        const all = Buffer.concat(pending);
        emit(this, all.subarray(0, CHUNK_SIZE), false);
        const rest = all.subarray(CHUNK_SIZE);
        pending = rest.length ? [Buffer.from(rest)] : [];
        buffered = rest.length;
      }
      cb();
    },
    flush(cb) {
      emit(this, Buffer.concat(pending), true);
      cb();
    },
  });
}

/** encryptStream の逆。magic、タグ、末尾の切り詰め、最終チャンク後の余りを検査する。 */
export function decryptStream(key: Buffer): Transform {
  let buf = Buffer.alloc(0);
  let prefix: Buffer | null = null;
  let idx = 0;
  let finished = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (!prefix) {
          if (buf.length < HEADER_LEN) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('暗号化ファイルの形式が違います');
          prefix = Buffer.from(buf.subarray(MAGIC.length, HEADER_LEN));
          buf = buf.subarray(HEADER_LEN);
        }
        while (buf.length >= FRAME_HEAD) {
          if (finished) throw new Error('最終チャンクの後にデータがあります');
          const flag = buf[0]!;
          const len = buf.readUInt32BE(1);
          if (buf.length < FRAME_HEAD + len + TAG_LEN) break;
          const body = buf.subarray(FRAME_HEAD, FRAME_HEAD + len);
          const tag = buf.subarray(FRAME_HEAD + len, FRAME_HEAD + len + TAG_LEN);
          const d = createDecipheriv('aes-256-gcm', key, nonceOf(prefix, idx));
          d.setAAD(aadOf(idx, flag));
          d.setAuthTag(tag);
          this.push(Buffer.concat([d.update(body), d.final()]));
          idx++;
          buf = buf.subarray(FRAME_HEAD + len + TAG_LEN);
          if (flag === 1) finished = true;
        }
        if (finished && buf.length > 0) throw new Error('最終チャンクの後にデータがあります');
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush(cb) {
      if (!finished) return cb(new Error('暗号化ファイルが切り詰められています（truncated）'));
      cb();
    },
  });
}

const collect = async (s: Readable): Promise<Buffer> => { const out: Buffer[] = []; for await (const c of s) out.push(c as Buffer); return Buffer.concat(out); };

export function encryptBuffer(key: Buffer, data: Buffer): Promise<Buffer> {
  return collect(Readable.from([data]).pipe(encryptStream(key)));
}

export function decryptBuffer(key: Buffer, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = decryptStream(key);
    d.on('error', reject);
    collect(d).then(resolve, reject);
    Readable.from([data]).pipe(d);
  });
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256Stream(input: Readable): Promise<string> {
  const h = createHash('sha256');
  for await (const c of input) h.update(c as Buffer);
  return h.digest('hex');
}
