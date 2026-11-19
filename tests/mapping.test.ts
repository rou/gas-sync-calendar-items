import { describe, expect, it } from 'vitest';
import { buildMirrorBody, mirrorFieldsEqual } from '../src/mapping';
import { makeConfig, SUB, timed } from './helpers';

const cfg = makeConfig();
const marker = { tag: cfg.syncTag, srcCal: SUB, srcId: 'e1', srcUid: 'u1', srcUpdated: '2026-01-01T00:00:00Z', kind: 'single' as const };
const insertOpts = { nativeStatusType: true, includeEventType: true, includeRecurrence: false };

describe('buildMirrorBody', () => {
  it('参加者・会議・添付を持ち込まず、非公開・サフィックス付きにする', () => {
    const src = timed(1, 10, '打合せ', {
      attendees: [{ email: 'a@x' }],
      organizer: { email: 'a@x' },
      conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/abc' }] },
      attachments: [{ title: '資料.pdf', fileUrl: 'https://drive/x' }],
      description: '本文',
      location: '会議室A',
      colorId: '5',
    });
    const body = buildMirrorBody(src, marker, cfg, insertOpts);
    expect(body.summary).toBe('打合せ (自動生成)');
    expect(body.attendees).toBeUndefined();
    expect(body.organizer).toBeUndefined();
    expect(body.conferenceData).toBeUndefined();
    expect(body.attachments).toBeUndefined();
    expect(body.visibility).toBe('private');
    expect(body.reminders).toEqual({ useDefault: true });
    expect(body.location).toBe('会議室A');
    expect(body.colorId).toBe('5');
    expect(body.description).toBe('本文\n\nMeet: https://meet.google.com/abc\n添付: 資料.pdf');
    expect(body.extendedProperties?.private?.csSrcId).toBe('e1');
    expect(body.eventType).toBe('default');
  });

  it('APPEND_SOURCE_LINKS=false なら本文をそのまま', () => {
    const src = timed(1, 10, 'x', { description: '本文', hangoutLink: 'https://meet/x' });
    expect(buildMirrorBody(src, marker, makeConfig({ appendSourceLinks: false }), insertOpts).description).toBe('本文');
  });

  it('不在を本来の種別で作るときは eventType と opaque を付ける', () => {
    const src = timed(1, 10, '休暇', { eventType: 'outOfOffice', outOfOfficeProperties: { autoDeclineMode: 'declineAll' } });
    const body = buildMirrorBody(src, marker, cfg, insertOpts);
    expect(body.eventType).toBe('outOfOffice');
    expect(body.transparency).toBe('opaque');
    expect(body.outOfOfficeProperties).toEqual({ autoDeclineMode: 'declineAll' });
    expect(body.summary).toBe('休暇 (自動生成)');
  });

  it('退避時は default にして接頭辞を付ける', () => {
    const src = timed(1, 10, '休暇', { eventType: 'outOfOffice' });
    const body = buildMirrorBody(src, marker, cfg, { ...insertOpts, nativeStatusType: false });
    expect(body.eventType).toBe('default');
    expect(body.summary).toBe('🏖 休暇 (自動生成)');
    expect(body.transparency).toBe('opaque');
    const focus = buildMirrorBody(timed(1, 10, '集中', { eventType: 'focusTime' }), marker, cfg, { ...insertOpts, nativeStatusType: false });
    expect(focus.summary).toBe('🎧 集中 (自動生成)');
  });

  it('終日の不在は必ず退避する', () => {
    const src = { summary: '休暇', eventType: 'outOfOffice' as const, start: { date: '2026-09-10' }, end: { date: '2026-09-11' } };
    const body = buildMirrorBody(src, marker, cfg, insertOpts);
    expect(body.eventType).toBe('default');
    expect(body.summary).toBe('🏖 休暇 (自動生成)');
    expect(body.start).toEqual({ date: '2026-09-10' });
  });

  it('patch 用の本文には eventType を入れない', () => {
    const body = buildMirrorBody(timed(1, 10, 'x', { eventType: 'outOfOffice' }), marker, cfg, { ...insertOpts, includeEventType: false });
    expect(body.eventType).toBeUndefined();
  });

  it('recurrence は要求されたときだけ転記する', () => {
    const src = timed(1, 10, 'x', { recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(buildMirrorBody(src, marker, cfg, insertOpts).recurrence).toBeUndefined();
    expect(buildMirrorBody(src, marker, cfg, { ...insertOpts, includeRecurrence: true }).recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('transparent は転記する', () => {
    expect(buildMirrorBody(timed(1, 10, 'x', { transparency: 'transparent' }), marker, cfg, insertOpts).transparency).toBe('transparent');
  });
});

describe('buildMirrorBody: visibility', () => {
  const ooo = timed(1, 10, '休暇', { eventType: 'outOfOffice' });
  const oooAllDay = { summary: '休暇', eventType: 'outOfOffice' as const, start: { date: '2026-09-10' }, end: { date: '2026-09-11' } };
  const focus = timed(1, 10, '集中', { eventType: 'focusTime' });
  const plain = timed(1, 10, '打合せ');

  it('既定（空）ではどの種別も private', () => {
    for (const src of [plain, ooo, oooAllDay, focus]) {
      expect(buildMirrorBody(src, marker, cfg, insertOpts).visibility).toBe('private');
    }
  });

  it('outOfOffice を指定すると、本来の種別・退避・終日のどれでも default', () => {
    const c = makeConfig({ defaultVisibilityEventTypes: new Set(['outOfOffice']) });
    expect(buildMirrorBody(ooo, marker, c, insertOpts).visibility).toBe('default');
    const fallback = buildMirrorBody(ooo, marker, c, { ...insertOpts, nativeStatusType: false });
    expect(fallback.eventType).toBe('default');
    expect(fallback.visibility).toBe('default');
    expect(buildMirrorBody(oooAllDay, marker, c, insertOpts).visibility).toBe('default');
    expect(buildMirrorBody(focus, marker, c, insertOpts).visibility).toBe('private');
    expect(buildMirrorBody(plain, marker, c, insertOpts).visibility).toBe('private');
  });

  it('default を指定すると eventType 未設定の通常予定も default', () => {
    const c = makeConfig({ defaultVisibilityEventTypes: new Set(['default', 'focusTime']) });
    expect(buildMirrorBody(plain, marker, c, insertOpts).visibility).toBe('default');
    expect(buildMirrorBody(focus, marker, c, insertOpts).visibility).toBe('default');
    expect(buildMirrorBody(ooo, marker, c, insertOpts).visibility).toBe('private');
  });
});

describe('mirrorFieldsEqual', () => {
  it('visibility の差を検出し、未設定は default とみなす', () => {
    const a = timed(1, 10, 'x', { visibility: 'private' });
    expect(mirrorFieldsEqual(a, { ...a, visibility: 'default' })).toBe(false);
    expect(mirrorFieldsEqual({ ...a, visibility: undefined }, { ...a, visibility: 'default' })).toBe(true);
  });

  it('同じ時刻を別表記で持っていても等しい', () => {
    const a = timed(1, 10, 'x');
    const b = { ...a, start: { dateTime: '2026-09-05T19:00:00+09:00' }, end: { dateTime: '2026-09-05T20:00:00+09:00' } };
    expect(mirrorFieldsEqual(a, b)).toBe(true);
  });
  it('タイトルが違えば等しくない', () => {
    expect(mirrorFieldsEqual(timed(1, 10, 'x'), timed(1, 10, 'y'))).toBe(false);
  });
});
