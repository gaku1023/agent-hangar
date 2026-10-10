import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 同梱サーバの置き場（$INSTDIR\server）を、入れるときに一度空にし、アンインストールで消し切る。
 * Tauri の NSIS は、入れるときに今の版のファイルを上書きするだけで、前の版にしか無いファイル（名前に指紋の付いた UI の assets）を消さない。
 * アンインストーラも今の版のファイルだけを 1 つずつ消すので、更新を重ねると古い assets が $INSTDIR に残り続けた（0.2.0-rc.4 の実機）。
 * 消すのは Hangar の置き場だと確かめられたときだけで、利用者のデータ（~\.agent-hangar）には触れない。
 */
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(app, p), 'utf8');
const win = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const hooks = read(path.join('src-tauri', win.bundle.windows.nsis.installerHooks as string));
const serverDir = `$INSTDIR\\${conf.bundle.resources['../server-dist']}`;

/** macro と macroend の間。 */
const macro = (name: string): string => {
  const m = new RegExp(`!macro ${name}( [^\\r\\n]*)?\\r?\\n([\\s\\S]*?)!macroend`).exec(hooks);
  expect(m, `${name} が見つかりません`).not.toBeNull();
  return m![2]!;
};

/** 空行と注釈を除いた行。 */
const lines = (body: string): string[] =>
  body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith(';'));

describe('Hangar の置き場かどうかを確かめる', () => {
  it('印は、アンインストーラと、同梱サーバの 2 つの入口（server.mjs、cli.mjs）がそろっていること', () => {
    const b = macro('HANGAR_CHECK_SERVER_OWNED');
    expect(b).toContain('StrCpy $HangarServerOwned 0');
    expect(b).toContain('${If} $INSTDIR != ""');
    expect(b).toContain('${AndIf} ${FileExists} "$INSTDIR\\uninstall.exe"');
    expect(b).toContain(`\${AndIf} \${FileExists} "${serverDir}\\server.mjs"`);
    expect(b).toContain(`\${AndIf} \${FileExists} "${serverDir}\\cli.mjs"`);
    expect(b).toContain('StrCpy $HangarServerOwned 1');
    expect(hooks).toMatch(/^Var HangarServerOwned\r?$/m);
  });

  it('印のファイルの名前は、束を作る側（bundle-server.ts）が書く名前と同じ', () => {
    const bundle = read('scripts/bundle-server.ts');
    expect(bundle).toContain("['packages/server/src/main.ts', 'server.mjs']");
    expect(bundle).toContain("['packages/cli/src/index.ts', 'cli.mjs']");
  });
});

describe('入れるとき（PREINSTALL）に、同梱サーバの置き場を一度空にする', () => {
  const b = () => lines(macro('NSIS_HOOK_PREINSTALL'));

  it('Hangar の置き場と確かめ、殻が動いていないときだけ、server を丸ごと消す', () => {
    const l = b();
    const check = l.indexOf('!insertmacro HANGAR_CHECK_SERVER_OWNED');
    const owned = l.indexOf('${If} $HangarServerOwned = 1');
    const notRunning = l.lastIndexOf('${If} $R8 <> 0');
    const rm = l.indexOf(`RMDir /r "${serverDir}"`);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(owned).toBeGreaterThan(check);
    expect(notRunning).toBeGreaterThan(owned);
    expect(rm).toBeGreaterThan(notRunning);
  });

  // 更新では、殻がインストーラを起こしてからすぐ終わる。終わるのを少しだけ待ってから空にする。
  // 手で入れるときは待たない。動いていれば空にせず、Tauri の確認（CheckIfAppIsRunning）に任せる。
  // 空にしたあとで入れるのをやめられると、入っていた版が壊れるからである。
  it('殻が動いているかは Tauri と同じ道具で見て、待つのは更新（/UPDATE）のときだけ', () => {
    const body = macro('NSIS_HOOK_PREINSTALL');
    expect(body).toContain('nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"');
    expect(body).toMatch(/\$\{(If|OrIf)\} \$UpdateMode <> 1/);
    expect(body).toMatch(/Sleep \d+/);
  });

  it('使う $R8 と $R9 は、入る前に積み、出る前に戻す', () => {
    const l = b();
    expect(l.slice(0, 2)).toEqual(['Push $R8', 'Push $R9']);
    expect(l.slice(-2)).toEqual(['Pop $R9', 'Pop $R8']);
  });
});

describe('アンインストールで、$INSTDIR の中の Hangar のものを消し切る', () => {
  it('ファイルを消す前（PREUNINSTALL）に、Hangar の置き場かどうかを確かめておく', () => {
    expect(lines(macro('NSIS_HOOK_PREUNINSTALL'))).toContain('!insertmacro HANGAR_CHECK_SERVER_OWNED');
  });

  // Tauri はファイルを 1 つずつ消したあと、$INSTDIR を中身が空のときだけ消す。古い assets が残ると、$INSTDIR ごと残る。
  // 動いている殻を止める確認（CheckIfAppIsRunning）のあとなので、ここで消せば、やめられて壊れることも無い。
  it('消したあと（POSTUNINSTALL）に、確かめた置き場だけ server を丸ごと消し、空になった $INSTDIR を消す', () => {
    const l = lines(macro('NSIS_HOOK_POSTUNINSTALL'));
    const owned = l.indexOf('${If} $HangarServerOwned = 1');
    const rm = l.indexOf(`RMDir /r "${serverDir}"`);
    const rmInst = l.indexOf('RMDir "$INSTDIR"');
    expect(owned).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(owned);
    expect(rmInst).toBeGreaterThan(rm);
    expect(l.indexOf('${EndIf}', owned)).toBeGreaterThan(rmInst);
  });

  // RMDir /r は、確かめた server の置き場だけに使う。$INSTDIR そのものは中身が空のときだけ消える形（/r なし）にする。
  it('RMDir は server の置き場と $INSTDIR の 2 つだけで、利用者のデータの置き場には向けない', () => {
    const all = [...hooks.matchAll(/^\s*RMDir\b.*$/gim)].map((m) => m[0].trim());
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) expect([`RMDir /r "${serverDir}"`, 'RMDir "$INSTDIR"']).toContain(line);
    expect(hooks).not.toMatch(/RMDir[^\r\n]*(\$PROFILE|\.agent-hangar|\$LOCALAPPDATA|\$APPDATA)/i);
  });
});
