import { describe, expect, it } from 'vitest';
import { CLOUD_FREE_LIMITS, r2Included, decodeHeaderText, encodeFileKeyPath, encodeHeaderText, isAllowedJoinUrl, isHeaderSafe, isSafeKeyId, isSafeRelPath, MAX_ID_CHARS, MAX_JOIN_URL_CHARS, MAX_REL_PATH_CHARS, SHARED_TABLES, TABLE_PK } from './cloud.ts';

describe('鍵と表', () => {
  it('共有テーブルは 16 で、主キーは session_summaries と session_states と project_memos と config_snapshots だけが違う', () => {
    expect(SHARED_TABLES).toHaveLength(16);
    expect(SHARED_TABLES).not.toContain('takeover_requests');
    expect(Object.keys(TABLE_PK).sort()).toEqual([...SHARED_TABLES].sort());
    expect(TABLE_PK.session_summaries).toBe('session_id');
    expect(TABLE_PK.session_states).toBe('session_id');
    expect(TABLE_PK.session_notes).toBe('session_id');
    expect(TABLE_PK.project_memos).toBe('project_id');
    expect(TABLE_PK.runs).toBe('id');
    // 設定の束（PC ごとに 1 行）。主キーは端末の ID で、子として親を持たない。
    expect(TABLE_PK.config_snapshots).toBe('device_id');
    // 引き継ぎの頼みと応答は、親を持たない一時の行なので末尾に置く。
    expect(SHARED_TABLES.slice(-2)).toEqual(['takeovers', 'takeover_answers']);
  });
  it('引き継ぎの頼みと応答は共有表で運ぶ', () => {
    expect(SHARED_TABLES).toContain('takeovers');
    expect(SHARED_TABLES).toContain('takeover_answers');
    expect(TABLE_PK.takeovers).toBe('id');
    expect(TABLE_PK.takeover_answers).toBe('ask_id');
  });
  it('session_states は session_summaries の直後に適用する（親の sessions より後）', () => {
    expect(SHARED_TABLES.indexOf('session_states')).toBe(SHARED_TABLES.indexOf('session_summaries') + 1);
    expect(SHARED_TABLES.indexOf('session_states')).toBeGreaterThan(SHARED_TABLES.indexOf('sessions'));
    // session_notes も sessions の子である。親より後に当てる。
    expect(SHARED_TABLES.indexOf('session_notes')).toBeGreaterThan(SHARED_TABLES.indexOf('sessions'));
  });
});

describe('参加の接続先の検査', () => {
  it('https 以外のスキームを断る', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'http://evil.example.com', 'ftp://x.example.com', 'data:text/html,x']) {
      expect(isAllowedJoinUrl(u), u).toBe(false);
    }
  });
  it('URL として読めない文字列を断る', () => {
    for (const u of ['not a url at all', 'x', '//evil.example.com', 'https://']) {
      expect(isAllowedJoinUrl(u), u).toBe(false);
    }
  });
  it('開発とテスト用の loopback の http だけは通す', () => {
    for (const u of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect(isAllowedJoinUrl(u), u).toBe(true);
    }
    expect(isAllowedJoinUrl('https://hangar.example.workers.dev')).toBe(true);
  });
  it('ユーザ情報とパスと問い合わせと素片のついた URL を断る', () => {
    for (const u of ['https://user:pass@x.workers.dev', 'https://user@x.workers.dev', 'https://x.workers.dev/join', 'https://x.workers.dev/?a=1', 'https://x.workers.dev/#f']) {
      expect(isAllowedJoinUrl(u), u).toBe(false);
    }
    // 素の origin は、末尾のスラッシュの有無にかかわらず通る。
    expect(isAllowedJoinUrl('https://x.workers.dev')).toBe(true);
    expect(isAllowedJoinUrl('https://x.workers.dev/')).toBe(true);
  });
  it('長すぎる URL を断る', () => {
    expect(isAllowedJoinUrl('https://' + 'a'.repeat(MAX_JOIN_URL_CHARS) + '.workers.dev')).toBe(false);
  });
});

describe('相対パスと ID の検査', () => {
  it('相対パスは .. と先頭のスラッシュと空の断片と制御文字を断る', () => {
    for (const p of ['', '.', '..', '../../etc/passwd', '/etc/passwd', 'a//b', 'a/./b', 'a/../../b', 'skills/x/', 'a\u0000b', 'a\nb', 'a'.repeat(MAX_REL_PATH_CHARS + 1)]) {
      expect(isSafeRelPath(p), p).toBe(false);
    }
    expect(isSafeRelPath('skills/x/SKILL.md')).toBe(true);
    expect(isSafeRelPath('skills/日本語 メモ/SKILL.md')).toBe(true);
  });
  it('ID はスラッシュ、ドット始まり、空白、制御文字、長すぎるものを断る', () => {
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a b', 'a\u0000', '-a', 'a'.repeat(MAX_ID_CHARS + 1)]) expect(isSafeKeyId(bad), bad).toBe(false);
    expect(isSafeKeyId('0199b0d1-2b3c-7def-8000-0123456789ab')).toBe(true);
  });
});


describe('見出しに載せる文字列の符号化', () => {
  // HTTP の見出しの値は ByteString しか運べない。
  // 非 ASCII を渡すと Node の fetch は送る前に TypeError を投げるので、Worker 側では直せない。
  const cases = [
    'projects/-x/u1.jsonl',
    'projects/-Users-me-作業/メモ 1.jsonl',
    'skills/日本語 メモ/SKILL.md',
    'a%2Fb',
    'a%',
    '100% でき/た.md',
    'emoji/🐕.md',
    "quote'and\"and`.md",
    'tab\tと改行\nと復帰\r.md',
    'ぜんぶ'.repeat(50),
  ];

  it('往復して元に戻る', () => {
    for (const s of cases) {
      const wire = encodeHeaderText(s);
      expect(wire, s).not.toBeNull();
      expect(decodeHeaderText(wire!), s).toBe(s);
    }
  });

  it('符号化した結果は見出しに載せられる ASCII だけになる', () => {
    for (const s of cases) {
      const wire = encodeHeaderText(s)!;
      expect(isHeaderSafe(wire), wire).toBe(true);
      // 実物の見出しに載せられることを undici の検査そのもので確かめる。
      expect(() => new Headers({ 'x-hangar-path': wire })).not.toThrow();
    }
    // 符号化しないと落ちる。これが直そうとしている現象である。
    expect(() => new Headers({ 'x-hangar-path': 'メモ' })).toThrow(TypeError);
  });

  it('スラッシュは読みやすさのために残し、百分率は必ず符号化する', () => {
    expect(encodeHeaderText('a/b/c.md')).toBe('a/b/c.md');
    expect(encodeHeaderText('a b')).toBe('a%20b');
    expect(encodeHeaderText('a%2Fb')).toBe('a%252Fb');
    expect(decodeHeaderText('a%252Fb')).toBe('a%2Fb');
  });

  it('形が壊れていれば null にする（例外を投げない）', () => {
    expect(decodeHeaderText('%')).toBeNull();
    expect(decodeHeaderText('%zz')).toBeNull();
    expect(decodeHeaderText('%E3%81')).toBeNull();
    expect(encodeHeaderText('\ud800')).toBeNull(); // 単独のサロゲート
  });

  it('isHeaderSafe は制御文字と非 ASCII を断る', () => {
    expect(isHeaderSafe('a/b c%20d')).toBe(true);
    expect(isHeaderSafe('')).toBe(true);
    expect(isHeaderSafe('メモ')).toBe(false);
    expect(isHeaderSafe('a\nb')).toBe(false);
    expect(isHeaderSafe('a\u0000b')).toBe(false);
    expect(isHeaderSafe('a\u007fb')).toBe(false);
  });
});

describe('R2 の鍵の形', () => {
  it('URL に載せるときは断片ごとに符号化して / を残す', () => {
    expect(encodeFileKeyPath('transcripts/dev-a/u1.jsonl.gz')).toBe('transcripts/dev-a/u1.jsonl.gz');
    expect(encodeFileKeyPath('config/skills/日本語 メモ/SKILL.md')).toBe('config/skills/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2/SKILL.md');
    expect(encodeFileKeyPath('config/a%b.md')).toBe('config/a%25b.md');
    // 受け取る側が断片ごとに復号すれば元に戻る。
    for (const key of ['config/skills/日本語 メモ/SKILL.md', 'config/a%b.md', 'config/? #.md']) {
      expect(encodeFileKeyPath(key).split('/').map(decodeURIComponent).join('/')).toBe(key);
    }
    // URL に置いても壊れない。
    expect(new URL(`https://h/files/${encodeFileKeyPath('config/skills/日本語 メモ/SKILL.md')}`).pathname)
      .toBe('/files/config/skills/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2/SKILL.md');
  });
});

describe('無料枠の定数', () => {
  it('D1 と Workers の日の枠は 10 万', () => {
    expect(CLOUD_FREE_LIMITS).toEqual({ d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 });
  });
  it('R2 の込み量は billable-usage の ServiceName の頭で引く', () => {
    expect(r2Included('R2 Data Storage (First 10GB-Month included)')).toBe(10);
    expect(r2Included('R2 Storage Class A Operations (First 1M included)')).toBe(1_000_000);
    expect(r2Included('R2 Storage Class B Operations (First 10M included)')).toBe(10_000_000);
  });
  it('知らない項目は null（棒を描かず数だけ出す）', () => {
    expect(r2Included('R2 Infrequent Access Data Retrieval')).toBeNull();
    expect(r2Included('Workers Standard Requests')).toBeNull();
  });
});
