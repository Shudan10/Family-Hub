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

function eventLines(event, members, now) {
    const who = names(event.members, members);
    const lines = ['BEGIN:VEVENT', `UID:${event.id}@family-hub`, `DTSTAMP:${stamp(now)}`];
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
        const freq = { weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[event.repeat];
        let rule = `RRULE:FREQ=${freq}`;
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
    const description = [who.length ? `For ${who.join(', ')}` : '', event.notes].filter(Boolean).join('\n\n');
    if (description) lines.push(`DESCRIPTION:${text(description)}`);
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
export function buildCalendar({ events = [], members = [], plan = {}, meals = [], tasks = [], include = {}, today, now = new Date() }) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Family Hub//Home Server//EN',
        'CALSCALE:GREGORIAN',
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

    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}
