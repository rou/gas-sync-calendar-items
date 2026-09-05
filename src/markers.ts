import type { CalEvent } from './types';

/**
 * ミラーの印。extendedProperties.private に格納する。
 * キーは 44 文字以内、値は 1024 文字以内という API 制限がある。
 */
export const MARKER_KEYS = {
  tag: 'csTag',
  srcCal: 'csSrcCal',
  srcId: 'csSrcId',
  srcUid: 'csSrcUid',
  srcUpdated: 'csSrcUpdated',
  kind: 'csKind',
} as const;

export type MirrorKind = 'single' | 'recurringParent';

export interface MirrorMarker {
  tag: string;
  srcCal: string;
  srcId: string;
  srcUid: string;
  srcUpdated: string;
  kind: MirrorKind;
}

/**
 * 現行スクリプトが作ったミラーの印。恒久的に残す（spec §4）。
 * 取りこぼしが 1 件でもあると逆コピーで予定が増殖するため。
 */
export const LEGACY_BLOCK_TITLE = '(block)';
export const LEGACY_IN_PROGRESS_TITLE = '空き枠同期中';
export const LEGACY_SUFFIX_RE = /\(自動生成\)$/;

export function readMarker(event: CalEvent): MirrorMarker | null {
  const p = event.extendedProperties?.private;
  if (!p || !p[MARKER_KEYS.tag]) return null;
  return {
    tag: p[MARKER_KEYS.tag],
    srcCal: p[MARKER_KEYS.srcCal] ?? '',
    srcId: p[MARKER_KEYS.srcId] ?? '',
    srcUid: p[MARKER_KEYS.srcUid] ?? '',
    srcUpdated: p[MARKER_KEYS.srcUpdated] ?? '',
    kind: p[MARKER_KEYS.kind] === 'recurringParent' ? 'recurringParent' : 'single',
  };
}

export function buildMarkerProps(marker: MirrorMarker): Record<string, string> {
  return {
    [MARKER_KEYS.tag]: marker.tag,
    [MARKER_KEYS.srcCal]: marker.srcCal,
    [MARKER_KEYS.srcId]: marker.srcId,
    [MARKER_KEYS.srcUid]: marker.srcUid,
    [MARKER_KEYS.srcUpdated]: marker.srcUpdated,
    [MARKER_KEYS.kind]: marker.kind,
  };
}

export function isLegacyMirrorTitle(title: string | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  return t === LEGACY_BLOCK_TITLE || t === LEGACY_IN_PROGRESS_TITLE || LEGACY_SUFFIX_RE.test(t);
}

/**
 * ループ防止の判定。新マーカー・旧マーカー・現在のサフィックスのどれかに当たればミラー。
 * タグ値の一致は見ない。別バージョンのタグでもミラーであることに変わりはなく、
 * 再コピーしてよい理由にはならない。
 */
export function isMirror(event: CalEvent, suffix: string): boolean {
  if (readMarker(event)) return true;
  if (isLegacyMirrorTitle(event.summary)) return true;
  if (suffix && event.summary && event.summary.endsWith(suffix)) return true;
  return false;
}

export function applyTitleSuffix(title: string, suffix: string): string {
  return `${title}${suffix}`;
}
