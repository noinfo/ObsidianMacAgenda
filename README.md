# Obsidian Mac Agenda

A calm day view for Obsidian on macOS: the day's **Apple Calendar** events and **Apple Reminders** in the right sidebar, next to a **dedicated note for each day**. Reminders can be ticked off; nothing else is written back.


## Features

- Date header with `‹ Today 📅 › ⟳` navigation; the calendar button opens a month picker (page by month or year, click the title for a 12-month view, week numbers, dots for days with a note).
- Week strip with ISO week number (Monday start) and dots for days that already have a note.
- All-day events, timed schedule with a "now" line, past events dimmed.
- Reminders due on the day, overdue ones on today, completed ones struck through — tick to complete in Apple Reminders.
- One note per day. Uses the core **Daily notes** settings (folder, format, template) when that plugin is enabled, otherwise its own.
- Browsing days opens that day's note; opening a daily note moves the agenda to that date.

## Install

### With BRAT (recommended for several devices)

1. Install **BRAT** (Obsidian42 – BRAT) from Community plugins.
2. *BRAT → Add beta plugin* → paste `https://github.com/noinfo/ObsidianMacAgenda` → choose the latest version.
   For a **private** repository, first add a GitHub personal access token (read-only access to this repo is enough) in BRAT's settings.
3. Enable **Mac Agenda** under Community plugins. BRAT keeps it updated on every device.

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/mac-agenda/` and enable the plugin.

### First start on each Mac

The plugin builds a small background app, **Mac Agenda Helper**, in `~/Library/Application Support/Mac Agenda/` using macOS's built-in `osacompile`, and talks to Calendar and Reminders through Apple's EventKit framework. macOS then asks whether *Mac Agenda Helper* may access your calendars and reminders — allow **full access** to both.

Missed a prompt? *System Settings → Privacy & Security → Calendars* and *→ Reminders*, enable *Mac Agenda Helper*.

On iPhone/iPad the plugin doesn't load (it's desktop-only); your daily notes are plain Markdown and work everywhere.

## Troubleshooting

Run the command **"Run Calendar & Reminders diagnostics"**. It writes a note `Mac Agenda diagnostics.md` with access status, counts and timings — no event or reminder contents.

An **AppleScript** data source exists as a fallback (settings), but it is very slow with larger calendars.

## Coming from Parchsidian

Settings from the old `parchsidian` plugin are imported automatically the first time. Afterwards you can delete:

- the folder `<vault>/.obsidian/plugins/parchsidian/`
- `~/Library/Application Support/Parchsidian/`
- the *Parchsidian Helper* entries under *System Settings → Privacy & Security → Calendars / Reminders* (optional)

## Development

No build step: `main.js` is loaded by Obsidian as-is.

- `helper/helper.js` — source of the EventKit helper (JavaScript for Automation). After editing it run `npm run embed` to copy it into `main.js`. Changing it makes the plugin rebuild the helper app, and macOS will ask for access again.
- `npm test` — checks the embedded helper is up to date and runs the recurrence/reminder tests (plain Node, no dependencies).
- Releases: bump `version` in `manifest.json`, `package.json` and `versions.json`, commit, then push a tag with the same version (`git tag 0.5.1 && git push --tags`). The GitHub Action publishes the release BRAT installs from.

## License

GPL-3.0 — see [LICENSE](LICENSE).
