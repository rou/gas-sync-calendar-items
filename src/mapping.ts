import type { CalEvent, EventDateTime, EventType } from './types';
import type { Config } from './config';
import { applyTitleSuffix, buildMarkerProps, type MirrorMarker } from './markers';

export type StatusEventType = 'outOfOffice' | 'focusTime';

export function isStatusEventType(t: EventType | undefined): t is StatusEventType {
  return t === 'outOfOffice' || t === 'focusTime';
}

export function isAllDay(event: CalEvent): boolean {
  return !!event.start?.date && !event.start?.dateTime;
}

/** 開始／終了を比較・突合するためのキー。時刻付きは epoch ms、終日は日付文字列。 */
export function dateKey(dt: EventDateTime | undefined): string | null {
  if (!dt) return null;
  if (dt.dateTime) {
    const ms = Date.parse(dt.dateTime);
    return Number.isNaN(ms) ? dt.dateTime : String(ms);
  }
  return dt.date ?? null;
}

export interface MirrorBodyOptions {
  /** true なら status event を本来の種別で作る。false なら通常予定へ退避する。 */
  nativeStatusType: boolean;
  /** insert 時のみ true。eventType は作成後に変更できないので patch では送らない。 */
  includeEventType: boolean;
  includeRecurrence: boolean;
}

type MappingConfig = Pick<
  Config,
  | 'mirrorTitleSuffix'
  | 'fallbackPrefixOoo'
  | 'fallbackPrefixFocus'
  | 'appendSourceLinks'
  | 'defaultVisibilityEventTypes'
>;

export type MirrorVisibility = 'default' | 'private';

/**
 * ミラーの visibility。ミラー側の種別ではなくソースの eventType で決める。
 * 本来の種別で作れたか退避したか、終日かどうか、どちら向きの同期かで結果が変わらないようにするため。
 */
export function mirrorVisibility(
  source: CalEvent,
  cfg: Pick<Config, 'defaultVisibilityEventTypes'>,
): MirrorVisibility {
  return cfg.defaultVisibilityEventTypes.has(source.eventType ?? 'default') ? 'default' : 'private';
}

/** API は visibility が default のとき値を省略して返すので、未設定を default とみなして比べる。 */
export function visibilityEqual(a: string | undefined, b: string | undefined): boolean {
  return (a ?? 'default') === (b ?? 'default');
}

/**
 * ソース予定からミラーの本文を組み立てる（spec §10）。
 * attendees / organizer / conferenceData / attachments は持ち込まない。
 */
export function buildMirrorBody(
  source: CalEvent,
  marker: MirrorMarker,
  cfg: MappingConfig,
  opts: MirrorBodyOptions,
): CalEvent {
  const statusType = isStatusEventType(source.eventType) ? source.eventType : null;
  // status event は終日にできないので、終日の不在は必ず通常予定に退避する
  const useNative = statusType !== null && opts.nativeStatusType && !isAllDay(source);
  const needsPrefix = statusType !== null && !useNative;

  const rawTitle = source.summary ?? '(無題)';
  const prefix = needsPrefix
    ? statusType === 'outOfOffice'
      ? cfg.fallbackPrefixOoo
      : cfg.fallbackPrefixFocus
    : '';

  const body: CalEvent = {
    summary: applyTitleSuffix(`${prefix}${rawTitle}`, cfg.mirrorTitleSuffix),
    description: buildDescription(source, cfg.appendSourceLinks),
    location: source.location,
    start: cloneDateTime(source.start),
    end: cloneDateTime(source.end),
    // status event は opaque が必須。退避したときも時間を埋める意図なので opaque にする
    transparency: statusType !== null ? 'opaque' : source.transparency,
    colorId: source.colorId,
    visibility: mirrorVisibility(source, cfg),
    reminders: { useDefault: true },
    status: 'confirmed',
    extendedProperties: { private: buildMarkerProps(marker) },
  };

  if (opts.includeRecurrence && source.recurrence && source.recurrence.length > 0) {
    body.recurrence = [...source.recurrence];
  }

  if (opts.includeEventType) {
    if (useNative && statusType === 'outOfOffice') {
      body.eventType = 'outOfOffice';
      body.outOfOfficeProperties = { ...(source.outOfOfficeProperties ?? {}) };
    } else if (useNative && statusType === 'focusTime') {
      body.eventType = 'focusTime';
      body.focusTimeProperties = { ...(source.focusTimeProperties ?? {}) };
    } else {
      body.eventType = 'default';
    }
  }

  return body;
}

export function buildDescription(source: CalEvent, appendSourceLinks: boolean): string | undefined {
  const base = source.description ?? '';
  if (!appendSourceLinks) return base || undefined;

  const extras: string[] = [];
  const meet = source.hangoutLink ?? source.conferenceData?.entryPoints?.find((e) => e.uri)?.uri;
  if (meet) extras.push(`Meet: ${meet}`);
  for (const att of source.attachments ?? []) {
    if (att.title) extras.push(`添付: ${att.title}`);
  }
  if (extras.length === 0) return base || undefined;
  return base ? `${base}\n\n${extras.join('\n')}` : extras.join('\n');
}

function cloneDateTime(dt: EventDateTime | undefined): EventDateTime | undefined {
  if (!dt) return undefined;
  const out: EventDateTime = {};
  if (dt.date) out.date = dt.date;
  if (dt.dateTime) out.dateTime = dt.dateTime;
  if (dt.timeZone) out.timeZone = dt.timeZone;
  return out;
}

/** 差分更新で「patch が必要か」を決める比較。マーカーと eventType は見ない。 */
export function mirrorFieldsEqual(a: CalEvent, b: CalEvent): boolean {
  return (
    (a.summary ?? '') === (b.summary ?? '') &&
    (a.description ?? '') === (b.description ?? '') &&
    (a.location ?? '') === (b.location ?? '') &&
    dateKey(a.start) === dateKey(b.start) &&
    dateKey(a.end) === dateKey(b.end) &&
    (a.transparency ?? 'opaque') === (b.transparency ?? 'opaque') &&
    (a.colorId ?? '') === (b.colorId ?? '') &&
    visibilityEqual(a.visibility, b.visibility) &&
    (a.status ?? 'confirmed') === (b.status ?? 'confirmed')
  );
}
