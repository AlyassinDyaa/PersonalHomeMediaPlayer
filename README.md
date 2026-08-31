# PersonalHomeMediaPlayer

Allows users to have a home media player with simple UI that can play almost any
media. From movies to tv shows to any video they have saved on their drive.

Point it at folders on a drive and it works out what everything is, then
presents it as a browsable, Netflix-style library with artwork — no renaming or
reorganising required.

## Why not Jellyfin/Plex

Those expect a tidy `Movies/` + `TV/` split and consistent naming. Real
libraries are not tidy: one show gets split across four top-level folders, two
different shows share one folder, season folders contain typos, and episodes are
numbered `S01E01`, `1x01`, or a bare `201` depending on who ripped them. This
scanner is built around those cases rather than against them.

## Architecture

```
server/     Headless Node service: scanner, metadata, SQLite, local REST API.
desktop/    Electron + React UI, driving mpv for playback.
tools/      Development scripts for profiling a library and testing the parser.
```

The server is a separate process from the UI on purpose: it keeps the door open
for phone/TV clients later without restructuring anything.

Playback is handled by **mpv** rather than an HTML `<video>` element. A browser
engine cannot open Matroska at all, and cannot decode DTS or TrueHD, which rules
it out for a library that is ~92% MKV.

mpv runs in its own borderless fullscreen window rather than embedded into an
Electron window via `--wid`. Embedding does display video correctly, but mouse
and keyboard events never reach mpv's child window, so its on-screen controls
never appear and seeking is impossible. Both modes were compared by screenshot
before choosing. Embedding remains available behind `embedPlayer` in config for
future work on a custom overlay.

## Scanner

The interesting part. It handles, verified against a real 1,461-file library:

- **One show split across many folders** — `Ben 10 2005 S01`, `S02`, `S03` and
  `Ben 10 S04` merge into one show with four seasons.
- **Two shows sharing one folder** — Justice League and Justice League Unlimited
  are separated, using season overlap to tell "same show, inconsistent naming"
  from "genuinely different shows".
- **Mixed episode numbering** — `S01E01`, `1x01`, `- 101 & 102 -` (one file
  holding two episodes), and bare `201` resolved against the folder's season.
- **Typos** — `SEAOSN 1` matches via edit distance.
- **Duplicates** — the same episode at two qualities is de-duplicated by file
  size, keeping the better copy and remembering the other.
- **Junk** — samples, extras and screenshot folders, with size-outlier detection
  as a backstop that does not rely on naming.

Anything uncertain is scored and surfaced as a suggestion for confirmation in
the UI, rather than being guessed at silently.

## Building a portable copy

```bash
npm run package
```

Produces a self-contained folder under `release/` holding the app, a Node
runtime and mpv. Copy it to a USB stick or external SSD and run
`MediaLibrary.exe` from there: the database, artwork cache and settings are
written to a `data` folder beside the executable, so the whole library travels
with the drive. Deleting `portable.txt` switches to storing them under
`%APPDATA%` instead.

Bundling Node is not incidental — the media server runs under Node rather than
inside Electron because it uses Node's built-in SQLite, and Electron still ships
a Node release that predates it.

An installer is configured (`npm run dist`) but needs Windows Developer Mode or
administrator rights, because electron-builder extracts a code-signing bundle
containing macOS symlinks that Windows will not create otherwise.

## Development

```bash
npm install

npm run scan      # scan configured library roots into the database
npm run server    # start the local API
npm run dev       # launch the desktop app
npm run package   # build the portable Windows app
```

Machine-specific settings belong in `config.local.json` (gitignored); the TMDB
API key goes in `.env` or the Library screen.

`npm run package` copies that key into the built folder as `metadata.key`,
scrambled rather than plain, so a copy handed to someone shows artwork and
descriptions without them signing up for a key first. It is never committed —
this repository is public. Settings replaces the included key with a personal
one, and clearing the box puts the included one back.

A `#play/<itemId>` hash starts that title on launch, which makes a shortcut that
resumes a specific show possible.

Library roots are configuration, not hard-coded paths, so additional drives can
be added and a disconnected drive degrades gracefully.
