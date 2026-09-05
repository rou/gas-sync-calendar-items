import type { CalendarGateway, Logger, TimeRange } from './types';
import { isLegacyMirrorTitle, readMarker } from './markers';
import { describe } from './mirrorWriter';

export interface PurgeOptions {
  /** true なら新マーカー（extendedProperties）のミラーも消す。 */
  includeNewMirrors: boolean;
  mirrorTitleSuffix: string;
  dryRun: boolean;
}

/**
 * ミラーの一括削除（spec §13）。移行前に現行スクリプトの残骸を消すためのもの。
 * 旧マーカーは (block) / (自動生成) / 空き枠同期中 の 3 種。
 */
export function purgeMirrors(
  gw: CalendarGateway,
  calendarIds: string[],
  range: TimeRange,
  opts: PurgeOptions,
  log: Logger,
): number {
  let deleted = 0;
  for (const calendarId of calendarIds) {
    const items = gw.listEvents(calendarId, {
      timeMin: range.start.toISOString(),
      timeMax: range.end.toISOString(),
      singleEvents: false,
      showDeleted: false,
    });
    const targets = items.filter((ev) => {
      if (!ev.id) return false;
      if (isLegacyMirrorTitle(ev.summary)) return true;
      if (opts.mirrorTitleSuffix && (ev.summary ?? '').endsWith(opts.mirrorTitleSuffix)) return true;
      return opts.includeNewMirrors && readMarker(ev) !== null;
    });
    log.info(`${calendarId}: ${targets.length} 件を削除${opts.dryRun ? '（dry-run）' : ''}`);
    for (const ev of targets) {
      log.info(`  ${opts.dryRun ? '[dry-run] ' : ''}delete ${describe(ev)}`);
      if (!opts.dryRun) gw.deleteEvent(calendarId, ev.id!);
      deleted += 1;
    }
  }
  return deleted;
}
