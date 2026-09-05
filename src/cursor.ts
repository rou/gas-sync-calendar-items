import type { PropertyStore, TimeRange } from './types';
import { CHUNK_DAYS, PROPERTY_KEYS, type Config } from './config';

/** どの方向のどのチャンクまで処理したか。実行を跨いで引き継ぐ。 */
export interface Cursor {
  direction: number;
  chunk: number;
}

export function loadCursor(props: PropertyStore): Cursor | null {
  const raw = props.get(PROPERTY_KEYS.syncCursor);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    if (typeof parsed.direction !== 'number' || typeof parsed.chunk !== 'number') return null;
    return { direction: parsed.direction, chunk: parsed.chunk };
  } catch {
    return null;
  }
}

export function saveCursor(props: PropertyStore, cursor: Cursor): void {
  props.set(PROPERTY_KEYS.syncCursor, JSON.stringify(cursor));
}

export function clearCursor(props: PropertyStore): void {
  props.delete(PROPERTY_KEYS.syncCursor);
}

export function syncWindow(now: Date, cfg: Pick<Config, 'windowPastDays' | 'windowFutureDays'>): TimeRange {
  const start = new Date(now.getTime() - cfg.windowPastDays * DAY_MS);
  const end = new Date(now.getTime() + cfg.windowFutureDays * DAY_MS);
  return { start, end };
}

export function buildChunks(window: TimeRange, chunkDays: number = CHUNK_DAYS): TimeRange[] {
  const chunks: TimeRange[] = [];
  let cursor = window.start.getTime();
  const endMs = window.end.getTime();
  const step = chunkDays * DAY_MS;
  while (cursor < endMs) {
    const next = Math.min(cursor + step, endMs);
    chunks.push({ start: new Date(cursor), end: new Date(next) });
    cursor = next;
  }
  return chunks;
}

const DAY_MS = 24 * 60 * 60 * 1000;
