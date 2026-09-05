import type { CalEvent, CalendarGateway, Logger } from './types';
import type { Config } from './config';
import { syncWindow } from './cursor';
import { DuplicateIndex, duplicateKey, exclusionReason, isDeclinedBy } from './filters';
import { MARKER_KEYS, readMarker } from './markers';
import { describe } from './mirrorWriter';

/**
 * 「なぜこの予定のコピーが作られない（作られる）のか」を説明する診断。
 * タイトルの部分一致で両カレンダーから予定を探し、判定の各段階を出力する。
 */
export function explainTitle(gw: CalendarGateway, cfg: Config, needle: string, now: Date, log: Logger): void {
  const window = syncWindow(now, cfg);
  const range = { timeMin: window.start.toISOString(), timeMax: window.end.toISOString() };
  log.info(`探索範囲: ${range.timeMin} 〜 ${range.timeMax} / タイトルに "${needle}" を含む予定`);

  const directions = [
    { source: cfg.subCalendarId, target: cfg.mainCalendarId },
    { source: cfg.mainCalendarId, target: cfg.subCalendarId },
  ];

  for (const dir of directions) {
    log.info(`===== ${dir.source} → ${dir.target} =====`);
    const sourceEvents = gw
      .listEvents(dir.source, { ...range, singleEvents: true, showDeleted: true })
      .filter((ev) => (ev.summary ?? '').includes(needle));
    if (sourceEvents.length === 0) {
      log.info('  ソース側に該当する予定がない（ウィンドウ外か、タイトルが違う）');
      continue;
    }
    const targetEvents = gw.listEvents(dir.target, { ...range, singleEvents: true, showDeleted: false });
    const targetReal = targetEvents.filter((ev) => !readMarker(ev) && !(ev.summary ?? '').endsWith(cfg.mirrorTitleSuffix));
    const duplicates = new DuplicateIndex(targetReal);

    for (const ev of sourceEvents) {
      log.info(`--- ${describe(ev)}`);
      log.info(`  id=${ev.id} status=${ev.status} eventType=${ev.eventType ?? 'default'} iCalUID=${ev.iCalUID}`);
      if (ev.recurringEventId) log.info(`  繰り返しのインスタンス（親 ${ev.recurringEventId}）。親の判定が優先される`);
      const me = ev.attendees?.find((a) => (a.email ?? '').toLowerCase() === dir.source.toLowerCase());
      log.info(
        `  attendees=${ev.attendees?.length ?? 0} 件 / ソースアカウントの応答=${me?.responseStatus ?? '(参加者にいない → 参加扱い)'} / declined=${isDeclinedBy(ev, dir.source)}`,
      );

      const reason = exclusionReason(ev, dir.source, cfg);
      if (reason) {
        log.info(`  ▶ 除外: ${reason}${reason === 'title-pattern' ? ` (一致: ${matchedPatterns(ev, cfg).join(', ')})` : ''}`);
        continue;
      }

      const dup = findDuplicate(ev, targetReal);
      if (dup) {
        log.info(`  ▶ 重複のため作らない: ターゲット側に ${describe(dup.event)} (id=${dup.event.id}) が ${dup.by} で一致`);
        continue;
      }
      if (duplicates.has(ev)) {
        log.info('  ▶ 重複判定に一致（詳細不明）');
        continue;
      }

      const mirrors = gw.listEvents(dir.target, {
        privateExtendedProperty: [`${MARKER_KEYS.tag}=${cfg.syncTag}`, `${MARKER_KEYS.srcId}=${ev.recurringEventId ?? ev.id}`],
      });
      const live = mirrors.filter((m) => m.status !== 'cancelled');
      if (live.length === 0) {
        log.info('  ▶ 同期対象だがミラーが存在しない → 次の sync で作成されるはず。作成されないなら sync のログの failed を確認');
      } else {
        for (const m of live) {
          const mk = readMarker(m)!;
          const fresh = mk.srcUpdated === (ev.updated ?? '');
          log.info(`  ▶ ミラーあり: ${describe(m)} (id=${m.id}, eventType=${m.eventType ?? 'default'}) / ソース updated と${fresh ? '一致' : '不一致 → 次回 patch'}`);
        }
      }
    }
  }
}

function matchedPatterns(ev: CalEvent, cfg: Config): string[] {
  return cfg.excludeTitlePatterns.filter((re) => re.test(ev.summary ?? '')).map((re) => re.source);
}

function findDuplicate(ev: CalEvent, targetReal: CalEvent[]): { event: CalEvent; by: string } | null {
  if (ev.iCalUID) {
    const byUid = targetReal.find((t) => t.iCalUID === ev.iCalUID);
    if (byUid) return { event: byUid, by: 'iCalUID' };
  }
  const key = duplicateKey(ev);
  if (key) {
    const byKey = targetReal.find((t) => duplicateKey(t) === key);
    if (byKey) return { event: byKey, by: 'タイトル＋開始＋終了' };
  }
  return null;
}
