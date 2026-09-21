# HelloBye Desktop

A native desktop app for **HelloBye Chat** (https://hellobye-chat.onrender.com/).

## What it does

- Opens HelloBye in its own native window (no browser tabs).
- **Remembers your login** across restarts (persistent session).
- **Microphone works out of the box** — permissions are granted automatically so
  voice chat and voice messages work immediately.
- **Soft updates**: the app checks the website's build id every 30 seconds.
  When the website is updated, a soft banner appears ("A new update is
  available") with a 20-second countdown and an **Update now** button. The app
  reloads to apply the update — no reinstall needed, and your login/data are
  kept.

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
