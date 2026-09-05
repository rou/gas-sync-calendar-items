import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDE_TITLE_PATTERNS, loadConfig, PROPERTY_KEYS } from '../src/config';
import { MAIN, MemoryProps, SUB } from './helpers';

describe('loadConfig', () => {
  it('SUB_CALENDAR_ID が無ければ起動しない', () => {
    expect(() => loadConfig(new MemoryProps(), MAIN)).toThrow(/SUB_CALENDAR_ID/);
  });

  it('実行アカウントと同じなら起動しない', () => {
    const p = new MemoryProps();
    p.set(PROPERTY_KEYS.subCalendarId, MAIN.toUpperCase());
    expect(() => loadConfig(p, MAIN)).toThrow(/同じ/);
  });

  it('既定値が入る', () => {
    const p = new MemoryProps();
    p.set(PROPERTY_KEYS.subCalendarId, SUB);
    const cfg = loadConfig(p, MAIN);
    expect(cfg.windowPastDays).toBe(0);
    expect(cfg.windowFutureDays).toBe(90);
    expect(cfg.mirrorTitleSuffix).toBe(' (自動生成)');
    expect(cfg.excludeTitlePatterns.map((r) => r.source)).toEqual(DEFAULT_EXCLUDE_TITLE_PATTERNS);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.notifyEmail).toBe(MAIN);
  });

  it('除外パターンは ; 区切り・改行区切り・JSON 配列のどれでも上書きできる', () => {
    const p = new MemoryProps();
    p.set(PROPERTY_KEYS.subCalendarId, SUB);
    const sources = () => loadConfig(p, MAIN).excludeTitlePatterns.map((r) => r.source);

    p.set(PROPERTY_KEYS.excludeTitlePatterns, '^【締切】; 申請〆 ;;承認〆');
    expect(sources()).toEqual(['^【締切】', '申請〆', '承認〆']);

    p.set(PROPERTY_KEYS.excludeTitlePatterns, '^\\[private\\]\n\n  secret  \n');
    expect(sources()).toEqual(['^\\[private\\]', 'secret']);

    p.set(PROPERTY_KEYS.excludeTitlePatterns, '["^【締切】", "a{1,3};b"]');
    expect(sources()).toEqual(['^【締切】', 'a{1,3};b']);
  });

  it('不正な正規表現や壊れた JSON は弾く', () => {
    const p = new MemoryProps();
    p.set(PROPERTY_KEYS.subCalendarId, SUB);
    p.set(PROPERTY_KEYS.excludeTitlePatterns, '(unclosed');
    expect(() => loadConfig(p, MAIN)).toThrow(/正規表現が不正/);
    p.set(PROPERTY_KEYS.excludeTitlePatterns, '["ok", 1]');
    expect(() => loadConfig(p, MAIN)).toThrow(/JSON 配列/);
    p.set(PROPERTY_KEYS.excludeTitlePatterns, '[broken');
    expect(() => loadConfig(p, MAIN)).toThrow(/JSON 配列/);
  });

  it('真偽値と数値の指定ミスを弾く', () => {
    const p = new MemoryProps();
    p.set(PROPERTY_KEYS.subCalendarId, SUB);
    p.set(PROPERTY_KEYS.dryRun, 'yes');
    expect(loadConfig(p, MAIN).dryRun).toBe(true);
    p.set(PROPERTY_KEYS.dryRun, 'maybe');
    expect(() => loadConfig(p, MAIN)).toThrow(/DRY_RUN/);
    p.delete(PROPERTY_KEYS.dryRun);
    p.set(PROPERTY_KEYS.windowFutureDays, '-1');
    expect(() => loadConfig(p, MAIN)).toThrow(/WINDOW_FUTURE_DAYS/);
  });

  it('サフィックスの先頭空白を保つ', () => {
    const p = new MemoryProps();
    p.set(PROPERTY_KEYS.subCalendarId, SUB);
    p.set(PROPERTY_KEYS.mirrorTitleSuffix, ' [copy]');
    expect(loadConfig(p, MAIN).mirrorTitleSuffix).toBe(' [copy]');
  });
});
