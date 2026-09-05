import { describe, expect, it } from 'vitest';
import { buildMarkerProps, isLegacyMirrorTitle, isMirror, readMarker } from '../src/markers';

describe('markers', () => {
  const marker = { tag: 'calendar-sync/v1', srcCal: 'sub@x', srcId: 'e1', srcUid: 'u1', srcUpdated: '2026-01-01T00:00:00Z', kind: 'single' as const };

  it('書いた印を読み返せる', () => {
    const ev = { extendedProperties: { private: buildMarkerProps(marker) } };
    expect(readMarker(ev)).toEqual(marker);
  });

  it('csTag が無ければミラーではない', () => {
    expect(readMarker({ extendedProperties: { private: { other: 'x' } } })).toBeNull();
    expect(readMarker({})).toBeNull();
  });

  it('旧マーカー 3 種を恒久的に認識する', () => {
    expect(isLegacyMirrorTitle('(block)')).toBe(true);
    expect(isLegacyMirrorTitle('空き枠同期中')).toBe(true);
    expect(isLegacyMirrorTitle('定例 (自動生成)')).toBe(true);
    expect(isLegacyMirrorTitle('定例')).toBe(false);
  });

  it('現在のサフィックスでもミラー扱い', () => {
    expect(isMirror({ summary: '定例 [mirror]' }, ' [mirror]')).toBe(true);
    expect(isMirror({ summary: '定例' }, ' [mirror]')).toBe(false);
  });
});
