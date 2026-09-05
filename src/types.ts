// Calendar API v3 のイベント型。@types/google-apps-script の Schema.Event には
// eventType の一部値や status event の付随プロパティが無いので、ここで補う。

export type EventDateTime = GoogleAppsScript.Calendar.Schema.EventDateTime;
export type EventAttendee = GoogleAppsScript.Calendar.Schema.EventAttendee;

export type EventType =
  | 'default'
  | 'outOfOffice'
  | 'focusTime'
  | 'workingLocation'
  | 'birthday'
  | 'fromGmail';

export interface CalEvent extends Omit<GoogleAppsScript.Calendar.Schema.Event, 'eventType'> {
  eventType?: EventType;
  focusTimeProperties?: Record<string, unknown>;
  outOfOfficeProperties?: Record<string, unknown>;
}

export interface ListParams {
  timeMin?: string;
  timeMax?: string;
  singleEvents?: boolean;
  showDeleted?: boolean;
  privateExtendedProperty?: string[];
  eventTypes?: string[];
}

export interface TimeRange {
  start: Date;
  end: Date;
}

/** Calendar API への唯一の窓口。テストではインメモリ実装に差し替える。 */
export interface CalendarGateway {
  /** ページングを吸収して全件返す。 */
  listEvents(calendarId: string, params: ListParams): CalEvent[];
  /** 存在しない（404）なら null。 */
  getEvent(calendarId: string, eventId: string): CalEvent | null;
  listInstances(calendarId: string, eventId: string, range: TimeRange): CalEvent[];
  insertEvent(calendarId: string, body: CalEvent): CalEvent;
  patchEvent(calendarId: string, eventId: string, body: CalEvent): CalEvent;
  /** すでに消えていても例外にしない。 */
  deleteEvent(calendarId: string, eventId: string): void;
}

export interface PropertyStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}
