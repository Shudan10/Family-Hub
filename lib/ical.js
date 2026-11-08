import { dayNumber, fromDayNumber } from './events.js';

/*
 * Reading iCalendar text, as an iPhone sends it when an event or a reminder is
 * saved in its Calendar or Reminders app. The writing side is in feed.js.
 *
 * Only as much of RFC 5545 as a phone actually sends for one event or one
 * reminder: properties and their parameters, nested components, dates and
 * times, durations and repeat rules.
 */

/* Undoes the escaping of TEXT values: \n, \, \; and \\. */
export const unescapeText = (s) => String(s ?? '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** One content line: its name, parameters and value, and the line itself. */
function parseLine(line) {
    let i = 0;
    while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
    const name = line.slice(0, i).toUpperCase();
    const params = {};
    while (line[i] === ';') {
        i++;
        const eq = line.indexOf('=', i);
        if (eq < 0) break;
        const key = line.slice(i, eq).toUpperCase();
        i = eq + 1;
        let value = '';
        // A parameter value can be quoted, and only then contain ; or :.
        while (i < line.length && line[i] !== ';' && line[i] !== ':') {
            if (line[i] === '"') {
                const close = line.indexOf('"', i + 1);
                if (close < 0) break;
                value += line.slice(i + 1, close);
                i = close + 1;
            } else {
                value += line[i++];
            }
        }
        params[key] = value;
    }
    return { name, params, value: line.slice(i + 1), raw: line };
}

/** The components in `text`, as { name, props, children } trees. */
export function parseCalendar(text) {
    const lines = String(text)
        .replace(/\r?\n[ \t]/g, '') // unfold
        .split(/\r?\n/)
        .filter((l) => l.trim());
    const root = { name: 'ROOT', props: [], children: [] };
    const stack = [root];
    for (const line of lines) {
        const prop = parseLine(line);
        const top = stack.at(-1);
        if (prop.name === 'BEGIN') {
            const comp = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
            top.children.push(comp);
            stack.push(comp);
        } else if (prop.name === 'END') {
            if (stack.length > 1) stack.pop();
        } else {
            top.props.push(prop);
        }
    }
    return root.children;
}

export const prop = (comp, name) => comp.props.find((p) => p.name === name);
export const props = (comp, name) => comp.props.filter((p) => p.name === name);

// ---------------------------------------------------------- dates and times --

/** The family's time zone, for the rare time a phone sends one in UTC. */
const serverZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const validZone = (tz) => {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

/**
 * The zone to read UTC times in: the one the phone names elsewhere in the same
 * file if it names one -- which it nearly always does, as the TZID of the start
 * -- and the server's otherwise.
 */
export function zoneOf(components) {
    const seen = [];
    const walk = (c) => {
        for (const p of c.props) if (p.params.TZID) seen.push(p.params.TZID);
        c.children.forEach(walk);
    };
    components.forEach(walk);
    return seen.find(validZone) ?? serverZone();
}

/** A UTC instant as the wall-clock date and time in `zone`. */
function inZone(ms, zone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(new Date(ms))
            .map((p) => [p.type, p.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * A DATE or DATE-TIME value as { date, time }, time being null for a date.
 *
 * Times with a TZID are taken as written: they are the phone's own wall
 * clock, which is the family's, and the hub keeps wall-clock times.
 */
export function parseWhen(value, zone) {
    const v = String(value ?? '').trim();
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
    if (!m) return null;
    if (m[7]) return inZone(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]), zone);
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

/** A DURATION in minutes, signed; null if it is not one. */
export function parseDuration(value) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const mins = (+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.round((+m[6] || 0) / 60);
    return m[1] === '-' ? -mins : mins;
}

export const addDays = (iso, n) => fromDayNumber(dayNumber(iso) + n);

/** Minutes from one date and time to another. */
export const minutesBetween = (a, b) =>
    (dayNumber(b.date) - dayNumber(a.date)) * 1440 + toMinutes(b.time ?? '00:00') - toMinutes(a.time ?? '00:00');

const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

/** A date and a number of minutes after its midnight, as { date, time }. */
export function atMinutes(date, minutes) {
    const days = Math.floor(minutes / 1440);
    const rest = minutes - days * 1440;
    return {
        date: addDays(date, days),
        time: `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`,
    };
}

// ---------------------------------------------------------- repeat rules --

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** An RRULE value as a plain object; `parts` keeps every key it had. */
export function parseRule(value) {
    const parts = {};
    for (const piece of String(value ?? '').split(';')) {
        const eq = piece.indexOf('=');
        if (eq > 0) parts[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim().toUpperCase();
    }
    return {
        parts,
        freq: parts.FREQ,
        interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
        byday: parts.BYDAY ? parts.BYDAY.split(',') : [],
        until: parts.UNTIL ?? null,
        count: parts.COUNT ? Number(parts.COUNT) : null,
    };
}

/* Repeat rule parts the hub keeps, or reads and checks; any other part means
   a rule it cannot keep. */
const KNOWN_RULE_PARTS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'UNTIL', 'COUNT', 'WKST']);

export const unknownRuleParts = (rule) => Object.keys(rule.parts).filter((k) => !KNOWN_RULE_PARTS.has(k));

// ------------------------------------------------- what is kept as it came --

/*
 * Properties the hub has no field for -- a reminder's flag and priority, a
 * link, the map pin behind an event's place -- kept as the lines they came in
 * on and sent back out with the rest, so that editing a reminder in the hub
 * does not quietly unflag it on the phone.
 *
 * Not the ones the hub writes itself, and not invitations: an event that goes
 * back out with attendees on it becomes a meeting to answer.
 */
const MANAGED = new Set([
    'UID', 'DTSTAMP', 'SUMMARY', 'DTSTART', 'DTEND', 'DUE', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'EXRULE',
    'RECURRENCE-ID', 'LOCATION', 'DESCRIPTION', 'SEQUENCE', 'CREATED', 'LAST-MODIFIED', 'STATUS', 'COMPLETED',
    'PERCENT-COMPLETE', 'ATTENDEE', 'ORGANIZER', 'TRANSP',
]);
const MAX_EXTRA_LINES = 30;
const MAX_EXTRA_LINE = 2000;

export const extraLines = (comp) =>
    comp.props
        .filter((p) => !MANAGED.has(p.name) && /^[A-Z0-9-]+$/.test(p.name) && p.raw.length <= MAX_EXTRA_LINE)
        .slice(0, MAX_EXTRA_LINES)
        .map((p) => p.raw);
