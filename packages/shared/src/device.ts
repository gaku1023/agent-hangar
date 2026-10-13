import type { Translate } from './i18n/t.ts';

/**
 * devices.platform（Node の process.platform の値）を、画面と指示に出す OS の名前にする。
 * 知っている値は辞書の名前（macOS、Windows、Linux）にし、知らない値はそのまま返す。値が無ければ null。
 */
export function osName(t: Translate, platform: string | null | undefined): string | null {
  if (!platform) return null;
  if (platform === 'darwin') return t('common.os.darwin');
  if (platform === 'win32') return t('common.os.win32');
  if (platform === 'linux') return t('common.os.linux');
  return platform;
}
