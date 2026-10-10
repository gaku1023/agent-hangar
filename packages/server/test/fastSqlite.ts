import type Database from 'better-sqlite3';

type DatabaseClass = typeof Database;

/**
 * ファイルの DB を synchronous = OFF で開く Database を返す（:memory: には何もしない）。
 * 試験の DB は落ちても失って困らない。fsync を省くと、書き込みの終わりを OS のディスクの書き出しまで待たなくなる。
 * Windows の CI では、DB を開いて書くたびの fsync が、並んで走る試験の分も重なって 1 回数秒から数十秒かかった。
 * その間、同じディスクから読む別の試験（PowerShell の起動など）も締め切りを越えて待たされた。
 * 製品の openDb は変えない。試験の側だけで、Database の作り方を差し替える。
 */
export function relaxSqliteSync(Base: DatabaseClass): DatabaseClass {
  class RelaxedDatabase extends Base {
    constructor(filename?: string | Buffer, options?: Database.Options) {
      super(filename as string, options);
      if (typeof filename === 'string' && filename !== '' && filename !== ':memory:') this.pragma('synchronous = OFF');
    }
  }
  return RelaxedDatabase;
}
