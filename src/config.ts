import type { PropertyStore } from './types';

export const PROPERTY_KEYS = {
  subCalendarId: 'SUB_CALENDAR_ID',
  syncTag: 'SYNC_TAG',
  windowPastDays: 'WINDOW_PAST_DAYS',
  windowFutureDays: 'WINDOW_FUTURE_DAYS',
  excludeTitlePatterns: 'EXCLUDE_TITLE_PATTERNS',
  mirrorTitleSuffix: 'MIRROR_TITLE_SUFFIX',
  fallbackPrefixOoo: 'FALLBACK_PREFIX_OOO',
  fallbackPrefixFocus: 'FALLBACK_PREFIX_FOCUS',
  appendSourceLinks: 'APPEND_SOURCE_LINKS',
  dryRun: 'DRY_RUN',
  notifyEmail: 'NOTIFY_EMAIL',
  syncCursor: 'SYNC_CURSOR',
  eventTypeFallbackCache: 'EVENT_TYPE_FALLBACK_CACHE',
  lastNotifyDate: 'LAST_NOTIFY_DATE',
  debugTitle: 'DEBUG_TITLE',
} as const;

export const DEFAULT_EXCLUDE_TITLE_PATTERNS = [
  '^【締切】',
  '^【対応依頼】',
  '^【本日中】',
  '^【AM締切】',
  '【共有】',
];

export const DEFAULTS = {
  syncTag: 'calendar-sync/v1',
  windowPastDays: 0,
  windowFutureDays: 90,
  mirrorTitleSuffix: ' (自動生成)',
  fallbackPrefixOoo: '🏖 ',
  fallbackPrefixFocus: '🎧 ',
  appendSourceLinks: true,
  dryRun: false,
} as const;

/** ウィンドウをこの日数ごとに刻んで処理する。カーソル継続実行の単位。 */
export const CHUNK_DAYS = 14;

/** GAS の 6 分制限に対する安全マージン。これを超えたらカーソルを保存して中断する。 */
export const TIME_BUDGET_MS = 4 * 60 * 1000;

/** purge 系の走査範囲。実行時点から先この日数まで。過去分は履歴として残すので触らない。 */
export const PURGE_FUTURE_DAYS = 365;

export interface Config {
  mainCalendarId: string;
  subCalendarId: string;
  syncTag: string;
  windowPastDays: number;
  windowFutureDays: number;
  excludeTitlePatterns: RegExp[];
  mirrorTitleSuffix: string;
  fallbackPrefixOoo: string;
  fallbackPrefixFocus: string;
  appendSourceLinks: boolean;
  dryRun: boolean;
  notifyEmail: string;
}

export function loadConfig(props: PropertyStore, mainCalendarId: string): Config {
  const subCalendarId = props.get(PROPERTY_KEYS.subCalendarId)?.trim();
  if (!subCalendarId) {
    throw new Error(`Script Properties に ${PROPERTY_KEYS.subCalendarId} が設定されていません`);
  }
  if (subCalendarId.toLowerCase() === mainCalendarId.toLowerCase()) {
    throw new Error(`${PROPERTY_KEYS.subCalendarId} が実行アカウントと同じです`);
  }

  return {
    mainCalendarId,
    subCalendarId,
    syncTag: readString(props, PROPERTY_KEYS.syncTag, DEFAULTS.syncTag),
    windowPastDays: readPositiveInt(props, PROPERTY_KEYS.windowPastDays, DEFAULTS.windowPastDays),
    windowFutureDays: readPositiveInt(props, PROPERTY_KEYS.windowFutureDays, DEFAULTS.windowFutureDays),
    excludeTitlePatterns: readPatterns(props, PROPERTY_KEYS.excludeTitlePatterns, DEFAULT_EXCLUDE_TITLE_PATTERNS),
    // サフィックスは先頭の空白が意味を持つので trim しない
    mirrorTitleSuffix: props.get(PROPERTY_KEYS.mirrorTitleSuffix) ?? DEFAULTS.mirrorTitleSuffix,
    fallbackPrefixOoo: props.get(PROPERTY_KEYS.fallbackPrefixOoo) ?? DEFAULTS.fallbackPrefixOoo,
    fallbackPrefixFocus: props.get(PROPERTY_KEYS.fallbackPrefixFocus) ?? DEFAULTS.fallbackPrefixFocus,
    appendSourceLinks: readBoolean(props, PROPERTY_KEYS.appendSourceLinks, DEFAULTS.appendSourceLinks),
    dryRun: readBoolean(props, PROPERTY_KEYS.dryRun, DEFAULTS.dryRun),
    notifyEmail: readString(props, PROPERTY_KEYS.notifyEmail, mainCalendarId),
  };
}

function readString(props: PropertyStore, key: string, fallback: string): string {
  const raw = props.get(key)?.trim();
  return raw ? raw : fallback;
}

function readPositiveInt(props: PropertyStore, key: string, fallback: number): number {
  const raw = props.get(key)?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${key} は 0 以上の整数で指定してください（現在値: ${raw}）`);
  }
  return n;
}

function readBoolean(props: PropertyStore, key: string, fallback: boolean): boolean {
  const raw = props.get(key)?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`${key} は true / false で指定してください（現在値: ${raw}）`);
}

/**
 * 正規表現リストの読み出し。GAS のスクリプト プロパティ入力欄は 1 行なので、
 * 区切りは `;`（改行も可）。JSON 配列（`["^【締切】","申請〆"]`）でも受ける。
 */
export function readPatterns(props: PropertyStore, key: string, fallback: string[]): RegExp[] {
  const raw = props.get(key);
  const lines = (raw === null ? fallback : splitPatternList(raw, key))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    try {
      return new RegExp(line);
    } catch (e) {
      throw new Error(`${key} の正規表現が不正です: ${line} (${String(e)})`);
    }
  });
}

function splitPatternList(raw: string, key: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`${key} を JSON 配列として読めません (${String(e)})`);
    }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
      throw new Error(`${key} は文字列の JSON 配列で指定してください`);
    }
    return parsed;
  }
  return trimmed.split(/\r?\n|;/);
}
