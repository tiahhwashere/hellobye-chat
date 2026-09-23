# HelloBye Desktop

A native desktop app for **HelloBye Chat** (https://hellobye-chat.onrender.com/).

## What it does

- **Feels like a real PC app** — a frameless window with its own native title bar
  (drag region + minimise / maximise / close controls). There is **no**
  File / View / Edit / Help menu bar anywhere.
- **Opens at 60% of your screen** by default, and renders the app content
  **zoomed out to ~60%** so the original layout doesn't look smushed in the
  smaller window. The native title bar is counter-scaled so it stays at its
  true pixel size.
- **Custom launch animation** — a CSS-only loading splash (no emojis, no SVG
  icons) plays every time the app is opened, before the app content appears.
- **App icon** uses the same image as the website favicon.
- **Remembers your login** across restarts (persistent session).
- **Microphone works out of the box** — permissions are granted automatically so
  voice chat and voice messages work immediately.
- **Soft updates that restart the app**: the app checks the website's build id
  every 30 seconds. When the website is updated, a soft toast appears
  ("Update ready") with a 20-second countdown and a **Restart now** button.
  Applying the update **closes and reopens the whole client** so the new build
  is loaded cleanly — no page refresh, and your login/data are kept.

## Run from source

```bash
cd desktop
npm install
npm start
```

## Build a Windows installer / portable exe

```bash
cd desktop
npm install
npm run dist
```

Outputs land in `desktop/dist/`:

- `HelloBye Setup <version>.exe` — NSIS installer (Start Menu + Desktop shortcut)
- `HelloBye-Portable-<version>.exe` — single-file portable executable

## Configuration

Set `HELLOBYE_URL` to point the app at a different deployment:

```bash
HELLOBYE_URL=http://localhost:3000/ npm start
```

## Download page

The website's **Get HelloBye for PC** page (`/download`) resolves the newest
desktop release automatically from the server's `/api/desktop-release` endpoint,
so the download link always points at the latest build.
