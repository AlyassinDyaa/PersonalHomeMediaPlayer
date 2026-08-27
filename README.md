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

The server is a separate process from the UI on purpose, which is what makes
the browser client below possible without restructuring anything.

Playback is handled by **mpv** rather than an HTML `<video>` element. A browser
engine cannot open Matroska at all, and cannot decode DTS or TrueHD, which rules
it out for a library that is ~92% MKV.

mpv runs in its own borderless fullscreen window rather than embedded into an
Electron window via `--wid`. Embedding does display video correctly, but mouse
and keyboard events never reach mpv's child window, so its on-screen controls
never appear and seeking is impossible. Both modes were compared by screenshot
before choosing. Embedding remains available behind `embedPlayer` in config for
future work on a custom overlay.

## Watching on a phone or tablet

Switch sharing on under Library, set a passcode, and the library is reachable
from any browser on the house network. Safari gets the same interface the
desktop window runs, not a cut-down one.

Getting a file to play there is the interesting part, because Safari opens
almost nothing this library is stored as. Each file is judged before playback:

- **Handed over untouched** when it is already H.264 or HEVC in an MP4.
- **Repackaged** when the picture is fine but the container is not — most of
  the library, and cheap, because the picture is copied rather than re-encoded.
- **Re-encoded** when the picture genuinely cannot be played, or when it is too
  large to send. A Blu-ray remux is H.264 and could be copied byte for byte,
  but thirty megabits a second is more than household Wi-Fi carries; copying it
  produces a player that buffers forever while looking, by every other measure,
  correct. Bitrate and picture size are therefore weighed alongside codec, and
  anything over the ceiling is sent smaller.

Re-encoding uses the machine's graphics hardware — NVENC, Quick Sync or
VideoToolbox — chosen at startup by making each candidate encode a fraction of a
second and seeing which one actually works, since being listed by ffmpeg says
nothing about whether the hardware is present. Software encoding is the
fallback, and is the difference between a film that plays and one that stalls
every few seconds.

Conversion runs from the point being watched and is served over HLS as it is
produced, so playback starts in a few seconds rather than after the whole file
has been through ffmpeg. Seeking within what has already been produced is
instant and reuses the same conversion; only a jump past the end of it starts a
new one. A viewer whose player is paused says so every half minute, so a pause
does not end the stream.

The player's controls are the app's rather than Safari's. They have to be: a
stream produced from the middle of an episode makes the video element believe
the episode is nought seconds long and growing, so its own timeline shows a
fraction of the runtime. Ours counts in absolute time within the film, whatever
the stream underneath is doing.

Quality can be forced down from the player for a device at the far end of the
house, and the choice is remembered.

While the library is shared, the computer is held awake — system suspension
only, so the screen still turns itself off. A sleeping computer serves nobody:
watching on a tablet stops a few minutes after the laptop's screen goes dark,
and a laptop already asleep cannot be reached at all. Closing a laptop's lid
still sleeps it; that is an operating system power setting rather than
something an application can overrule, and it is the strongest argument for
moving the server onto something that stays on.

Subtitles are not carried to browsers yet; the desktop player has them.

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

A `#play/<itemId>` hash starts that title on launch, which makes a shortcut that
resumes a specific show possible.

Library roots are configuration, not hard-coded paths, so additional drives can
be added and a disconnected drive degrades gracefully.
