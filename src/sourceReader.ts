import type { CalEvent, CalendarGateway, Logger, TimeRange } from './types';
import { isMirror } from './markers';

export interface ChunkSourceView {
  /** recurringEventId を持たない予定。cancelled も含む。 */
  singles: CalEvent[];
  /** 繰り返し親の ID → ウィンドウ内インスタンス（例外・cancelled も含む）。 */
  byParent: Map<string, CalEvent[]>;
  /** ループ防止で弾いたミラーの数。 */
  mirrorsSkipped: number;
}

const EVENT_TYPES = ['default', 'outOfOffice', 'focusTime'];

/**
 * Pass 1（spec §12）。singleEvents=true で列挙し、recurringEventId から親を逆引きする。
 * 親の start は初回の日時なので、親を直接 timeMin で引くと過去に始まった繰り返しを取りこぼす。
 */
export function readSourceChunk(
  gw: CalendarGateway,
  calendarId: string,
  chunk: TimeRange,
  mirrorTitleSuffix: string,
  log: Logger,
): ChunkSourceView {
  const events = listWithEventTypes(gw, calendarId, chunk, log);
  const view: ChunkSourceView = { singles: [], byParent: new Map(), mirrorsSkipped: 0 };

  for (const ev of events) {
    if (isMirror(ev, mirrorTitleSuffix)) {
      view.mirrorsSkipped += 1;
      continue;
    }
    if (ev.recurringEventId) {
      const list = view.byParent.get(ev.recurringEventId) ?? [];
      list.push(ev);
      view.byParent.set(ev.recurringEventId, list);
    } else {
      view.singles.push(ev);
    }
  }
  return view;
}

let eventTypesParamSupported: boolean | null = null;

/** eventTypes パラメータが効かない環境（spec S2）ではパラメータを外して取り直す。 */
function listWithEventTypes(
  gw: CalendarGateway,
  calendarId: string,
  chunk: TimeRange,
  log: Logger,
): CalEvent[] {
  const base = {
    timeMin: chunk.start.toISOString(),
    timeMax: chunk.end.toISOString(),
    singleEvents: true,
    showDeleted: true,
  };
  if (eventTypesParamSupported !== false) {
    try {
      const items = gw.listEvents(calendarId, { ...base, eventTypes: EVENT_TYPES });
      eventTypesParamSupported = true;
      return items;
    } catch (e) {
      log.warn(`eventTypes パラメータでの取得に失敗。以後はクライアント側でフィルタする: ${String(e)}`);
      eventTypesParamSupported = false;
    }
  }
  return gw.listEvents(calendarId, base);
}
