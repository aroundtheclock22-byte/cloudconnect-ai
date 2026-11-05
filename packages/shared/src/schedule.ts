/**
 * Business hours / holiday evaluation with IANA time zones, without external deps.
 */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface TimeRange { start: string; end: string } // "09:00" - "17:30", end exclusive; end<start => overnight
export interface Holiday { date: string; name: string; /** optional partial-day closure */ ranges?: TimeRange[] } // date "YYYY-MM-DD" or "*-12-25" recurring
export interface BusinessSchedule {
  timezone: string; // IANA, e.g. "America/New_York"
  hours: Partial<Record<Weekday, TimeRange[]>>;
  holidays?: Holiday[];
}
export type ScheduleState = 'open' | 'closed' | 'holiday';

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface LocalTime { date: string; weekday: Weekday; minutes: number }

export function toLocalTime(at: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekday = get('weekday').toLowerCase().slice(0, 3) as Weekday;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function inRange(minutes: number, r: TimeRange): boolean {
  const s = toMinutes(r.start), e = toMinutes(r.end);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

function previousWeekday(d: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(d) + 6) % 7];
}

function holidayMatches(h: Holiday, date: string): boolean {
  return h.date.startsWith('*-') ? date.slice(4) === h.date.slice(1) : h.date === date;
}

export function evaluateSchedule(schedule: BusinessSchedule, at: Date = new Date()): ScheduleState {
  const lt = toLocalTime(at, schedule.timezone);
  const holiday = schedule.holidays?.find((h) => holidayMatches(h, lt.date));
  if (holiday) {
    // Holiday with explicit ranges = open only inside those ranges
    if (!holiday.ranges || !holiday.ranges.some((r) => inRange(lt.minutes, r))) return 'holiday';
    return 'open';
  }
  const today = schedule.hours[lt.weekday] ?? [];
  // overnight ranges: only the part before midnight counts for today
  if (today.some((r) => {
    const s = toMinutes(r.start), e = toMinutes(r.end);
    return s <= e ? inRange(lt.minutes, r) : lt.minutes >= s;
  })) return 'open';
  // tail of yesterday's overnight range
  const yesterday = schedule.hours[previousWeekday(lt.weekday)] ?? [];
  if (yesterday.some((r) => toMinutes(r.start) > toMinutes(r.end) && lt.minutes < toMinutes(r.end))) return 'open';
  return 'closed';
}
