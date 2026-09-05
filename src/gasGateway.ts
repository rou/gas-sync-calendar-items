import type { CalEvent, CalendarGateway, Clock, ListParams, Logger, PropertyStore, TimeRange } from './types';
import { isGoneError, isNotFoundError, isRetryableError, withRetry } from './retry';

declare const Calendar: GoogleAppsScript.Calendar;

const sleep = (ms: number): void => Utilities.sleep(ms);

/** Advanced Calendar Service の薄いラッパー。リトライとページングをここで吸収する。 */
export class GasCalendarGateway implements CalendarGateway {
  listEvents(calendarId: string, params: ListParams): CalEvent[] {
    const out: CalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const args: Record<string, unknown> = { ...params, maxResults: 2500 };
      if (pageToken) args.pageToken = pageToken;
      const page = withRetry(
        () => Calendar.Events!.list(calendarId, args) as GoogleAppsScript.Calendar.Schema.Events,
        { sleep },
      );
      out.push(...((page.items ?? []) as CalEvent[]));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  getEvent(calendarId: string, eventId: string): CalEvent | null {
    try {
      return withRetry(() => Calendar.Events!.get(calendarId, eventId) as CalEvent, { sleep });
    } catch (e) {
      if (isNotFoundError(e) || isGoneError(e)) return null;
      throw e;
    }
  }

  listInstances(calendarId: string, eventId: string, range: TimeRange): CalEvent[] {
    const out: CalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const args: Record<string, unknown> = {
        timeMin: range.start.toISOString(),
        timeMax: range.end.toISOString(),
        showDeleted: true,
        maxResults: 2500,
      };
      if (pageToken) args.pageToken = pageToken;
      const page = withRetry(
        () => Calendar.Events!.instances(calendarId, eventId, args) as GoogleAppsScript.Calendar.Schema.Events,
        { sleep },
      );
      out.push(...((page.items ?? []) as CalEvent[]));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  insertEvent(calendarId: string, body: CalEvent): CalEvent {
    try {
      return withRetry(
        () => Calendar.Events!.insert(body as GoogleAppsScript.Calendar.Schema.Event, calendarId) as CalEvent,
        { sleep },
      );
    } catch (e) {
      if (isRetryableError(e)) throw e;
      // Advanced Service は詳細エラーを捨てるので、REST を直接叩いて本文を取る
      return restCall('post', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
    }
  }

  patchEvent(calendarId: string, eventId: string, body: CalEvent): CalEvent {
    try {
      return withRetry(
        () =>
          Calendar.Events!.patch(body as GoogleAppsScript.Calendar.Schema.Event, calendarId, eventId) as CalEvent,
        { sleep },
      );
    } catch (e) {
      if (isRetryableError(e)) throw e;
      return restCall(
        'patch',
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        body,
      );
    }
  }

  deleteEvent(calendarId: string, eventId: string): void {
    try {
      withRetry(() => Calendar.Events!.remove(calendarId, eventId), { sleep });
    } catch (e) {
      if (isNotFoundError(e) || isGoneError(e)) return;
      throw e;
    }
  }
}

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/**
 * Calendar REST API を直接呼ぶ。失敗時の詳細（reason / message / location）を
 * エラーメッセージに含める。Advanced Service が "Bad Request" しか返さないときの調査用。
 */
function restCall(method: 'post' | 'patch', path: string, payload: CalEvent): CalEvent {
  const res = UrlFetchApp.fetch(`${CALENDAR_API}${path}`, {
    method,
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 200 && code < 300) return JSON.parse(text) as CalEvent;
  throw new Error(`${method.toUpperCase()} ${path} → HTTP ${code}: ${summarizeApiError(text)} / sent=${JSON.stringify(payload)}`);
}

function summarizeApiError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; errors?: Array<{ reason?: string; message?: string; location?: string }> };
    };
    const err = parsed.error;
    if (!err) return text.slice(0, 500);
    const details = (err.errors ?? [])
      .map((d) => [d.reason, d.location, d.message].filter(Boolean).join(' '))
      .join('; ');
    return details ? `${err.message ?? ''} [${details}]` : err.message ?? text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

export class GasPropertyStore implements PropertyStore {
  private readonly props = PropertiesService.getScriptProperties();
  get(key: string): string | null {
    return this.props.getProperty(key);
  }
  set(key: string, value: string): void {
    this.props.setProperty(key, value);
  }
  delete(key: string): void {
    this.props.deleteProperty(key);
  }
}

export class GasClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class GasLogger implements Logger {
  info(message: string): void {
    console.log(message);
  }
  warn(message: string): void {
    console.warn(message);
  }
}
