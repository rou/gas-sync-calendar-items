import { describe, expect, it } from 'vitest';
import { buildChunks, clearCursor, loadCursor, saveCursor, syncWindow } from '../src/cursor';
import { MemoryProps } from './helpers';

describe('cursor', () => {
  it('ウィンドウを隙間なくチャンクに刻む', () => {
    const win = syncWindow(new Date('2026-09-04T09:00:00Z'), { windowPastDays: 0, windowFutureDays: 90 });
    expect(win.start.toISOString()).toBe('2026-09-04T09:00:00.000Z');
    const chunks = buildChunks(win, 14);
    expect(chunks[0].start.getTime()).toBe(win.start.getTime());
    expect(chunks[chunks.length - 1].end.getTime()).toBe(win.end.getTime());
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start.getTime()).toBe(chunks[i - 1].end.getTime());
    expect(chunks).toHaveLength(7);
  });

  it('保存・復元・削除できる', () => {
    const p = new MemoryProps();
    expect(loadCursor(p)).toBeNull();
    saveCursor(p, { direction: 1, chunk: 3 });
    expect(loadCursor(p)).toEqual({ direction: 1, chunk: 3 });
    clearCursor(p);
    expect(loadCursor(p)).toBeNull();
  });

  it('壊れた値は無視する', () => {
    const p = new MemoryProps();
    p.set('SYNC_CURSOR', 'garbage');
    expect(loadCursor(p)).toBeNull();
  });
});
