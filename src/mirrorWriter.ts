import type { CalEvent, CalendarGateway, Logger, PropertyStore } from './types';
import { PROPERTY_KEYS, type Config } from './config';
import { buildMirrorBody, isStatusEventType, mirrorFieldsEqual, mirrorVisibility, visibilityEqual } from './mapping';
import { MARKER_KEYS, readMarker, type MirrorKind, type MirrorMarker } from './markers';
import type { SyncStats } from './log';
import { isRetryableError } from './retry';

/**
 * ミラーの作成・更新・削除。DRY_RUN と種別のフォールバック（spec §11）をここで吸収する。
 */
export class MirrorWriter {
  private fallbackCache: Record<string, true> | null = null;

  constructor(
    private readonly gw: CalendarGateway,
    private readonly cfg: Config,
    private readonly props: PropertyStore,
    private readonly stats: SyncStats,
    private readonly log: Logger,
  ) {}

  /** 目的のソース ID を持つミラーを 1 件探す。チャンクの事前取得に漏れたときの保険。 */
  findMirror(targetCalendarId: string, sourceCalendarId: string, srcId: string): CalEvent | null {
    const found = this.gw.listEvents(targetCalendarId, {
      privateExtendedProperty: [
        `${MARKER_KEYS.tag}=${this.cfg.syncTag}`,
        `${MARKER_KEYS.srcId}=${srcId}`,
      ],
    });
    const mine = found.filter((ev) => ev.status !== 'cancelled' && readMarker(ev)?.srcCal === sourceCalendarId);
    return mine[0] ?? null;
  }

  /**
   * 作成または差分更新。返り値は現在のミラー（dry-run で作成した場合は id なし）。
   */
  upsert(
    targetCalendarId: string,
    sourceCalendarId: string,
    source: CalEvent,
    existing: CalEvent | null,
    kind: MirrorKind,
  ): CalEvent | null {
    const marker: MirrorMarker = {
      tag: this.cfg.syncTag,
      srcCal: sourceCalendarId,
      srcId: source.id ?? '',
      srcUid: source.iCalUID ?? '',
      srcUpdated: source.updated ?? '',
      kind,
    };
    const label = describe(source);

    if (!existing) {
      return this.insertWithFallback(targetCalendarId, source, marker, kind, label);
    }

    // ソースが変わっていなくても、DEFAULT_VISIBILITY_EVENT_TYPES の変更で visibility がずれていれば直す
    const existingMarker = readMarker(existing);
    if (
      existingMarker &&
      existingMarker.srcUpdated === marker.srcUpdated &&
      existingMarker.tag === marker.tag &&
      visibilityEqual(existing.visibility, mirrorVisibility(source, this.cfg))
    ) {
      return existing;
    }

    // 既存ミラーの種別は変えられないので、既存が default なら退避モードで本文を作る
    const nativeStatusType = isStatusEventType(existing.eventType);
    const body = buildMirrorBody(source, marker, this.cfg, {
      nativeStatusType,
      includeEventType: false,
      includeRecurrence: kind === 'recurringParent',
    });

    if (this.cfg.dryRun) {
      this.log.info(`[dry-run] update ${label}`);
      this.stats.updated += 1;
      return existing;
    }
    const patched = this.gw.patchEvent(targetCalendarId, existing.id!, body);
    this.stats.updated += 1;
    return patched;
  }

  delete(targetCalendarId: string, mirror: CalEvent, reason: string): void {
    if (!mirror.id) return;
    if (this.cfg.dryRun) {
      this.log.info(`[dry-run] delete ${describe(mirror)} (${reason})`);
      this.stats.deleted += 1;
      return;
    }
    this.gw.deleteEvent(targetCalendarId, mirror.id);
    this.stats.deleted += 1;
  }

  /** 繰り返しミラーの個別インスタンスを patch する（例外の同期・取り消し）。 */
  patchInstance(targetCalendarId: string, instance: CalEvent, body: CalEvent): void {
    if (!instance.id) return;
    if (mirrorFieldsEqual(instance, body)) return;
    if (this.cfg.dryRun) {
      this.log.info(`[dry-run] patch instance ${describe(instance)}`);
      this.stats.updated += 1;
      return;
    }
    this.gw.patchEvent(targetCalendarId, instance.id, body);
    this.stats.updated += 1;
  }

  private insertWithFallback(
    targetCalendarId: string,
    source: CalEvent,
    marker: MirrorMarker,
    kind: MirrorKind,
    label: string,
  ): CalEvent | null {
    const statusType = isStatusEventType(source.eventType) ? source.eventType : null;
    const cacheKey = statusType ? `${targetCalendarId}|${statusType}` : null;
    let nativeStatusType = statusType !== null && !this.isFallbackCached(cacheKey!);

    const build = () =>
      buildMirrorBody(source, marker, this.cfg, {
        nativeStatusType,
        includeEventType: true,
        includeRecurrence: kind === 'recurringParent',
      });

    if (this.cfg.dryRun) {
      const body = build();
      this.log.info(`[dry-run] create ${label} as ${body.eventType}`);
      this.stats.created += 1;
      return null;
    }

    try {
      const created = this.gw.insertEvent(targetCalendarId, build());
      this.stats.created += 1;
      return created;
    } catch (e) {
      if (!nativeStatusType || isRetryableError(e)) throw e;
      // 本来の種別で拒否された。以後この書き込み先ではこの種別を諦める
      this.log.warn(`${statusType} を ${targetCalendarId} に作成できず通常予定へ退避: ${String(e)}`);
      this.rememberFallback(cacheKey!);
      nativeStatusType = false;
      const created = this.gw.insertEvent(targetCalendarId, build());
      this.stats.created += 1;
      return created;
    }
  }

  private isFallbackCached(key: string): boolean {
    return this.loadFallbackCache()[key] === true;
  }

  private rememberFallback(key: string): void {
    const cache = this.loadFallbackCache();
    cache[key] = true;
    this.props.set(PROPERTY_KEYS.eventTypeFallbackCache, JSON.stringify(cache));
  }

  private loadFallbackCache(): Record<string, true> {
    if (this.fallbackCache) return this.fallbackCache;
    const raw = this.props.get(PROPERTY_KEYS.eventTypeFallbackCache);
    try {
      this.fallbackCache = raw ? (JSON.parse(raw) as Record<string, true>) : {};
    } catch {
      this.fallbackCache = {};
    }
    return this.fallbackCache;
  }
}

export function describe(event: CalEvent): string {
  const when = event.start?.dateTime ?? event.start?.date ?? '?';
  return `"${event.summary ?? '(無題)'}" @${when}`;
}
