import { createContext } from 'react';
import type { EventRepoHookDto } from '@agent-hangar/shared';

/**
 * 予定の画面が、webhook のことでサーバに頼むこと。
 * 画面は fetch を呼ばないので、Root が api をつないで Context で配る。
 * URL は秘密を含むので、ストアにも Mediator にも通さず、見せる間だけ画面の部品の中に置く。
 * そのため、操作の道（UiAction）ではなくここで返す。
 */
export type EventHookApi = {
  /**
   * 外の webhook の URL。
   * 受け箱がまだ無ければ null。
   */
  hookUrl(bindingId: string): Promise<string | null>;
  /**
   * 作り直す。
   * 付けられなかったときは理由の文（無ければ空）を返し、できたら null。
   */
  rotateUrl(bindingId: string): Promise<{ message: string } | null>;
  /** repo の webhook の状態。 */
  repoHook(repo: string): Promise<EventRepoHookDto>;
};

/** Context が無い場所（部品だけの試験など）では null で、URL のカードも repo の札も出さない。 */
export const EventHookApiContext = createContext<EventHookApi | null>(null);
