import type { CalEvent, CalendarGateway, ListParams, TimeRange } from '../src/types';

/**
 * インメモリの Calendar API。同期エンジンを GAS なしで丸ごと動かすための偽物。
 * 繰り返しは RRULE:FREQ=DAILY|WEEKLY;COUNT=n だけ展開できる。
 */
export class FakeGateway implements CalendarGateway {
  readonly calendars = new Map<string, Map<string, CalEvent>>();
  readonly instances = new Map<string, CalEvent[]>(); // `${cal}|${parentId}` → instances
  readonly calls = { list: 0, get: 0, instances: 0, insert: 0, patch: 0, delete: 0 };
  readonly insertedBodies: Array<{ calendarId: string; body: CalEvent }> = [];
  insertShouldFail: ((calendarId: string, body: CalEvent) => Error | null) | null = null;
  private seq = 0;
  private clock = Date.parse('2026-09-04T00:00:00Z');

  seed(calendarId: string, event: CalEvent): CalEvent {
    return this.store(calendarId, { status: 'confirmed', ...event }, false);
  }

  bumpClock(ms = 60_000): void {
    this.clock += ms;
  }

  all(calendarId: string): CalEvent[] {
    return [...this.cal(calendarId).values()];
  }

  live(calendarId: string): CalEvent[] {
    return this.all(calendarId).filter((e) => e.status !== 'cancelled');
  }

  instancesOf(calendarId: string, parentId: string): CalEvent[] {
    return this.instances.get(`${calendarId}|${parentId}`) ?? [];
  }

  listEvents(calendarId: string, params: ListParams): CalEvent[] {
    this.calls.list += 1;
    const out: CalEvent[] = [];
    for (const ev of this.cal(calendarId).values()) {
      if (ev.recurrence && params.singleEvents) {
        out.push(...this.instancesOf(calendarId, ev.id!));
      } else {
        out.push(ev);
      }
    }
    return out.filter((ev) => this.matches(ev, params));
  }

  getEvent(calendarId: string, eventId: string): CalEvent | null {
    this.calls.get += 1;
    const ev = this.cal(calendarId).get(eventId);
    if (ev) return clone(ev);
    for (const list of this.instances.values()) {
      const inst = list.find((i) => i.id === eventId);
      if (inst && inst.recurringEventId && this.cal(calendarId).has(inst.recurringEventId)) return clone(inst);
    }
    return null;
  }

  listInstances(calendarId: string, eventId: string, range: TimeRange): CalEvent[] {
    this.calls.instances += 1;
    return this.instancesOf(calendarId, eventId)
      .filter((i) => overlaps(i, range.start.toISOString(), range.end.toISOString()))
      .map(clone);
  }

  insertEvent(calendarId: string, body: CalEvent): CalEvent {
    this.calls.insert += 1;
    this.insertedBodies.push({ calendarId, body: clone(body) });
    const err = this.insertShouldFail?.(calendarId, body);
    if (err) throw err;
    return this.store(calendarId, body, true);
  }

  patchEvent(calendarId: string, eventId: string, body: CalEvent): CalEvent {
    this.calls.patch += 1;
    const cal = this.cal(calendarId);
    const target = cal.get(eventId);
    if (target) {
      Object.assign(target, clone(body), { updated: this.tick() });
      if (target.recurrence) this.refreshInstances(calendarId, target);
      return clone(target);
    }
    for (const list of this.instances.values()) {
      const inst = list.find((i) => i.id === eventId);
      if (inst) {
        Object.assign(inst, clone(body), { updated: this.tick() });
        (inst as CalEvent & { _exception?: boolean })._exception = true;
        return clone(inst);
      }
    }
    throw new Error(`Not Found: ${eventId}`);
  }

  deleteEvent(calendarId: string, eventId: string): void {
    this.calls.delete += 1;
    const cal = this.cal(calendarId);
    const target = cal.get(eventId);
    if (target) {
      target.status = 'cancelled';
      for (const inst of this.instancesOf(calendarId, eventId)) inst.status = 'cancelled';
      return;
    }
    for (const list of this.instances.values()) {
      const inst = list.find((i) => i.id === eventId);
      if (inst) {
        inst.status = 'cancelled';
        return;
      }
    }
    throw new Error(`Not Found: ${eventId}`);
  }

  /** テストからソース側のインスタンスを書き換える（例外を作る／取り消す）。 */
  modifyInstance(calendarId: string, parentId: string, index: number, patch: Partial<CalEvent>): CalEvent {
    const inst = this.instancesOf(calendarId, parentId)[index];
    Object.assign(inst, patch, { updated: this.tick() });
    (inst as CalEvent & { _exception?: boolean })._exception = true;
    return inst;
  }

  private store(calendarId: string, body: CalEvent, generateId: boolean): CalEvent {
    const cal = this.cal(calendarId);
    this.seq += 1;
    const id = generateId || !body.id ? `${calendarId.split('@')[0]}-ev${this.seq}` : body.id;
    const ev: CalEvent = {
      ...clone(body),
      id,
      iCalUID: body.iCalUID ?? `${id}@fake`,
      status: body.status ?? 'confirmed',
      updated: body.updated ?? this.tick(),
    };
    cal.set(id, ev);
    if (ev.recurrence) this.refreshInstances(calendarId, ev);
    return clone(ev);
  }

  private refreshInstances(calendarId: string, parent: CalEvent): void {
    const key = `${calendarId}|${parent.id}`;
    const existing = this.instances.get(key) ?? [];
    const rule = parent.recurrence?.[0] ?? '';
    const freq = /FREQ=(DAILY|WEEKLY)/.exec(rule)?.[1] ?? 'DAILY';
    const count = Number(/COUNT=(\d+)/.exec(rule)?.[1] ?? '3');
    const step = (freq === 'WEEKLY' ? 7 : 1) * 86400e3;
    const startMs = Date.parse(parent.start!.dateTime!);
    const duration = Date.parse(parent.end!.dateTime!) - startMs;
    const list: CalEvent[] = [];
    for (let i = 0; i < count; i++) {
      const s = new Date(startMs + i * step).toISOString();
      const e = new Date(startMs + i * step + duration).toISOString();
      const prev = existing[i] as (CalEvent & { _exception?: boolean }) | undefined;
      if (prev?._exception) {
        list.push(prev);
        continue;
      }
      const inherited = clone(parent);
      delete inherited.recurrence;
      list.push({
        ...inherited,
        id: `${parent.id}_${s.replace(/[-:.]/g, '').slice(0, 15)}Z`,
        recurringEventId: parent.id,
        originalStartTime: { dateTime: s },
        start: { dateTime: s },
        end: { dateTime: e },
        status: prev?.status ?? parent.status ?? 'confirmed',
      });
    }
    this.instances.set(key, list);
  }

  private matches(ev: CalEvent, p: ListParams): boolean {
    if (!p.showDeleted && ev.status === 'cancelled') return false;
    if (p.eventTypes && !p.eventTypes.includes(ev.eventType ?? 'default')) return false;
    if (p.privateExtendedProperty) {
      const priv = ev.extendedProperties?.private ?? {};
      for (const kv of p.privateExtendedProperty) {
        const [k, v] = kv.split('=');
        if (priv[k] !== v) return false;
      }
    }
    if ((p.timeMin || p.timeMax) && ev.status !== 'cancelled') {
      if (!overlaps(ev, p.timeMin, p.timeMax)) return false;
    }
    return true;
  }

  private cal(calendarId: string): Map<string, CalEvent> {
    let cal = this.calendars.get(calendarId);
    if (!cal) {
      cal = new Map();
      this.calendars.set(calendarId, cal);
    }
    return cal;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

function overlaps(ev: CalEvent, timeMin?: string, timeMax?: string): boolean {
  const s = toMs(ev.start);
  const e = toMs(ev.end);
  if (s === null || e === null) return true;
  if (timeMax && s >= Date.parse(timeMax)) return false;
  if (timeMin && e <= Date.parse(timeMin)) return false;
  return true;
}

function toMs(dt: CalEvent['start']): number | null {
  if (!dt) return null;
  if (dt.dateTime) return Date.parse(dt.dateTime);
  if (dt.date) return Date.parse(`${dt.date}T00:00:00Z`);
  return null;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
