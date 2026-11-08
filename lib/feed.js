import crypto from 'node:crypto';
import { dayNumber, fromDayNumber } from './events.js';

/*
 * The family calendar as an iCalendar feed, for phones to subscribe to.
 *
 * Everything stays in this house: nothing is pushed to Apple or anybody else.
 * An iPhone given the link asks for it every so often and shows what it gets
 * as a calendar of its own, next to the person's other calendars -- read only,
 * which is the point: there is one place things are added, and it is here.
 *
 * The link is the key. Calendar apps cannot sign in to anything, so the feed
 * cannot sit behind the family password; instead its address carries a long
 * random token, and making a new link is how an old one is shut off.
 */

/** A new token: 32 characters, 192 bits, safe in a URL path. */
export const newFeedToken = () => crypto.randomBytes(24).toString('base64url');

/** Whether `given` is the stored token, in time that does not depend on how much of it matched. */
export function tokenMatches(stored, given) {
    if (!stored || !given) return false;
    const a = crypto.createHash('sha256').update(String(stored)).digest();
    const b = crypto.createHash('sha256').update(String(given)).digest();
    return crypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------------- the format --

/* Commas, semicolons and backslashes mean something in iCalendar text. */
const text = (s) =>
    String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');

/*
 * Lines longer than 75 bytes are folded onto the next with a leading space.
 *
 * Bytes, not characters, and never through the middle of one: an emoji or an
 * accented name split across the fold arrives as two broken halves.
 */
function fold(line) {
    const out = [];
    let current = '';
    let bytes = 0;
    for (const ch of line) {
        const size = Buffer.byteLength(ch);
        const limit = out.length ? 74 : 75; // continuation lines start with a space
        if (bytes + size > limit) {
            out.push(current);
            current = '';
            bytes = 0;
        }
        current += ch;
        bytes += size;
    }
    out.push(current);
    return out.join('\r\n ');
}

const day = (iso) => iso.replace(/-/g, '');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/*
 * Times are "floating": 10:00 means ten o'clock wherever the phone is.
 *
 * The hub keeps no time zone -- the family's day is the family's day -- and a
 * zone made up here would move every event the moment it was wrong.
 */
const dateTime = (iso, hhmm) => `${day(iso)}T${hhmm.replace(':', '')}00`;

/** A time plus minutes, rolling into the next day if it has to. */
function later(iso, hhmm, minutes) {
    const [h, m] = hhmm.split(':').map(Number);
    const total = h * 60 + m + minutes;
    const date = fromDayNumber(dayNumber(iso) + Math.floor(total / 1440));
    const t = total % 1440;
    return dateTime(date, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
}

/** Minutes before the start as an iCalendar trigger: 15 is -PT15M, -540 is PT9H. */
function trigger(minutes) {
    const sign = minutes > 0 ? '-' : '';
    let m = Math.abs(minutes);
    const d = Math.floor(m / 1440);
    m %= 1440;
    const h = Math.floor(m / 60);
    m %= 60;
    const time = h || m || !d ? `T${h ? `${h}H` : ''}${m || (!h && !d) ? `${m}M` : ''}` : '';
    return `${sign}P${d ? `${d}D` : ''}${time}`;
}

const names = (ids, members) => (ids ?? []).map((id) => members.find((m) => m.id === id)?.name).filter(Boolean);

/* Whose it is, after the name: every event on the phone is one colour, so the
   colour no longer says whose the dentist appointment is. */
const withWho = (title, who) => (who.length ? `${title} (${who.join(', ')})` : title);

/** The UID an event goes out under: the iPhone's own, for one added there. */
export const eventUid = (event) => event.uid ?? `${event.id}@family-hub`;

/*
 * `account` is for the two-way calendar account rather than the link. There
 * the description is the notes and nothing else, because whatever goes out
 * comes back when the phone saves the event, and "For Emma" would come back
 * as part of the notes, once more every time.
 */
function eventLines(event, members, now, { account = false } = {}) {
    const who = names(event.members, members);
    const lines = ['BEGIN:VEVENT', `UID:${eventUid(event)}`, `DTSTAMP:${stamp(now)}`];
    if (event.updatedAt) lines.push(`LAST-MODIFIED:${stamp(new Date(event.updatedAt))}`);
    lines.push(`SUMMARY:${text(withWho(event.title, who))}`);

    if (event.allDay) {
        const last = event.endDate || event.date;
        lines.push(`DTSTART;VALUE=DATE:${day(event.date)}`);
        // The end of an all-day event is the day after its last, by the standard.
        lines.push(`DTEND;VALUE=DATE:${day(fromDayNumber(dayNumber(last) + 1))}`);
    } else {
        lines.push(`DTSTART:${dateTime(event.date, event.start)}`);
        // An event with no end shows as an hour, which is what a phone would
        // assume anyway, but said rather than left to each app to guess.
        lines.push(`DTEND:${event.end ? dateTime(event.date, event.end) : later(event.date, event.start, 60)}`);
    }

    if (event.repeat && event.repeat !== 'none') {
        // Monthly on the 31st and yearly on 29 February skip the months and
        // years that do not have that day -- as the hub does, and as the
        // standard says a rule must.
        const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[event.repeat];
        let rule = `RRULE:FREQ=${freq}`;
        if (event.every > 1) rule += `;INTERVAL=${event.every}`;
        if (event.repeat === 'monthly') rule += `;BYMONTHDAY=${Number(event.date.slice(8))}`;
        if (event.until) rule += `;UNTIL=${event.allDay ? day(event.until) : `${day(event.until)}T235959`}`;
        lines.push(rule);
        if (event.skip?.length) {
            lines.push(
                event.allDay
                    ? `EXDATE;VALUE=DATE:${event.skip.map(day).join(',')}`
                    : `EXDATE:${event.skip.map((d) => dateTime(d, event.start)).join(',')}`,
            );
        }
    }

    if (event.location) lines.push(`LOCATION:${text(event.location)}`);
    const description = account
        ? event.notes
        : [who.length ? `For ${who.join(', ')}` : '', event.notes].filter(Boolean).join('\n\n');
    if (description) lines.push(`DESCRIPTION:${text(description)}`);
    if (account) lines.push(...(event.extra ?? []));
    if (Number.isInteger(event.alert)) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(event.title)}`, `TRIGGER:${trigger(event.alert)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
    return lines;
}

function allDayLines(uid, iso, summary, now) {
    return [
        'BEGIN:VEVENT',
        `UID:${uid}@family-hub`,
        `DTSTAMP:${stamp(now)}`,
        `SUMMARY:${text(summary)}`,
        `DTSTART;VALUE=DATE:${day(iso)}`,
        `DTEND;VALUE=DATE:${day(fromDayNumber(dayNumber(iso) + 1))}`,
        'TRANSP:TRANSPARENT', // shows the day as free: a dinner is not a meeting
        'END:VEVENT',
    ];
}

/**
 * The whole calendar as text.
 *
 * Dinners cover a window around today rather than everything ever planned:
 * a phone has no use for last spring's Tuesday pasta. Chores go in only when
 * they are one-offs with a day and not done yet -- a daily "feed the dog"
 * would bury everything else on the phone under 365 copies of itself.
 */
const HEADER = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Hub//Home Server//EN',
    'CALSCALE:GREGORIAN',
];
const finish = (lines) => `${[...lines, 'END:VCALENDAR'].map(fold).join('\r\n')}\r\n`;

/**
 * One event as a calendar file of its own, the way the two-way account hands
 * them out.
 *
 * Stamped with when it last changed rather than now, so the same event is the
 * same text every time it is asked for -- its ETag is a hash of this, and a
 * phone that saw a new ETag on every sync would fetch everything every time.
 */
export function eventFile(event, members) {
    const changed = new Date(event.updatedAt ?? event.createdAt ?? 0);
    return finish([...HEADER, ...eventLines(event, members, changed, { account: true })]);
}

export const taskUid = (task) => task.uid ?? `${task.id}@family-hub`;

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * One reminder as a calendar file, for the Reminders app.
 *
 * A timed one carries an alarm at its time, which is what makes the phone
 * remind anybody of it; one with only a day is left to the phone, which
 * reminds of those at the hour it is set to in its own settings.
 */
export function taskFile(task) {
    const changed = new Date(task.updatedAt ?? task.createdAt ?? 0);
    const lines = ['BEGIN:VTODO', `UID:${taskUid(task)}`, `DTSTAMP:${stamp(changed)}`];
    if (task.createdAt) lines.push(`CREATED:${stamp(new Date(task.createdAt))}`);
    lines.push(`LAST-MODIFIED:${stamp(changed)}`, `SUMMARY:${text(task.title)}`);
    if (task.notes) lines.push(`DESCRIPTION:${text(task.notes)}`);
    if (task.date) {
        const when = task.time ? `:${dateTime(task.date, task.time)}` : `;VALUE=DATE:${day(task.date)}`;
        lines.push(`DTSTART${when}`, `DUE${when}`);
    }
    if (task.repeat !== 'none' && task.date) {
        const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[task.repeat];
        let rule = `RRULE:FREQ=${freq}`;
        if (task.every > 1) rule += `;INTERVAL=${task.every}`;
        if (task.repeat === 'weekly') rule += `;BYDAY=${task.days.map((d) => WEEKDAY_CODES[d]).join(',')}`;
        if (task.until) rule += `;UNTIL=${task.time ? `${day(task.until)}T235959` : day(task.until)}`;
        lines.push(rule);
    }
    const done = task.repeat === 'none' ? task.done.length > 0 : Boolean(task.over);
    if (done) {
        const at = task.completedAt ? new Date(task.completedAt) : new Date(`${task.done.at(-1) ?? task.date}T12:00:00Z`);
        lines.push('STATUS:COMPLETED', `COMPLETED:${stamp(at)}`, 'PERCENT-COMPLETE:100');
    } else {
        lines.push('STATUS:NEEDS-ACTION');
    }
    lines.push(...(task.extra ?? []));
    if (task.time && !done) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(task.title)}`, 'TRIGGER:PT0S', 'END:VALARM');
    }
    lines.push('END:VTODO');
    return finish([...HEADER, ...lines]);
}

export function buildCalendar({ events = [], members = [], plan = {}, meals = [], tasks = [], include = {}, today, now = new Date() }) {
    const lines = [
        ...HEADER,
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Family Hub',
        // A hint; iOS checks on its own schedule regardless.
        'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
        'X-PUBLISHED-TTL:PT30M',
    ];

    for (const event of events) lines.push(...eventLines(event, members, now));

    if (include.dinners) {
        const from = dayNumber(today) - 60;
        const to = dayNumber(today) + 90;
        for (const [iso, slots] of Object.entries(plan)) {
            const n = dayNumber(iso);
            if (n < from || n > to) continue;
            const meal = meals.find((m) => m.id === slots?.dinner);
            if (meal) lines.push(...allDayLines(`dinner-${iso}`, iso, `Dinner: ${meal.name}`, now));
        }
    }

    if (include.chores) {
        for (const task of tasks) {
            if (task.repeat !== 'none' || !task.date || task.done?.length) continue;
            const who = names(task.member ? [task.member] : [], members);
            lines.push(...allDayLines(`task-${task.id}`, task.date, withWho(`☐ ${task.title}`, who), now));
        }
    }

    return finish(lines);
}
