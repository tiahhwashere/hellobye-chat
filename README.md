# Hellobye Chat

Real-time chat app: Node.js + Express + Socket.io backend serving a single-page frontend.

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Render
1. Push this repo to GitHub.
2. On Render: New -> Web Service -> connect this repo.
3. Render auto-detects `render.yaml` (build: `npm install`, start: `npm start`, health check `/`).
4. (Recommended) Add a Render **Disk** (1GB, $0.25/mo) mounted at `/opt/render/project/src/data` and another at `/opt/render/project/src/uploads` so user accounts, messages, and uploaded files persist across redeploys.
5. Your permanent URL: `https://<your-service-name>.onrender.com`.

## Notes
- `uploads/` ships with the 4 role badge icons (moderator/developer/staff/trusted-user) so badges display correctly on first deploy.
- `data/db.json` ships empty/fresh — first registered user becomes admin automatically (per the app's logic).
- The frontend is same-origin aware (uses relative `API_BASE` from `window.location`), so it works on any host with no config change.
- Free Render tier sleeps after 15 min idle. To keep it always-on, point a free UptimeRobot monitor at your URL (ping every 10 min).
