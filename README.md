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
desktop/    Electron + React UI, with mpv embedded for playback.
tools/      Development scripts for profiling a library and testing the parser.
```

The server is a separate process from the UI on purpose: it keeps the door open
for phone/TV clients later without restructuring anything.

Playback is handled by embedded **mpv** rather than an HTML `<video>` element.
A browser engine cannot open Matroska at all, and cannot decode DTS or TrueHD —
which rules it out for a library that is ~92% MKV.

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

## Development

```bash
npm install

npm run scan      # scan configured library roots into the database
npm run server    # start the local API
npm run dev       # launch the desktop app
```

Library roots are configuration, not hard-coded paths, so additional drives can
be added and a disconnected drive degrades gracefully.
