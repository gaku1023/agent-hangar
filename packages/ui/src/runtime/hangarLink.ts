import { parseRoute, type UiAction } from '@agent-hangar/shared';

/**
 * hangar 自身のリンク。MCP が返す URL（http://127.0.0.1:4177/#/session/<id>?device=<deviceId>）と、hangar://session/<id>、hangar://project/<id>。
 * 押したら既定のブラウザへ出さず、いまのペインをその会話（プロジェクト）に切り替える。入口はここの hangarLinkOf 1 か所で、
 * ターミナルのリンク（terminalLinks.ts）、本文の Markdown の a（anchorLinks.ts と views/primitives/Markdown.tsx）、ツールの行の URL のどれもここを通る。
 * deviceId は、id がこの PC で分からないときに、どの PC の会話かを見分ける手がかりである（別の PC の hangar も 4177 で、その会話のリンクも 127.0.0.1 になる）。
 */
export type HangarLink = { kind: 'session'; id: string; deviceId: string | null } | { kind: 'project'; id: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

function currentOrigin(): string | null {
  return typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : null;
}

function linkOfRoute(hash: string): HangarLink | null {
  if (!/^#\/(session|project)\/[^/?#]+/.test(hash)) return null;
  const route = parseRoute(hash);
  if (route.name === 'project') return { kind: 'project', id: route.id };
  if (route.name !== 'session') return null;
  const device = new URLSearchParams(hash.split('?')[1] ?? '').get('device');
  return { kind: 'session', id: route.id, deviceId: device || null };
}

/** hangar 自身のリンクなら、行き先を返す。ほかは null。origin は、いまの画面の origin（省くと window のもの）。 */
export function hangarLinkOf(url: string, origin: string | null = currentOrigin()): HangarLink | null {
  const m = /^hangar:\/\/(session|project)\/([^/?#]+)(?:\?([^#]*))?$/.exec(url);
  if (m) {
    if (m[1] === 'project') return { kind: 'project', id: m[2]! };
    return { kind: 'session', id: m[2]!, deviceId: new URLSearchParams(m[3] ?? '').get('device') || null };
  }
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!LOOPBACK.has(u.hostname) && u.origin !== origin) return null;
  return linkOfRoute(u.hash);
}

/** 開く操作。サイドバーの行を押したのと同じ（今のペインをその会話に切り替え、← で戻れる）。 */
export function hangarActionOf(link: HangarLink): UiAction {
  return link.kind === 'session' ? { type: 'session.open', id: link.id } : { type: 'project.open', id: link.id };
}
