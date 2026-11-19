import type { Config } from '../src/config';
import { DEFAULT_EXCLUDE_TITLE_PATTERNS, DEFAULTS } from '../src/config';
import type { Clock, Logger, PropertyStore } from '../src/types';

export const MAIN = 'main@example.com';
export const SUB = 'sub@example.com';

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    mainCalendarId: MAIN,
    subCalendarId: SUB,
    syncTag: DEFAULTS.syncTag,
    windowPastDays: 0,
    windowFutureDays: 90,
    excludeTitlePatterns: DEFAULT_EXCLUDE_TITLE_PATTERNS.map((p) => new RegExp(p)),
    mirrorTitleSuffix: DEFAULTS.mirrorTitleSuffix,
    fallbackPrefixOoo: DEFAULTS.fallbackPrefixOoo,
    fallbackPrefixFocus: DEFAULTS.fallbackPrefixFocus,
    appendSourceLinks: true,
    defaultVisibilityEventTypes: new Set(),
    dryRun: false,
    notifyEmail: MAIN,
    ...overrides,
  };
}

export class MemoryProps implements PropertyStore {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-09-04T09:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(m: string): void {
    this.lines.push(`I ${m}`);
  }
  warn(m: string): void {
    this.lines.push(`W ${m}`);
  }
}

/** now（2026-09-04T09:00Z）から day 日後 hour 時の 1 時間予定。 */
export function timed(day: number, hour: number, summary: string, extra: Partial<import('../src/types').CalEvent> = {}) {
  const base = Date.parse('2026-09-04T00:00:00Z') + day * 86400e3 + hour * 3600e3;
  return {
    summary,
    start: { dateTime: new Date(base).toISOString() },
    end: { dateTime: new Date(base + 3600e3).toISOString() },
    ...extra,
  };
}
