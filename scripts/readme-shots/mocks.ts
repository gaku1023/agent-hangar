// 全場面のページに効く、API の応答の差し替え（使用量など）。
// 撮影用の画面の右上に出る「メイン 未取得」を埋めるために用意した口で、中身は使用量の担当が足す。
// 例: { match: '/api/usage', json: { ... } }
import type { ApiMock } from './kit.ts';

export const MOCKS: ApiMock[] = [];
