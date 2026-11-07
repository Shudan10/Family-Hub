import { dataPath, readJson, writeJson } from './store.js';

/*
 * The household's settings: where it is, for the weather, and which units.
 *
 * Stored on the server rather than per device like the theme, because these
 * are facts about the house rather than preferences of whoever is holding the
 * iPad: everybody's weather should be for the same town.
 */

const FILE = dataPath('settings.json');

const DEFAULTS = {
    // { name, lat, lon } once somebody has picked a town.
    location: null,
    units: 'fahrenheit',
    // The secret in the iPhone calendar link, or null while there is no link.
    // See lib/feed.js.
    feedToken: null,
    // What the link carries besides events. Dinners are off to begin with: a
    // planned week puts an all-day line on every day of the phone's calendar.
    feedDinners: false,
    feedChores: true,
};

export const UNITS = ['fahrenheit', 'celsius'];

export function loadSettings() {
    const saved = readJson(FILE, {});
    return { ...DEFAULTS, ...saved };
}

export function saveSettings(next) {
    writeJson(FILE, { ...loadSettings(), ...next });
    return loadSettings();
}

/** A place from the town search, checked before it is kept. */
export function normaliseLocation(input) {
    const lat = Number(input?.lat);
    const lon = Number(input?.lon);
    const name = String(input?.name ?? '').trim().slice(0, 120);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return null;
    }
    // These are the town's own coordinates from the search, never the house's.
    // Two decimal places is about a kilometre -- far finer than a forecast
    // needs, and nothing more precise is worth sending to a weather service.
    return { name, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}
