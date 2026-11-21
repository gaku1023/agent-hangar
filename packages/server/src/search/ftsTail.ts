/**
 * event_fts の text の末尾に足す区切りの文字（版 66）。
 * 本文の最後の 2 文字は、後ろに 1 文字ある trigram を持たず、2 文字の検索で引けなかった。
 * 区切りを足すと「2 文字と区切り」の trigram が索引に入り、本文のどこにある 2 文字も、その 2 文字で始まる trigram で引ける。
 * 本文に現れない制御文字（ユニット区切り）にして、利用者の語と区切りが噛み合わないようにする。
 * 画面と MCP に出す抜粋からは外す（stripFtsTail）。
 */
export const FTS_TAIL = '\u001f';

/** 索引に入れる本文。区切りを 1 つ末尾に足す。 */
export function withFtsTail(text: string): string {
  return text + FTS_TAIL;
}

/** 索引から取った本文や抜粋から、区切りを外す。 */
export function stripFtsTail(text: string): string {
  return text.split(FTS_TAIL).join('');
}
