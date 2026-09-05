import type { CalEvent, CalendarGateway, Logger } from './types';
import type { Config } from './config';
import { MARKER_KEYS } from './markers';

/**
 * spec §17 の未確定事項を実機で確かめる使い捨て関数群。
 * 作ったテスト予定は必ず消す。結果はログで読む。
 */

function hourLater(base: Date, hours: number): string {
  return new Date(base.getTime() + hours * 3600 * 1000).toISOString();
}

/** S1: 書いた extendedProperties.private を同じ calendarId で読み返せるか（両カレンダー）。 */
export function runSpikeS1(gw: CalendarGateway, cfg: Config, log: Logger): void {
  const now = new Date();
  for (const calendarId of [cfg.mainCalendarId, cfg.subCalendarId]) {
    let created: CalEvent | null = null;
    try {
      created = gw.insertEvent(calendarId, {
        summary: '[spike S1] extendedProperties test',
        start: { dateTime: hourLater(now, 24 * 30) },
        end: { dateTime: hourLater(now, 24 * 30 + 1) },
        visibility: 'private',
        extendedProperties: { private: { [MARKER_KEYS.tag]: 'spike', [MARKER_KEYS.srcId]: 'spike-src' } },
      });
      const fetched = gw.getEvent(calendarId, created.id!);
      const p = fetched?.extendedProperties?.private ?? {};
      const ok = p[MARKER_KEYS.tag] === 'spike' && p[MARKER_KEYS.srcId] === 'spike-src';
      const listed = gw.listEvents(calendarId, {
        privateExtendedProperty: [`${MARKER_KEYS.tag}=spike`],
        timeMin: hourLater(now, 24 * 29),
        timeMax: hourLater(now, 24 * 31),
      });
      log.info(`S1 ${calendarId}: get で読み返し=${ok ? 'OK' : 'NG'} / privateExtendedProperty 検索 ${listed.length} 件`);
    } catch (e) {
      log.warn(`S1 ${calendarId}: 失敗 ${String(e)}`);
    } finally {
      if (created?.id) gw.deleteEvent(calendarId, created.id);
    }
  }
}

/** S2: eventTypes パラメータが効くか。共有カレンダーから status event が取れるか。 */
export function runSpikeS2(gw: CalendarGateway, cfg: Config, log: Logger): void {
  const now = new Date();
  const base = { timeMin: hourLater(now, -24 * 30), timeMax: hourLater(now, 24 * 90), singleEvents: true };
  for (const calendarId of [cfg.mainCalendarId, cfg.subCalendarId]) {
    try {
      const all = gw.listEvents(calendarId, base);
      const counts: Record<string, number> = {};
      for (const ev of all) counts[ev.eventType ?? 'undefined'] = (counts[ev.eventType ?? 'undefined'] ?? 0) + 1;
      log.info(`S2 ${calendarId}: パラメータなし ${all.length} 件 ${JSON.stringify(counts)}`);
      const filtered = gw.listEvents(calendarId, { ...base, eventTypes: ['outOfOffice', 'focusTime'] });
      log.info(`S2 ${calendarId}: eventTypes=[outOfOffice,focusTime] で ${filtered.length} 件`);
    } catch (e) {
      log.warn(`S2 ${calendarId}: eventTypes パラメータで失敗 ${String(e)}`);
    }
  }
}

/** S3: outOfOffice / focusTime を自分の primary と他人の primary に insert できるか。visibility private 同時指定。 */
export function runSpikeS3(gw: CalendarGateway, cfg: Config, log: Logger): void {
  const now = new Date();
  const cases: Array<{ type: 'outOfOffice' | 'focusTime'; props: Partial<CalEvent> }> = [
    { type: 'outOfOffice', props: { outOfOfficeProperties: { autoDeclineMode: 'declineNone' } } },
    { type: 'focusTime', props: { focusTimeProperties: { autoDeclineMode: 'declineNone', chatStatus: 'available' } } },
  ];
  for (const calendarId of [cfg.mainCalendarId, cfg.subCalendarId]) {
    for (const c of cases) {
      let created: CalEvent | null = null;
      try {
        created = gw.insertEvent(calendarId, {
          summary: `[spike S3] ${c.type}`,
          eventType: c.type,
          transparency: 'opaque',
          visibility: 'private',
          start: { dateTime: hourLater(now, 24 * 30 + 2) },
          end: { dateTime: hourLater(now, 24 * 30 + 3) },
          ...c.props,
        });
        log.info(`S3 ${calendarId} ${c.type}: OK (eventType=${created.eventType}, visibility=${created.visibility})`);
      } catch (e) {
        log.warn(`S3 ${calendarId} ${c.type}: NG ${String(e)}`);
      } finally {
        if (created?.id) gw.deleteEvent(calendarId, created.id);
      }
    }
  }
}

/** S4: 共有カレンダー越しに recurrence と instances が読めるか。 */
export function runSpikeS4(gw: CalendarGateway, cfg: Config, log: Logger): void {
  const now = new Date();
  const range = { start: new Date(now.getTime() - 7 * 86400e3), end: new Date(now.getTime() + 60 * 86400e3) };
  const instances = gw.listEvents(cfg.subCalendarId, {
    timeMin: range.start.toISOString(),
    timeMax: range.end.toISOString(),
    singleEvents: true,
  });
  const parentId = instances.find((ev) => ev.recurringEventId)?.recurringEventId;
  if (!parentId) {
    log.info('S4: サブカレンダーに繰り返し予定が見つからない');
    return;
  }
  const parent = gw.getEvent(cfg.subCalendarId, parentId);
  log.info(`S4 parent ${parentId}: recurrence=${JSON.stringify(parent?.recurrence)} start=${JSON.stringify(parent?.start)}`);
  const inst = gw.listInstances(cfg.subCalendarId, parentId, range);
  log.info(`S4 instances: ${inst.length} 件、originalStartTime あり=${inst.filter((i) => i.originalStartTime).length}`);
}
