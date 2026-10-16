import { bundledNotes } from './releaseNotes.ts';

/**
 * リポジトリの docs/release-notes/<版>.md を、ビルドのときにアプリへ取り込む。
 * 同梱するので、ネットが無くても設定の履歴と更新後の知らせを読める。
 * 正式な版を出すとき、release.yml は同じファイルを Release の本文と目録（latest.json の notes）にも使う。
 * 読み方は releaseNotes.ts の bundledNotes で、ここは取り込むだけにする（Vite の import.meta.glob は試験の dom の環境で中身が空になるため）。
 */
const files = import.meta.glob<string>('../../../../docs/release-notes/*.md', { query: '?raw', import: 'default', eager: true });

export const RELEASE_NOTES = bundledNotes(files);
