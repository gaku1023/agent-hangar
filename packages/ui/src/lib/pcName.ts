/**
 * PC 名の札（.pc-pill）に出す短い名前。mDNS の末尾の `.local` は、どの Mac にも付くので札では落とす。
 * 全文は札の title に残す。
 */
export function pillName(name: string): string {
  const short = name.replace(/\.local\.?$/i, '');
  return short === '' ? name : short;
}
