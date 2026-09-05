import { describe, expect, it } from 'vitest';
import { DuplicateIndex, exclusionReason, isDeclinedBy } from '../src/filters';
import { makeConfig, SUB, timed } from './helpers';

const cfg = makeConfig();

describe('exclusionReason', () => {
  it('通常予定は対象', () => {
    expect(exclusionReason(timed(1, 10, '打合せ'), SUB, cfg)).toBeNull();
  });

  it('通知系タイトルと【共有】を除外する', () => {
    expect(exclusionReason(timed(1, 10, '【締切】提出'), SUB, cfg)).toBe('title-pattern');
    expect(exclusionReason(timed(1, 10, '社内【共有】用'), SUB, cfg)).toBe('title-pattern');
    expect(exclusionReason(timed(1, 10, '締切について'), SUB, cfg)).toBeNull();
  });

  it('birthday / fromGmail / workingLocation を除外する', () => {
    for (const t of ['birthday', 'fromGmail', 'workingLocation'] as const) {
      expect(exclusionReason(timed(1, 10, 'x', { eventType: t }), SUB, cfg)).toBe('event-type');
    }
    expect(exclusionReason(timed(1, 10, 'x', { eventType: 'outOfOffice' }), SUB, cfg)).toBeNull();
  });

  it('ミラーと cancelled を除外する', () => {
    expect(exclusionReason(timed(1, 10, '定例 (自動生成)'), SUB, cfg)).toBe('mirror');
    expect(exclusionReason(timed(1, 10, 'x', { status: 'cancelled' }), SUB, cfg)).toBe('cancelled');
  });
});

describe('isDeclinedBy', () => {
  it('self ではなくソースカレンダーのアドレスで判定する', () => {
    const ev = timed(1, 10, 'x', {
      attendees: [
        { email: 'main@example.com', self: true, responseStatus: 'declined' },
        { email: SUB, responseStatus: 'accepted' },
      ],
    });
    expect(isDeclinedBy(ev, SUB)).toBe(false);
    expect(isDeclinedBy(ev, 'main@example.com')).toBe(true);
  });

  it('大文字小文字を無視する', () => {
    const ev = timed(1, 10, 'x', { attendees: [{ email: SUB.toUpperCase(), responseStatus: 'declined' }] });
    expect(isDeclinedBy(ev, SUB)).toBe(true);
  });

  it('参加者にいなければ参加扱い', () => {
    expect(isDeclinedBy(timed(1, 10, 'x'), SUB)).toBe(false);
    expect(isDeclinedBy(timed(1, 10, 'x', { attendees: [{ email: 'other@x' }] }), SUB)).toBe(false);
  });
});

describe('DuplicateIndex', () => {
  it('iCalUID 一致を重複とみなす', () => {
    const idx = new DuplicateIndex([timed(1, 10, 'A', { iCalUID: 'uid-1' })]);
    expect(idx.has(timed(2, 14, '別名', { iCalUID: 'uid-1' }))).toBe(true);
  });

  it('タイトル・開始・終了がすべて一致すれば重複', () => {
    const idx = new DuplicateIndex([timed(1, 10, 'A')]);
    expect(idx.has(timed(1, 10, 'A', { iCalUID: 'other' }))).toBe(true);
    expect(idx.has(timed(1, 11, 'A'))).toBe(false);
    expect(idx.has(timed(1, 10, 'B'))).toBe(false);
  });

  it('終了時刻だけ違えば重複ではない（現行コードのバグを再現しない）', () => {
    const idx = new DuplicateIndex([timed(1, 10, 'A')]);
    const longer = timed(1, 10, 'A');
    longer.end = { dateTime: new Date(Date.parse(longer.start.dateTime!) + 7200e3).toISOString() };
    expect(idx.has(longer)).toBe(false);
  });

  it('cancelled の実体は無視する', () => {
    const idx = new DuplicateIndex([timed(1, 10, 'A', { status: 'cancelled' })]);
    expect(idx.has(timed(1, 10, 'A'))).toBe(false);
  });
});
