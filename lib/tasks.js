import crypto from 'node:crypto';
import { dayNumber } from './events.js';
import { dataPath, isIsoDate, readJson, writeJson } from './store.js';

/*
 * Chores and to-dos: feed the dog every day, bins out on Tuesdays, call the
 * plumber.
 *
 * Two kinds, one record. A repeating chore is a rule -- every day, or these
 * days of the week -- with the days it was done; it comes back fresh each day
 * whether or not yesterday's was ticked, because yesterday's dishes are not
 * still waiting. A one-off is done once and then it is gone, and until then it
 * stays in front of somebody: one that was due on Monday and is still not done
 * on Thursday is on Thursday's list, marked late, rather than quietly sitting
 * on a day nobody is looking at any more.
 */

const FILE = dataPath('tasks.json');

export const TASK_REPEATS = ['none', 'daily', 'weekly'];
const MAX_TASKS = 500;

/*
 * How far back the ticks of a repeating chore are kept.
 *
 * A chore done every day for years would otherwise grow a list of every one of
 * those days. A little over a year is enough to look back on and still small.
 */
const KEEP_DONE_DAYS = 400;

export const loadTasks = () => readJson(FILE, []);
export const saveTasks = (list) => writeJson(FILE, list);

const newId = () => `t_${crypto.randomBytes(8).toString('hex')}`;

/** 0 for Sunday to 6 for Saturday, without a Date in local time. 1 January 1970 was a Thursday. */
export const weekday = (iso) => (((dayNumber(iso) + 4) % 7) + 7) % 7;

/** Whether a repeating chore comes up on `iso`. */
function repeatsOn(task, iso) {
    if (task.date && iso < task.date) return false;
    if (task.repeat === 'daily') return true;
    if (task.repeat === 'weekly') return task.days.includes(weekday(iso));
    return false;
}

/**
 * What is on the list for `day`, as seen on `today`.
 *
 * `today` comes from the device asking, not from the server's clock: the
 * server keeps UTC, and the family's evening would otherwise become tomorrow
 * at seven o'clock.
 */
export function tasksOn(tasks, day, today) {
    const out = [];
    for (const task of tasks) {
        const entry = {
            id: task.id,
            title: task.title,
            member: task.member,
            repeat: task.repeat,
            days: task.days,
            date: task.date,
            done: false,
            overdue: false,
        };
        if (task.repeat !== 'none') {
            if (!repeatsOn(task, day)) continue;
            entry.done = task.done.includes(day);
            out.push(entry);
            continue;
        }
        // A one-off that has been done shows on the day it was done, ticked,
        // and nowhere else.
        const doneOn = task.done[0];
        if (doneOn) {
            if (doneOn !== day) continue;
            entry.done = true;
            out.push(entry);
            continue;
        }
        if (task.date === day) {
            out.push(entry);
        } else if (day === today && (!task.date || task.date < today)) {
            // Undated ones, and late ones, wait on today's list.
            entry.overdue = Boolean(task.date);
            out.push(entry);
        }
    }
    // Late first, so they are not missed; then what is left to do; done last.
    return out.sort(
        (a, b) =>
            Number(a.done) - Number(b.done) ||
            Number(b.overdue) - Number(a.overdue) ||
            a.title.localeCompare(b.title),
    );
}

/** Ticks or unticks `task` for `day`. Returns false when it is not on that day's list at all. */
export function markDone(task, day, done, today) {
    if (!tasksOn([task], day, today).length) return false;
    if (task.repeat === 'none') {
        task.done = done ? [day] : [];
    } else {
        const set = new Set(task.done);
        if (done) set.add(day);
        else set.delete(day);
        const oldest = dayNumber(day) - KEEP_DONE_DAYS;
        task.done = [...set].filter((d) => dayNumber(d) >= oldest).sort();
    }
    task.updatedAt = new Date().toISOString();
    return true;
}

// ------------------------------------------------------------- the input --

export function normaliseTask(input, memberIds, existing = null, count = 0) {
    const errors = [];
    const s = (v) => String(v ?? '').trim();

    const title = s(input.title);
    if (!title) errors.push('Say what needs doing.');
    if (title.length > 120) errors.push('That is too long for a chore.');
    if (!existing && count >= MAX_TASKS) errors.push('The list is full. Delete some old ones first.');

    const repeat = TASK_REPEATS.includes(input.repeat) ? input.repeat : 'none';

    let days = [];
    if (repeat === 'weekly') {
        const raw = Array.isArray(input.days) ? input.days : [];
        days = [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
        if (!days.length) errors.push('Pick the days it happens.');
    }

    // For a one-off this is when it is due, and may be left empty; for a
    // repeating chore it is when it starts.
    const date = s(input.date) || null;
    if (date && !isIsoDate(date)) errors.push('That is not a date.');

    // Somebody's, or anybody's. Someone who has since been removed is anybody.
    const member = memberIds.includes(input.member) ? input.member : null;

    // Ticks belong to the chore, so editing it keeps them -- except when it
    // changes between one-off and repeating, where they mean different things.
    const sameKind = existing && (existing.repeat === 'none') === (repeat === 'none');

    const task = {
        id: existing?.id ?? newId(),
        title,
        member,
        repeat,
        days,
        date,
        done: sameKind ? existing.done : [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return { task, errors };
}

/** Gives someone's chores to everybody; the chores themselves stay. */
export function unassignMember(memberId) {
    const tasks = loadTasks();
    let changed = false;
    for (const task of tasks) {
        if (task.member === memberId) {
            task.member = null;
            changed = true;
        }
    }
    if (changed) saveTasks(tasks);
}
