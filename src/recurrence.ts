import type { CalEvent } from './types';
import { dateKey } from './mapping';

export interface InstancePlan {
  /** ミラー側インスタンスをこの本文で patch する（例外の反映、または例外の解消）。 */
  patch: Array<{ mirrorInstance: CalEvent; body: CalEvent }>;
  /** ミラー側インスタンスを削除する（ソースで取り消された、または除外対象になった）。 */
  remove: CalEvent[];
  /** ソースにあるのにミラーに対応インスタンスがない数。RRULE の転記ずれの兆候。 */
  unmatched: number;
}

/** originalStartTime を正規化したキー。ソースとミラーの RRULE が同じなら一致する。 */
export function instanceKey(instance: CalEvent): string | null {
  return dateKey(instance.originalStartTime) ?? dateKey(instance.start);
}

/**
 * Pass 3（spec §12）。ソースとミラーのインスタンスを originalStartTime で突合し、
 * 何を patch / remove すべきかを決める。副作用はない。
 */
export function planInstanceReconciliation(
  sourceInstances: CalEvent[],
  mirrorInstances: CalEvent[],
  buildBody: (sourceInstance: CalEvent) => CalEvent,
  isExcluded: (sourceInstance: CalEvent) => boolean,
): InstancePlan {
  const plan: InstancePlan = { patch: [], remove: [], unmatched: 0 };
  const mirrorsByKey = new Map<string, CalEvent>();
  for (const m of mirrorInstances) {
    const key = instanceKey(m);
    if (key) mirrorsByKey.set(key, m);
  }

  for (const src of sourceInstances) {
    const key = instanceKey(src);
    if (!key) continue;
    const mirror = mirrorsByKey.get(key);
    if (!mirror) {
      if (src.status !== 'cancelled') plan.unmatched += 1;
      continue;
    }
    if (src.status === 'cancelled' || isExcluded(src)) {
      if (mirror.status !== 'cancelled') plan.remove.push(mirror);
      continue;
    }
    // 例外でも通常回でも、望ましい本文と比べて違えば patch。差がなければ何もしない
    const body = buildBody(src);
    plan.patch.push({ mirrorInstance: mirror, body });
  }
  return plan;
}
