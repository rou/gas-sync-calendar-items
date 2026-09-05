import { describe, expect, it } from 'vitest';
import { instanceKey, planInstanceReconciliation } from '../src/recurrence';
import type { CalEvent } from '../src/types';

function inst(id: string, iso: string, extra: Partial<CalEvent> = {}): CalEvent {
  return {
    id,
    recurringEventId: 'p',
    originalStartTime: { dateTime: iso },
    start: { dateTime: iso },
    end: { dateTime: new Date(Date.parse(iso) + 3600e3).toISOString() },
    summary: '定例',
    status: 'confirmed',
    ...extra,
  };
}

const build = (src: CalEvent): CalEvent => ({ summary: `${src.summary} (自動生成)`, start: src.start, end: src.end, status: 'confirmed' });

describe('planInstanceReconciliation', () => {
  const t1 = '2026-09-10T01:00:00Z';
  const t2 = '2026-09-11T01:00:00Z';

  it('originalStartTime が同じ回同士を突合し、時刻表記の違いは無視する', () => {
    expect(instanceKey(inst('a', t1))).toBe(instanceKey(inst('b', '2026-09-10T10:00:00+09:00')));
  });

  it('ソースで取り消された回はミラー側を remove する', () => {
    const plan = planInstanceReconciliation([inst('s1', t1, { status: 'cancelled' })], [inst('m1', t1)], build, () => false);
    expect(plan.remove.map((m) => m.id)).toEqual(['m1']);
    expect(plan.patch).toHaveLength(0);
  });

  it('すでに取り消し済みのミラー回は二重に remove しない', () => {
    const plan = planInstanceReconciliation([inst('s1', t1, { status: 'cancelled' })], [inst('m1', t1, { status: 'cancelled' })], build, () => false);
    expect(plan.remove).toHaveLength(0);
  });

  it('除外対象になった回も remove する', () => {
    const plan = planInstanceReconciliation([inst('s1', t1, { summary: '【共有】定例' })], [inst('m1', t1)], build, (s) => /【共有】/.test(s.summary ?? ''));
    expect(plan.remove.map((m) => m.id)).toEqual(['m1']);
  });

  it('生きている回は望ましい本文で patch 候補にする', () => {
    const plan = planInstanceReconciliation([inst('s1', t1, { summary: '変更後' })], [inst('m1', t1)], build, () => false);
    expect(plan.patch).toHaveLength(1);
    expect(plan.patch[0].body.summary).toBe('変更後 (自動生成)');
  });

  it('ミラーに対応する回がなければ unmatched に数える', () => {
    const plan = planInstanceReconciliation([inst('s1', t1), inst('s2', t2)], [inst('m1', t1)], build, () => false);
    expect(plan.unmatched).toBe(1);
  });
});
