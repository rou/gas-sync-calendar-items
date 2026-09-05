import type { CalEvent, CalendarGateway, Clock, Logger, PropertyStore, TimeRange } from './types';
import { TIME_BUDGET_MS, type Config } from './config';
import { buildChunks, clearCursor, loadCursor, saveCursor, syncWindow, type Cursor } from './cursor';
import { DuplicateIndex, exclusionReason } from './filters';
import { SyncStats } from './log';
import { buildMirrorBody, isStatusEventType } from './mapping';
import { isLegacyMirrorTitle, readMarker, type MirrorMarker } from './markers';
import { MirrorWriter, describe } from './mirrorWriter';
import { planInstanceReconciliation } from './recurrence';
import { readSourceChunk } from './sourceReader';

export interface SyncDeps {
  gw: CalendarGateway;
  props: PropertyStore;
  clock: Clock;
  log: Logger;
  cfg: Config;
  timeBudgetMs?: number;
}

interface Direction {
  source: string;
  target: string;
}

interface MirrorRef {
  /** 単発ならそのミラーの id、繰り返しなら親の id。 */
  mirrorId: string;
  marker: MirrorMarker;
  /** 単発のときはミラー本体。繰り返しのときは代表インスタンス。 */
  sample: CalEvent;
}

interface DirectionContext {
  dir: Direction;
  cfg: Config;
  writer: MirrorWriter;
  stats: SyncStats;
  parentCache: Map<string, CalEvent | null>;
}

export interface SyncResult {
  stats: SyncStats;
  completed: boolean;
  cursor: Cursor | null;
}

/**
 * 1 回のトリガー実行。カーソルから再開し、時間予算を使い切ったら保存して抜ける。
 */
export function runSync(deps: SyncDeps): SyncResult {
  const { cfg, props, clock, log } = deps;
  const startedAt = clock.now().getTime();
  const budget = deps.timeBudgetMs ?? TIME_BUDGET_MS;
  const stats = new SyncStats();
  const writer = new MirrorWriter(deps.gw, cfg, props, stats, log);

  const directions: Direction[] = [
    { source: cfg.subCalendarId, target: cfg.mainCalendarId },
    { source: cfg.mainCalendarId, target: cfg.subCalendarId },
  ];
  const chunks = buildChunks(syncWindow(clock.now(), cfg));
  const parentCache = new Map<string, CalEvent | null>();

  const resume = loadCursor(props);
  let cursor: Cursor = resume && resume.direction < directions.length ? resume : { direction: 0, chunk: 0 };
  if (resume) log.info(`カーソルから再開: direction=${cursor.direction} chunk=${cursor.chunk}`);

  for (let d = cursor.direction; d < directions.length; d++) {
    const ctx: DirectionContext = { dir: directions[d], cfg, writer, stats, parentCache };
    for (let c = d === cursor.direction ? cursor.chunk : 0; c < chunks.length; c++) {
      processChunk(deps, ctx, chunks[c]);
      const next: Cursor = c + 1 < chunks.length ? { direction: d, chunk: c + 1 } : { direction: d + 1, chunk: 0 };
      if (clock.now().getTime() - startedAt > budget && next.direction < directions.length) {
        saveCursor(props, next);
        log.info(stats.summary(clock.now().getTime() - startedAt, `${next.direction}/${next.chunk}`));
        return { stats, completed: false, cursor: next };
      }
      cursor = next;
    }
  }

  clearCursor(props);
  log.info(stats.summary(clock.now().getTime() - startedAt, 'done'));
  return { stats, completed: true, cursor: null };
}

export function processChunk(deps: SyncDeps, ctx: DirectionContext, chunk: TimeRange): void {
  const { gw, cfg, log } = deps;
  const { dir, stats } = ctx;

  const source = readSourceChunk(gw, dir.source, chunk, cfg.mirrorTitleSuffix, log);
  const target = readTargetChunk(gw, dir, chunk, cfg);
  const handled = new Set<string>();

  for (const ev of source.singles) {
    if (!ev.id) continue;
    handled.add(ev.id);
    try {
      reconcileSingle(ctx, ev, target);
    } catch (e) {
      stats.fail(`single ${describe(ev)}`, e);
    }
  }

  for (const [parentId, instances] of source.byParent) {
    handled.add(parentId);
    try {
      reconcileRecurring(deps, ctx, parentId, instances, target, chunk);
    } catch (e) {
      stats.fail(`recurring ${parentId}`, e);
    }
  }

  // Pass 4 孤児掃除。このチャンクのミラーのうち、ソース側で見なかったものだけ問い合わせる
  for (const [srcId, ref] of target.mirrors) {
    if (handled.has(srcId)) continue;
    try {
      sweepOrphan(deps, ctx, srcId, ref, target, chunk);
    } catch (e) {
      stats.fail(`sweep ${describe(ref.sample)}`, e);
    }
  }
}

interface TargetChunkView {
  /** ソース ID → ミラー参照。 */
  mirrors: Map<string, MirrorRef>;
  duplicates: DuplicateIndex;
}

function readTargetChunk(gw: CalendarGateway, dir: Direction, chunk: TimeRange, cfg: Config): TargetChunkView {
  const items = gw.listEvents(dir.target, {
    timeMin: chunk.start.toISOString(),
    timeMax: chunk.end.toISOString(),
    singleEvents: true,
    showDeleted: false,
  });
  const mirrors = new Map<string, MirrorRef>();
  const real: CalEvent[] = [];
  for (const ev of items) {
    const marker = readMarker(ev);
    if (marker) {
      // この方向のソースから来たミラーだけ扱う。旧マーカーは purge の担当
      if (marker.srcCal !== dir.source || !marker.srcId) continue;
      const mirrorId = ev.recurringEventId ?? ev.id;
      if (!mirrorId) continue;
      if (!mirrors.has(marker.srcId)) mirrors.set(marker.srcId, { mirrorId, marker, sample: ev });
      continue;
    }
    if (isLegacyMirrorTitle(ev.summary) || (ev.summary ?? '').endsWith(cfg.mirrorTitleSuffix)) continue;
    real.push(ev);
  }
  return { mirrors, duplicates: new DuplicateIndex(real) };
}

function reconcileSingle(ctx: DirectionContext, ev: CalEvent, target: TargetChunkView): void {
  const { dir, writer, stats } = ctx;
  const ref = target.mirrors.get(ev.id!);
  const reason = exclusionReason(ev, dir.source, ctx.cfg);

  if (reason) {
    if (ref) writer.delete(dir.target, ref.sample, reason);
    if (reason !== 'cancelled') stats.skip(reason);
    return;
  }
  if (target.duplicates.has(ev)) {
    if (ref) writer.delete(dir.target, ref.sample, 'duplicate');
    stats.skip('duplicate');
    return;
  }
  const existing = ref?.sample ?? writer.findMirror(dir.target, dir.source, ev.id!);
  writer.upsert(dir.target, dir.source, ev, existing, 'single');
}

function reconcileRecurring(
  deps: SyncDeps,
  ctx: DirectionContext,
  parentId: string,
  sourceInstances: CalEvent[],
  target: TargetChunkView,
  chunk: TimeRange,
): void {
  const { gw, cfg } = deps;
  const { dir, writer, stats, parentCache } = ctx;

  const cacheKey = `${dir.source}|${parentId}`;
  let parent = parentCache.get(cacheKey);
  if (parent === undefined) {
    parent = gw.getEvent(dir.source, parentId);
    parentCache.set(cacheKey, parent);
  }

  const ref = target.mirrors.get(parentId);
  const existingParent = ref ? gw.getEvent(dir.target, ref.mirrorId) : writer.findMirror(dir.target, dir.source, parentId);

  if (!parent) {
    if (existingParent) writer.delete(dir.target, existingParent, 'source parent missing');
    return;
  }
  const reason = exclusionReason(parent, dir.source, cfg);
  if (reason) {
    if (existingParent) writer.delete(dir.target, existingParent, reason);
    if (reason !== 'cancelled') stats.skip(reason);
    return;
  }
  if (target.duplicates.has(parent)) {
    if (existingParent) writer.delete(dir.target, existingParent, 'duplicate');
    stats.skip('duplicate');
    return;
  }

  const mirrorParent = writer.upsert(dir.target, dir.source, parent, existingParent, 'recurringParent');
  if (!mirrorParent?.id) return; // dry-run で新規作成した場合はインスタンス突合をスキップ

  const marker = readMarker(mirrorParent) ?? {
    tag: cfg.syncTag,
    srcCal: dir.source,
    srcId: parentId,
    srcUid: parent.iCalUID ?? '',
    srcUpdated: parent.updated ?? '',
    kind: 'recurringParent' as const,
  };
  const nativeStatusType = isStatusEventType(mirrorParent.eventType);
  const mirrorInstances = gw.listInstances(dir.target, mirrorParent.id, chunk);
  const plan = planInstanceReconciliation(
    sourceInstances,
    mirrorInstances,
    (src) =>
      buildMirrorBody(src, marker, cfg, { nativeStatusType, includeEventType: false, includeRecurrence: false }),
    (src) => exclusionReason(src, dir.source, cfg) !== null && src.status !== 'cancelled',
  );
  for (const m of plan.remove) {
    try {
      writer.delete(dir.target, m, 'instance cancelled');
    } catch (e) {
      stats.fail(`instance remove ${describe(m)}`, e);
    }
  }
  for (const { mirrorInstance, body } of plan.patch) {
    try {
      writer.patchInstance(dir.target, mirrorInstance, body);
    } catch (e) {
      stats.fail(`instance patch ${describe(mirrorInstance)}`, e);
    }
  }
  if (plan.unmatched > 0) {
    deps.log.warn(`${describe(parent)} のインスタンス ${plan.unmatched} 件がミラー側に見つからない（RRULE の転記ずれの可能性）`);
  }
}

/** ソース側で見なかったミラー。消えた／動いた／除外対象になったのいずれか。 */
function sweepOrphan(
  deps: SyncDeps,
  ctx: DirectionContext,
  srcId: string,
  ref: MirrorRef,
  target: TargetChunkView,
  chunk: TimeRange,
): void {
  const { gw, cfg } = deps;
  const { dir, writer } = ctx;
  const src = gw.getEvent(dir.source, srcId);
  const mirror = ref.marker.kind === 'recurringParent' ? gw.getEvent(dir.target, ref.mirrorId) : ref.sample;
  if (!mirror) return;

  if (!src) {
    writer.delete(dir.target, mirror, 'source deleted');
    return;
  }
  const reason = exclusionReason(src, dir.source, cfg);
  if (reason) {
    writer.delete(dir.target, mirror, reason);
    return;
  }
  if (target.duplicates.has(src)) {
    writer.delete(dir.target, mirror, 'duplicate');
    return;
  }
  // ソースは生きているのにこのチャンクに現れなかった＝時間が動いた。追随する
  if (src.recurrence && src.recurrence.length > 0) {
    ctx.parentCache.set(`${dir.source}|${srcId}`, src);
    reconcileRecurring(deps, ctx, srcId, [], target, chunk);
  } else {
    writer.upsert(dir.target, dir.source, src, mirror, 'single');
  }
}

