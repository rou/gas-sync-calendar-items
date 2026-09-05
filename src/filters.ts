import type { CalEvent, EventType } from './types';
import type { Config } from './config';
import { isMirror } from './markers';
import { dateKey } from './mapping';

export type ExclusionReason = 'mirror' | 'cancelled' | 'title-pattern' | 'declined' | 'event-type';

const COPYABLE_EVENT_TYPES: ReadonlySet<EventType | undefined> = new Set<EventType | undefined>([
  undefined,
  'default',
  'outOfOffice',
  'focusTime',
]);

export function isCopyableEventType(eventType: EventType | undefined): boolean {
  return COPYABLE_EVENT_TYPES.has(eventType);
}

/**
 * 辞退判定。attendees[].self は見ない（spec §9）。
 * 実行アカウントは常にメインなので、self はサブの応答を表さない。
 * ソースカレンダーのアドレスと一致する attendee の responseStatus で判定する。
 */
export function isDeclinedBy(event: CalEvent, calendarId: string): boolean {
  const attendees = event.attendees;
  if (!attendees || attendees.length === 0) return false;
  const wanted = calendarId.toLowerCase();
  const me = attendees.find((a) => (a.email ?? '').toLowerCase() === wanted);
  if (!me) return false;
  return me.responseStatus === 'declined';
}

export function matchesExcludePattern(title: string | undefined, patterns: RegExp[]): boolean {
  if (!title) return false;
  return patterns.some((re) => re.test(title));
}

/** null なら同期対象。 */
export function exclusionReason(
  event: CalEvent,
  sourceCalendarId: string,
  cfg: Pick<Config, 'excludeTitlePatterns' | 'mirrorTitleSuffix'>,
): ExclusionReason | null {
  if (isMirror(event, cfg.mirrorTitleSuffix)) return 'mirror';
  if (event.status === 'cancelled') return 'cancelled';
  if (!isCopyableEventType(event.eventType)) return 'event-type';
  if (matchesExcludePattern(event.summary, cfg.excludeTitlePatterns)) return 'title-pattern';
  if (isDeclinedBy(event, sourceCalendarId)) return 'declined';
  return null;
}

/**
 * 重複判定（spec §8）。ターゲット側に同じ予定の実体があればミラーを作らない。
 * iCalUID 一致を一次、タイトル＋開始＋終了の一致を二次とする。
 */
export class DuplicateIndex {
  private readonly uids = new Set<string>();
  private readonly keys = new Set<string>();

  constructor(targetRealEvents: Iterable<CalEvent>) {
    for (const ev of targetRealEvents) {
      if (ev.status === 'cancelled') continue;
      if (ev.iCalUID) this.uids.add(ev.iCalUID);
      const key = duplicateKey(ev);
      if (key) this.keys.add(key);
    }
  }

  has(event: CalEvent): boolean {
    if (event.iCalUID && this.uids.has(event.iCalUID)) return true;
    const key = duplicateKey(event);
    return key !== null && this.keys.has(key);
  }
}

export function duplicateKey(event: CalEvent): string | null {
  const start = dateKey(event.start);
  const end = dateKey(event.end);
  if (!start || !end) return null;
  return `${event.summary ?? ''}|${start}|${end}`;
}
