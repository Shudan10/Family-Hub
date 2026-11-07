# Family Hub

A family board for [Quick Start Home](https://github.com/Shudan10/Home): the
day at a glance, a shared calendar, a chore chart, the weather, and the meal
planner it grew out of. Everything is kept on this server — nothing goes to
iCloud, Google or anybody else — and phones can see the calendar through a
subscription link.

Built for an iPad on the kitchen wall in landscape, and for phones.

The project, container and data folder are still called Meal Plan, so existing
installs keep their data; only the name on screen changed.

## The board

- **Today.** A big clock, today's weather and the next four days, what is on
  the calendar today, tonight's dinner (tap it to change it), and today's
  chores to tick off. It notices midnight and refreshes itself every five
  minutes while it is on screen.
- **The family.** Everyone gets a name and one of ten colours, chosen so no two
  look alike. The colour marks their events and their column of chores.
  Removing someone keeps their events and chores; they just become everybody's.
- **Calendar events.** Timed or all day, a few days long if need be, for one
  person, several, or the whole family. They repeat weekly, monthly or yearly,
  with an optional end — and one day of a repeating event can be deleted on its
  own. A monthly event on the 31st skips the months that do not have one, and a
  birthday on 29 February waits for leap years, rather than sliding about.
- **Chores and to-dos.** A column per person on the Tasks tab, one day at a
  time. Chores repeat every day or on chosen days of the week and come back
  fresh each day. One-offs have an optional due day; one with no day waits on
  today's list until it is done, and one whose day has passed stays on today's
  list marked late.
- **Weather.** From [Open-Meteo](https://open-meteo.com), which needs no
  account or key. The town is set once for the house in Settings; only its
  rounded coordinates are sent, and the forecast is cached for 15 minutes.
- **On your iPhone.** Settings makes a calendar link and a QR code for it.
  Scanned with an iPhone camera, it subscribes the phone's Calendar app to the
  family's events — and, if wanted, chores with a due day and the planned
  dinners. It is read only on the phone: things are added in the hub. See
  [The calendar link](#the-calendar-link).

## Meals

- **A meal library.** Name, tags, how many it serves, ingredients and method.
  Only the name is required, so adding "Tacos" takes three seconds and the
  recipe can be filled in later.
- **A week at a time.** One meal a day — dinner, which is the one that gets
  planned. Tap a day, pick a meal.
- **A month, or a week.** The calendar shows the shape of a month at a glance,
  and switches to a single week where the names are big enough to read from
  across the kitchen. The button in the header swaps between them and lands on
  the current month or week either way.
- **Random week.** Fills the days. It draws without replacement, so
  a week does not come back as the same dinner four times, and by default it
  only fills blanks — if you have already decided on Friday, Friday is kept.
  Saturday and Sunday can be left out, for households that eat differently at
  the weekend.
- **Weekly limits.** Some things should not come round twice in one week.
  Anything with `taco` in its name is capped at once a week, and the whole
  family counts as one thing: Chicken tacos, Beef tacos and Taco salad are
  different meats, but they are still tacos, and one of them on Tuesday stops
  another appearing on Friday. The rules are a short list at the top of
  `lib/store.js` (`WEEKLY_LIMITS`); adding another is one line.
- **A shopping list.** Everything the planned week needs, grouped, with a count
  where two meals want the same thing. Quantities are not added up: "500g mince"
  and "1 lb mince" cannot be reconciled without a unit parser, and a list that
  quietly gets the amounts wrong is worse than one that shows both lines.
- **Themes.** Colours — Blue, Black, White, Red, Green, Purple, Orange, Pink
  and Teal — and holidays from New Year's round to Christmas, each with its own
  palette and a small mark of the season. Blue, the default, follows the
  device's light or dark setting; the rest choose for themselves. Saved per
  device, so each phone or iPad in the house can have its own. All of them are
  described in one place, `public/themes.js`.
- **Installs to the home screen.** It is a PWA, so Add to Home Screen gives it
  an icon and no browser chrome.

## Running it

Normally this is installed and managed by the Quick Start Home panel, which
builds the image, sets the password and publishes it. To run it directly:

```bash
docker build -t mealplan .
docker run -d --name mealplan -p 8083:8080 -v mealplan-data:/data mealplan
```

Then open `http://<this machine>:8083`.

### Environment

| Variable | What it does |
| --- | --- |
| `PORT` | Port inside the container. Default `8080`. |
| `MEALPLAN_DATA` | Where the JSON files live. Default `/data`. |
| `MEALPLAN_PASSWORD_HASH` | A `scrypt:salt:hash` value. **Without it there is no password and anyone who can reach the port can change the plan.** |
| `SESSION_SECRET` | Signs session cookies, together with the password hash, so changing the password signs everyone out. Generated per start if unset, which logs everyone out on restart. |
| `MEALPLAN_ALLOWED_HOSTS` | Only matters with no password set: extra names, comma-separated, that the app answers to (`.example.com` allows a whole domain). IP addresses, `localhost`, `*.ts.net`, `*.local` and dotless names are always accepted; anything else is refused, which is what stops a DNS-rebinding page from reaching the plan. |

Generate a password hash:

```bash
node -e "import('./lib/auth.js').then(a=>console.log(a.hashPassword('your password here')))"
```

Colons separate the fields rather than `$` on purpose: Docker Compose
interpolates `$NAME` when it reads an `.env` file, which silently truncated
`$`-separated hashes and made the panel refuse the correct password.

## The calendar link

The phone's Calendar app cannot sign in, so the link cannot sit behind the
family password. Instead it carries a long random token
(`/api/feed/<token>.ics`), and that token is the key: anyone with the link can
read the calendar, nobody without it learns anything (a wrong one is a plain
404). **New link** in Settings replaces it, which shuts off the old one;
**Turn off** removes it.

The link is made from the address the page is open at. Made at a home address
such as `192.168.x.x`, the phone only refreshes while it is on the home Wi-Fi
and keeps what it last saw when away. Made at the hub's public address (once
it is published through the panel, which needs a password first), it refreshes
anywhere. The phone decides how often to check — usually within the hour.

Repeating events go to the phone as repeat rules rather than copies, so they
carry on as far ahead as the phone looks. Times are "floating": 10:00 means
ten o'clock wherever the phone is.

## Data

JSON files in `/data`:

- `meals.json` — the library, an array of meals.
- `plan.json` — `{ "2026-10-26": { "dinner": "<meal id>" } }`, keyed by date.
- `members.json` — the family: names and colours.
- `events.json` — calendar events. A repeating one is stored once, as its rule
  and the days skipped.
- `tasks.json` — chores and to-dos, with the days each was done.
- `settings.json` — the town, the units, and the calendar link's token.

Written to a temp file and renamed over the target, so a crash midway cannot
leave a half-written file that reads back as an empty library. All of them are
plain enough to fix with a text editor, which is the main reason they are not a
database.

Shopping-list ticks are *not* stored here — they live in the browser of whoever
is doing the shopping, because syncing them would mean someone at home
un-ticking a row halfway down an aisle.

## Notes

- Weeks start on Sunday. One constant at the top of `public/app.js`
  (`WEEK_STARTS_ON`) changes that, and nothing else depends on which it is.
- The service worker caches nothing. It exists so iOS treats the page as a real
  home-screen app; a board served stale from a cache is worse than one that
  admits it cannot reach the server.
- An iPhone that already has the app on its home screen keeps the old name
  under the icon until it is removed and added again.
