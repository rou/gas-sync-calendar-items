import type { Clock, Logger, PropertyStore } from './types';
import { PROPERTY_KEYS, type Config } from './config';

export class SyncStats {
  created = 0;
  updated = 0;
  deleted = 0;
  skipped = 0;
  failed = 0;
  readonly failures: string[] = [];
  readonly skipReasons: Record<string, number> = {};

  skip(reason: string): void {
    this.skipped += 1;
    this.skipReasons[reason] = (this.skipReasons[reason] ?? 0) + 1;
  }

  fail(context: string, error: unknown): void {
    this.failed += 1;
    const msg = error instanceof Error ? error.message : String(error);
    this.failures.push(`${context}: ${msg}`);
    console.warn(`failed ${context}: ${msg}`);
  }

  summary(elapsedMs: number, cursorLabel: string): string {
    const sec = (elapsedMs / 1000).toFixed(1);
    const reasons = Object.entries(this.skipReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return (
      `sync done  created=${this.created} updated=${this.updated} deleted=${this.deleted} ` +
      `skipped=${this.skipped}${reasons ? ` (${reasons})` : ''} failed=${this.failed}  ${sec}s  cursor=${cursorLabel}`
    );
  }
}

export type MailSender = (to: string, subject: string, body: string) => void;

/** failed > 0 のときだけ通知する。連投を防ぐため 1 日 1 通。 */
export function notifyFailures(
  stats: SyncStats,
  cfg: Pick<Config, 'notifyEmail' | 'dryRun'>,
  props: PropertyStore,
  clock: Clock,
  sendMail: MailSender,
  log: Logger,
): void {
  if (stats.failed === 0 || cfg.dryRun) return;
  const today = clock.now().toISOString().slice(0, 10);
  if (props.get(PROPERTY_KEYS.lastNotifyDate) === today) {
    log.info(`通知は本日すでに送信済み（${stats.failed} 件の失敗はログ参照）`);
    return;
  }
  const body = [
    `カレンダー同期で ${stats.failed} 件の失敗がありました。`,
    '',
    ...stats.failures.slice(0, 50),
    stats.failures.length > 50 ? `... 他 ${stats.failures.length - 50} 件` : '',
  ].join('\n');
  sendMail(cfg.notifyEmail, '[calendar-sync] 同期に失敗した予定があります', body);
  props.set(PROPERTY_KEYS.lastNotifyDate, today);
}
