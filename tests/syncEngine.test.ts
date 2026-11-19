import { beforeEach, describe, expect, it } from 'vitest';
import { PROPERTY_KEYS } from '../src/config';
import { readMarker } from '../src/markers';
import { runSync, type SyncDeps } from '../src/syncEngine';
import type { CalEvent } from '../src/types';
import { FakeGateway } from './fakeGateway';
import { FixedClock, MAIN, makeConfig, MemoryLogger, MemoryProps, SUB, timed } from './helpers';

let gw: FakeGateway;
let props: MemoryProps;
let clock: FixedClock;
let log: MemoryLogger;

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { gw, props, clock, log, cfg: makeConfig(), ...overrides };
}

function mirrorsIn(cal: string): CalEvent[] {
  return gw.live(cal).filter((e) => readMarker(e));
}

beforeEach(() => {
  gw = new FakeGateway();
  props = new MemoryProps();
  clock = new FixedClock();
  log = new MemoryLogger();
});

describe('runSync: 基本の双方向同期', () => {
  it('両方向にミラーを作り、2 回目以降は何もしない', () => {
    gw.seed(SUB, timed(1, 10, 'サブの予定', { description: '本文' }));
    gw.seed(MAIN, timed(2, 14, 'メインの予定'));

    const first = runSync(deps());
    expect(first.completed).toBe(true);
    expect(first.stats.created).toBe(2);
    expect(mirrorsIn(MAIN).map((m) => m.summary)).toEqual(['サブの予定 (自動生成)']);
    expect(mirrorsIn(SUB).map((m) => m.summary)).toEqual(['メインの予定 (自動生成)']);
    expect(mirrorsIn(MAIN)[0].visibility).toBe('private');
    expect(readMarker(mirrorsIn(MAIN)[0])?.srcCal).toBe(SUB);

    for (let i = 0; i < 3; i++) {
      const again = runSync(deps());
      expect(again.stats.created).toBe(0);
      expect(again.stats.updated).toBe(0);
      expect(again.stats.deleted).toBe(0);
    }
    expect(gw.live(MAIN)).toHaveLength(2);
    expect(gw.live(SUB)).toHaveLength(2);
  });

  it('定常時は list 以外の API を呼ばない', () => {
    gw.seed(SUB, timed(1, 10, 'a'));
    runSync(deps());
    const before = { ...gw.calls };
    runSync(deps());
    expect(gw.calls.insert).toBe(before.insert);
    expect(gw.calls.patch).toBe(before.patch);
    expect(gw.calls.delete).toBe(before.delete);
    expect(gw.calls.get).toBe(before.get);
  });

  it('ソースの updated が変わったときだけ patch する', () => {
    const src = gw.seed(SUB, timed(1, 10, '旧タイトル'));
    runSync(deps());
    gw.patchEvent(SUB, src.id!, { summary: '新タイトル' });
    const r = runSync(deps());
    expect(r.stats.updated).toBe(1);
    expect(mirrorsIn(MAIN)[0].summary).toBe('新タイトル (自動生成)');
    expect(runSync(deps()).stats.updated).toBe(0);
  });

  it('ソースが消えたらミラーも消す', () => {
    const src = gw.seed(SUB, timed(1, 10, 'a'));
    runSync(deps());
    gw.deleteEvent(SUB, src.id!);
    const r = runSync(deps());
    expect(r.stats.deleted).toBe(1);
    expect(mirrorsIn(MAIN)).toHaveLength(0);
  });

  it('あとから【共有】を付けたらミラーを消す', () => {
    const src = gw.seed(SUB, timed(1, 10, '打合せ'));
    runSync(deps());
    gw.patchEvent(SUB, src.id!, { summary: '【共有】打合せ' });
    const r = runSync(deps());
    expect(r.stats.deleted).toBe(1);
    expect(mirrorsIn(MAIN)).toHaveLength(0);
  });

  it('時間が動いてチャンクを跨いでもミラーは 1 つのまま', () => {
    const src = gw.seed(SUB, timed(1, 10, 'a'));
    runSync(deps());
    gw.patchEvent(SUB, src.id!, timed(40, 10, 'a'));
    runSync(deps());
    const mirrors = mirrorsIn(MAIN);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].start?.dateTime).toBe(timed(40, 10, 'a').start.dateTime);
  });
});

describe('runSync: 除外と重複', () => {
  it('通知系・辞退・種別・ミラー自身をコピーしない', () => {
    gw.seed(SUB, timed(1, 9, '【締切】提出'));
    gw.seed(SUB, timed(1, 10, '辞退済み', { attendees: [{ email: SUB, responseStatus: 'declined' }] }));
    gw.seed(SUB, timed(1, 11, '誕生日', { eventType: 'birthday' }));
    gw.seed(SUB, timed(1, 12, '旧ミラー (自動生成)'));
    gw.seed(SUB, timed(1, 13, '(block)'));
    gw.seed(SUB, timed(1, 14, '空き枠同期中'));
    const r = runSync(deps());
    expect(r.stats.created).toBe(0);
    expect(mirrorsIn(MAIN)).toHaveLength(0);
  });

  it('self が declined でもソースのアドレスが accepted なら同期する', () => {
    gw.seed(SUB, timed(1, 10, '会議', {
      attendees: [
        { email: MAIN, self: true, responseStatus: 'declined' },
        { email: SUB, responseStatus: 'accepted' },
      ],
    }));
    expect(runSync(deps()).stats.created).toBe(1);
  });

  it('あとから不参加にしたらミラーを消す', () => {
    const src = gw.seed(SUB, timed(1, 10, '会議', { attendees: [{ email: SUB, responseStatus: 'accepted' }] }));
    runSync(deps());
    expect(mirrorsIn(MAIN)).toHaveLength(1);
    gw.patchEvent(SUB, src.id!, { attendees: [{ email: SUB, responseStatus: 'declined' }] });
    const r = runSync(deps());
    expect(r.stats.deleted).toBe(1);
    expect(mirrorsIn(MAIN)).toHaveLength(0);
    expect(runSync(deps()).stats.created).toBe(0);
  });

  it('繰り返しの 1 回だけ不参加にしたら、ミラーのその回だけ消す', () => {
    const parent = gw.seed(SUB, timed(1, 10, '定例', { recurrence: ['RRULE:FREQ=DAILY;COUNT=3'], attendees: [{ email: SUB, responseStatus: 'accepted' }] }));
    runSync(deps());
    const mirrorParent = mirrorsIn(MAIN)[0];
    gw.modifyInstance(SUB, parent.id!, 1, { attendees: [{ email: SUB, responseStatus: 'declined' }] });
    const r = runSync(deps());
    expect(r.stats.deleted).toBe(1);
    const mi = gw.instancesOf(MAIN, mirrorParent.id!);
    expect(mi.map((i) => i.status)).toEqual(['confirmed', 'cancelled', 'confirmed']);
    expect(mirrorsIn(MAIN)).toHaveLength(1);
  });

  it('同じ会議が両方にあれば iCalUID でミラーを作らない', () => {
    gw.seed(SUB, timed(1, 10, '全社会議', { iCalUID: 'shared-uid' }));
    gw.seed(MAIN, timed(1, 10, '全社会議', { iCalUID: 'shared-uid' }));
    const r = runSync(deps());
    expect(r.stats.created).toBe(0);
    expect(gw.live(MAIN)).toHaveLength(1);
    expect(gw.live(SUB)).toHaveLength(1);
  });

  it('あとから実体が現れたらミラーを消す', () => {
    gw.seed(SUB, timed(1, 10, '会議', { iCalUID: 'u' }));
    runSync(deps());
    expect(mirrorsIn(MAIN)).toHaveLength(1);
    gw.seed(MAIN, timed(1, 10, '会議', { iCalUID: 'u' }));
    const r = runSync(deps());
    expect(r.stats.deleted).toBe(1);
    expect(mirrorsIn(MAIN)).toHaveLength(0);
  });

  it('終日予定と空き時間の予定はコピーする', () => {
    gw.seed(SUB, { summary: '終日', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } });
    gw.seed(SUB, timed(1, 10, '空き', { transparency: 'transparent' }));
    const r = runSync(deps());
    expect(r.stats.created).toBe(2);
    const m = mirrorsIn(MAIN);
    expect(m.find((e) => e.summary?.startsWith('終日'))?.start).toEqual({ date: '2026-09-10' });
    expect(m.find((e) => e.summary?.startsWith('空き'))?.transparency).toBe('transparent');
  });
});

describe('runSync: 種別のフォールバック', () => {
  it('本来の種別で拒否されたら通常予定にして、以後は最初から default で作る', () => {
    gw.insertShouldFail = (cal, body) =>
      cal === SUB && body.eventType === 'outOfOffice' ? new Error('Invalid value for: eventType') : null;
    gw.seed(MAIN, timed(1, 10, '休暇', { eventType: 'outOfOffice' }));
    gw.seed(MAIN, timed(2, 10, '休暇2', { eventType: 'outOfOffice' }));
    gw.seed(SUB, timed(3, 10, 'サブ休暇', { eventType: 'outOfOffice' }));

    const r = runSync(deps());
    expect(r.stats.created).toBe(3);
    expect(r.stats.failed).toBe(0);
    const subMirrors = mirrorsIn(SUB);
    expect(subMirrors.map((m) => m.eventType)).toEqual(['default', 'default']);
    expect(subMirrors.map((m) => m.summary).sort()).toEqual(['🏖 休暇 (自動生成)', '🏖 休暇2 (自動生成)']);
    expect(mirrorsIn(MAIN)[0].eventType).toBe('outOfOffice');
    expect(mirrorsIn(MAIN)[0].summary).toBe('サブ休暇 (自動生成)');

    const nativeAttempts = gw.insertedBodies.filter((b) => b.calendarId === SUB && b.body.eventType === 'outOfOffice');
    expect(nativeAttempts).toHaveLength(1);
    expect(JSON.parse(props.get(PROPERTY_KEYS.eventTypeFallbackCache)!)).toEqual({ [`${SUB}|outOfOffice`]: true });
  });

  it('退避済みミラーを更新しても eventType を送らない', () => {
    gw.insertShouldFail = (cal, body) => (cal === SUB && body.eventType === 'focusTime' ? new Error('rejected') : null);
    const src = gw.seed(MAIN, timed(1, 10, '集中', { eventType: 'focusTime' }));
    runSync(deps());
    gw.patchEvent(MAIN, src.id!, { summary: '集中2' });
    const r = runSync(deps());
    expect(r.stats.updated).toBe(1);
    expect(r.stats.failed).toBe(0);
    expect(mirrorsIn(SUB)[0].summary).toBe('🎧 集中2 (自動生成)');
    expect(mirrorsIn(SUB)[0].eventType).toBe('default');
  });
});

describe('runSync: visibility', () => {
  const oooPublic = () => makeConfig({ defaultVisibilityEventTypes: new Set(['outOfOffice']) });

  it('不在だけ default にする。退避先・終日・方向が違っても揃う', () => {
    gw.insertShouldFail = (cal, body) =>
      cal === SUB && body.eventType === 'outOfOffice' ? new Error('Invalid value for: eventType') : null;
    gw.seed(MAIN, timed(1, 10, '休暇', { eventType: 'outOfOffice' }));
    gw.seed(SUB, timed(2, 10, 'サブ休暇', { eventType: 'outOfOffice' }));
    gw.seed(SUB, { summary: '終日休暇', eventType: 'outOfOffice', start: { date: '2026-09-08' }, end: { date: '2026-09-09' } });
    gw.seed(MAIN, timed(3, 10, '打合せ'));

    runSync(deps({ cfg: oooPublic() }));
    const vis = (cal: string) =>
      Object.fromEntries(mirrorsIn(cal).map((m) => [m.summary, m.visibility]));
    // メイン→サブは退避（🏖 付きの通常予定）になるが、それでも default
    expect(vis(SUB)).toEqual({ '🏖 休暇 (自動生成)': 'default', '打合せ (自動生成)': 'private' });
    // サブ→メインは本来の種別と、終日による退避
    expect(vis(MAIN)).toEqual({ 'サブ休暇 (自動生成)': 'default', '🏖 終日休暇 (自動生成)': 'default' });
  });

  it('設定を後から変えると既存ミラーを 1 回だけ patch し、以後は何もしない', () => {
    gw.seed(SUB, timed(1, 10, '休暇', { eventType: 'outOfOffice' }));
    gw.seed(SUB, timed(2, 10, '打合せ'));
    runSync(deps());
    expect(mirrorsIn(MAIN).map((m) => m.visibility)).toEqual(['private', 'private']);

    const first = runSync(deps({ cfg: oooPublic() }));
    expect(first.stats.created).toBe(0);
    expect(first.stats.updated).toBe(1);
    expect(mirrorsIn(MAIN).find((m) => m.summary === '休暇 (自動生成)')?.visibility).toBe('default');

    for (let i = 0; i < 2; i++) {
      const again = runSync(deps({ cfg: oooPublic() }));
      expect(again.stats.created).toBe(0);
      expect(again.stats.updated).toBe(0);
    }

    // 設定を外せば private に戻る
    expect(runSync(deps()).stats.updated).toBe(1);
    expect(mirrorsIn(MAIN).map((m) => m.visibility)).toEqual(['private', 'private']);
  });
});

describe('runSync: 繰り返し予定', () => {
  it('親を RRULE ごとコピーし、例外と取り消しを回単位で追随する', () => {
    const parent = gw.seed(SUB, timed(1, 10, '定例', { recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] }));
    const r1 = runSync(deps());
    expect(r1.stats.created).toBe(1);
    const mirrorParent = mirrorsIn(MAIN)[0];
    expect(mirrorParent.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=3']);
    expect(readMarker(mirrorParent)?.kind).toBe('recurringParent');
    expect(gw.instancesOf(MAIN, mirrorParent.id!)).toHaveLength(3);

    expect(runSync(deps()).stats.updated).toBe(0);

    // 2 回目を 1 時間ずらし、3 回目を取り消す
    const second = gw.instancesOf(SUB, parent.id!)[1];
    gw.modifyInstance(SUB, parent.id!, 1, {
      summary: '定例（時間変更）',
      start: { dateTime: new Date(Date.parse(second.start!.dateTime!) + 3600e3).toISOString() },
      end: { dateTime: new Date(Date.parse(second.end!.dateTime!) + 3600e3).toISOString() },
    });
    gw.modifyInstance(SUB, parent.id!, 2, { status: 'cancelled' });

    const r2 = runSync(deps());
    expect(r2.stats.updated).toBe(1);
    expect(r2.stats.deleted).toBe(1);
    const mi = gw.instancesOf(MAIN, mirrorParent.id!);
    expect(mi[1].summary).toBe('定例（時間変更） (自動生成)');
    expect(mi[1].start?.dateTime).toBe(gw.instancesOf(SUB, parent.id!)[1].start?.dateTime);
    expect(mi[2].status).toBe('cancelled');

    const r3 = runSync(deps());
    expect(r3.stats.updated + r3.stats.deleted + r3.stats.created).toBe(0);
  });

  it('親が消えたらミラーの親も消す', () => {
    const parent = gw.seed(SUB, timed(1, 10, '定例', { recurrence: ['RRULE:FREQ=DAILY;COUNT=2'] }));
    runSync(deps());
    gw.deleteEvent(SUB, parent.id!);
    const r = runSync(deps());
    expect(r.stats.deleted).toBe(1);
    expect(mirrorsIn(MAIN)).toHaveLength(0);
  });

  it('繰り返しミラーは逆方向でソース扱いされない', () => {
    gw.seed(SUB, timed(1, 10, '定例', { recurrence: ['RRULE:FREQ=DAILY;COUNT=2'] }));
    runSync(deps());
    runSync(deps());
    expect(gw.live(SUB).filter((e) => readMarker(e))).toHaveLength(0);
  });
});

describe('runSync: dry-run とカーソル', () => {
  it('DRY_RUN では書き込まずに件数だけ数える', () => {
    gw.seed(SUB, timed(1, 10, 'a'));
    gw.seed(MAIN, timed(1, 10, 'b'));
    const r = runSync(deps({ cfg: makeConfig({ dryRun: true }) }));
    expect(r.stats.created).toBe(2);
    expect(gw.calls.insert).toBe(0);
    expect(gw.calls.patch).toBe(0);
    expect(gw.calls.delete).toBe(0);
    expect(log.lines.some((l) => l.includes('[dry-run] create'))).toBe(true);
  });

  it('時間予算を超えたらカーソルを保存し、次回はそこから再開して完走する', () => {
    gw.seed(SUB, timed(1, 10, 'a'));
    gw.seed(SUB, timed(80, 10, 'b'));
    gw.seed(MAIN, timed(50, 10, 'c'));

    // 各チャンク処理のたびに時計が 1 分進むようにして、予算 0 で毎回 1 チャンクずつ止める
    const slowClock = new (class extends FixedClock {
      override now(): Date {
        this.advance(60_000);
        return super.now();
      }
    })();
    let runs = 0;
    let result;
    do {
      result = runSync(deps({ clock: slowClock, timeBudgetMs: 0 }));
      runs += 1;
      if (!result.completed) expect(props.get(PROPERTY_KEYS.syncCursor)).not.toBeNull();
    } while (!result.completed && runs < 50);

    expect(result.completed).toBe(true);
    expect(runs).toBeGreaterThan(1);
    expect(props.get(PROPERTY_KEYS.syncCursor)).toBeNull();
    expect(mirrorsIn(MAIN).map((m) => m.summary).sort()).toEqual(['a (自動生成)', 'b (自動生成)']);
    expect(mirrorsIn(SUB).map((m) => m.summary)).toEqual(['c (自動生成)']);
  });

  it('1 件の失敗で全体を止めず failed に数える', () => {
    gw.insertShouldFail = (_cal, body) => (body.summary?.startsWith('壊れる') ? new Error('boom') : null);
    gw.seed(SUB, timed(1, 10, '壊れる'));
    gw.seed(SUB, timed(1, 12, '正常'));
    const r = runSync(deps());
    expect(r.stats.failed).toBe(1);
    expect(r.stats.created).toBe(1);
    expect(r.completed).toBe(true);
    expect(r.stats.failures[0]).toMatch(/壊れる/);
  });
});
