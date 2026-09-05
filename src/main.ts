import { loadConfig, PROPERTY_KEYS, PURGE_FUTURE_DAYS, type Config } from './config';
import { explainTitle } from './explain';
import { GasCalendarGateway, GasClock, GasLogger, GasPropertyStore } from './gasGateway';
import { notifyFailures } from './log';
import { purgeMirrors } from './migrate';
import { runSpikeS1, runSpikeS2, runSpikeS3, runSpikeS4 } from './spikes';
import { runSync } from './syncEngine';

/**
 * GAS に露出する関数。esbuild の footer がこれらをトップレベルの function 宣言として
 * 生成するので、GAS エディタの関数一覧とトリガーから選べる。
 */

const SYNC_FUNCTION_NAME = 'sync';
const TRIGGER_INTERVAL_MINUTES = 15;

function deps() {
  const props = new GasPropertyStore();
  const mainCalendarId = Session.getActiveUser().getEmail();
  const cfg = loadConfig(props, mainCalendarId);
  return { gw: new GasCalendarGateway(), props, clock: new GasClock(), log: new GasLogger(), cfg };
}

/** 時間主導トリガーから 15 分毎に呼ばれる本体。 */
export function sync(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('前回の実行が継続中のためスキップ');
    return;
  }
  try {
    const d = deps();
    if (d.cfg.dryRun) d.log.info('DRY_RUN=true: 書き込みは行わない');
    const result = runSync(d);
    notifyFailures(
      result.stats,
      d.cfg,
      d.props,
      d.clock,
      (to, subject, body) => MailApp.sendEmail(to, subject, body),
      d.log,
    );
  } finally {
    lock.releaseLock();
  }
}

/** 15 分毎の時間主導トリガーを 1 つ設置する（既存の同名トリガーは張り替える）。 */
export function installTrigger(): void {
  removeTrigger();
  ScriptApp.newTrigger(SYNC_FUNCTION_NAME).timeBased().everyMinutes(TRIGGER_INTERVAL_MINUTES).create();
  console.log(`${SYNC_FUNCTION_NAME} を ${TRIGGER_INTERVAL_MINUTES} 分毎に実行するトリガーを設置`);
}

export function removeTrigger(): void {
  let removed = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === SYNC_FUNCTION_NAME) {
      ScriptApp.deleteTrigger(t);
      removed += 1;
    }
  }
  console.log(`トリガーを ${removed} 件削除`);
}

/**
 * 現行スクリプトが作った旧ミラーを両カレンダーから削除する。対象は実行時点より先の予定だけ。
 * DRY_RUN=true で先に一覧を確認すること（spec §13）。
 */
export function purgeLegacyMirrors(): void {
  purge(false);
}

/** 旧ミラーに加えて、新方式のミラーもすべて削除する。同期を完全にやめるとき用。 */
export function purgeAllMirrors(): void {
  purge(true);
}

function purge(includeNewMirrors: boolean): void {
  const d = deps();
  const now = d.clock.now().getTime();
  const range = {
    start: new Date(now),
    end: new Date(now + PURGE_FUTURE_DAYS * 86400e3),
  };
  const deleted = purgeMirrors(
    d.gw,
    [d.cfg.mainCalendarId, d.cfg.subCalendarId],
    range,
    { includeNewMirrors, mirrorTitleSuffix: d.cfg.mirrorTitleSuffix, dryRun: d.cfg.dryRun },
    d.log,
  );
  d.log.info(`合計 ${deleted} 件${d.cfg.dryRun ? '（dry-run、実際には削除していない）' : ''}`);
}

/** 設定の読み込み結果を表示する。カレンダー ID の設定ミスの確認用。 */
export function showConfig(): void {
  const d = deps();
  const view: Record<keyof Config, unknown> = {
    ...d.cfg,
    excludeTitlePatterns: d.cfg.excludeTitlePatterns.map((re) => re.source),
  };
  console.log(JSON.stringify(view, null, 2));
}

/**
 * 特定の予定がコピーされない理由を調べる。
 * Script Properties の DEBUG_TITLE にタイトルの一部を入れてから実行する。
 */
export function explain(): void {
  const d = deps();
  const needle = d.props.get(PROPERTY_KEYS.debugTitle)?.trim();
  if (!needle) {
    d.log.warn(`Script Properties に ${PROPERTY_KEYS.debugTitle}（調べたい予定のタイトルの一部）を設定してください`);
    return;
  }
  explainTitle(d.gw, d.cfg, needle, d.clock.now(), d.log);
}

export function spikeS1(): void {
  const d = deps();
  runSpikeS1(d.gw, d.cfg, d.log);
}
export function spikeS2(): void {
  const d = deps();
  runSpikeS2(d.gw, d.cfg, d.log);
}
export function spikeS3(): void {
  const d = deps();
  runSpikeS3(d.gw, d.cfg, d.log);
}
export function spikeS4(): void {
  const d = deps();
  runSpikeS4(d.gw, d.cfg, d.log);
}
