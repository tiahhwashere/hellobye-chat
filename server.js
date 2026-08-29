// Hellobye Chat — Compatible Backend
// Express + Socket.io implementation matching the frontend SPA's API surface.

// Global crash diagnostics — log any uncaught errors so we can see them in
// the Render dashboard logs instead of a silent exit code 1.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');
// 4K/HD enhancement for uploaded images & GIFs. Loaded defensively so a
// failure in the enhancement module (e.g. sharp's native binary not loading
// on the host) never prevents the chat server from starting. Enhancement is
// best-effort \u2014 if it is unavailable, uploads are simply served as-is.
let enhanceUpload = null;
try {
  ({ enhanceUpload } = require('./enhance'));
} catch (err) {
  console.error('[server] WARNING: enhancement module failed to load \u2014 uploads will be served unenhanced. Error:', err.message);
}

// Run enhanceUpload but never let it hang the request. If enhancement takes
// longer than `ms`, we give up and serve the original file instead. This is
// the safety net that prevents the "GIF just loading in a loop" bug: even if
// a future change re-introduces slow per-frame processing, the upload will
// still complete and the profile picture will be applied using the original.
function enhanceWithTimeout(filePath, opts, ms) {
  if (!enhanceUpload) return Promise.resolve({ enhanced: false, reason: 'module unavailable' });
  ms = ms || 8000;
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.error('[enhance] Timed out after', ms, 'ms \u2014 serving original file:', filePath);
      resolve({ enhanced: false, reason: 'timeout, original served' });
    }, ms);
    enhanceUpload(filePath, opts)
      .then((r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); })
      .catch((e) => { if (done) return; done = true; clearTimeout(timer); console.error('[enhance] error:', e.message); resolve({ enhanced: false, reason: e.message }); });
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true, allowedHeaders: ['Content-Type', 'X-Session-Id'] },
  maxHttpBufferSize: 1e8, // 100MB — file metadata only; actual files go through /api/upload via multer
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Storage ----------
// NOTE: On Render's free tier the local filesystem is EPHEMERAL — every deploy
// (and every inactivity spin-down/restart) wipes the container, which previously
// destroyed all user accounts/messages/sessions stored in data/db.json.
// To survive deploys, the DB is mirrored to an EXTERNAL private GitHub repo via
// the Contents API (configurable via env vars). On startup we restore from the
// external backup if it exists and is newer/has data; otherwise we fall back to
// the local file. Every save is mirrored to the external repo (debounced).
const DB_FILE = path.join(DATA_DIR, 'db.json');

// --- External backup configuration (GitHub Contents API) ---
const BACKUP_TOKEN = process.env.GITHUB_BACKUP_TOKEN || '';
const BACKUP_REPO = process.env.GITHUB_BACKUP_REPO || ''; // e.g. "tiahhwashere/hellobye-chat-data"
const BACKUP_PATH = process.env.GITHUB_BACKUP_PATH || 'data/db.json';
const BACKUP_BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'main';
const BACKUP_ENABLED = !!(BACKUP_TOKEN && BACKUP_REPO);
const UPLOAD_BACKUP_DIR = 'uploads'; // path inside the backup repo for uploaded files

// --- GIPHY API key for the GIF picker (server-side proxy) ---
// Optional: if set, the /api/gif/search endpoint proxies GIPHY search/trending.
// If unset, the frontend GIF picker falls back to a URL-paste mode.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

// Minimal GitHub API helper using built-in https (no extra deps).
function githubRequest(method, urlPath, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const opts = {
      method,
      hostname: 'api.github.com',
      path: urlPath,
      headers: {
        'Authorization': `token ${BACKUP_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'hellobye-chat-backup',
      },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = require('https').request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (e) { parsed = null; }
        resolve({ status: res.statusCode, data: parsed, raw: chunks });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}

// Download a file from a URL (e.g. GitHub raw download_url) and return a Buffer.
// Used for restoring large uploads (>1MB) that the GitHub Contents API can't
// return as base64 content — the API returns encoding:"none" for those, but
// always provides a download_url pointing to raw.githubusercontent.com.
function downloadFileBuffer(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const proto = u.protocol === 'https:' ? require('https') : require('http');
      const req = proto.get(u, { headers: { 'User-Agent': 'hellobye-chat-backup', 'Accept': '*/*' } }, (res) => {
        // Follow one redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadFileBuffer(res.headers.location).then(resolve);
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      // 60s timeout for large file downloads
      req.setTimeout(60000, () => { req.destroy(); resolve(null); });
    } catch (e) { resolve(null); }
  });
}

// Fetch an upload file from the GitHub backup repo, handling both small files
// (base64 content) and large files (>1MB, via download_url).
// Returns a Buffer or null if the file could not be retrieved.
async function fetchBackupFile(filename) {
  const get = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
  if (get.status !== 200 || !get.data) return null;
  // Small file: content is base64-encoded inline
  if (get.data.content) {
    const b64 = (get.data.content || '').replace(/\s/g, '');
    return Buffer.from(b64, 'base64');
  }
  // Large file (>1MB): GitHub returns encoding:"none" but provides download_url
  if (get.data.download_url) {
    const buf = await downloadFileBuffer(get.data.download_url);
    return buf;
  }
  return null;
}

function defaultDB() {
  return { users: {}, messages: [], sessions: {}, dms: {}, friends: {}, blocked: {}, lastRegTime: {}, groupChats: [] };
}

function loadDBLocal() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('DB load error (local)', e); }
  return defaultDB();
}

// Restore from external GitHub backup. Returns parsed DB or null if unavailable.
async function loadDBRemote() {
  if (!BACKUP_ENABLED) return null;
  try {
    const r = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(BACKUP_PATH)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
    if (r.status !== 200 || !r.data || !r.data.content) {
      console.log(`[backup] No remote DB found (status ${r.status}).`);
      return null;
    }
    const b64 = (r.data.content || '').replace(/\s/g, '');
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    console.log(`[backup] Restored DB from GitHub (sha ${r.data.sha ? r.data.sha.slice(0,7) : '?'}, ${jsonStr.length} bytes, ${Object.keys(parsed.users||{}).length} users).`);
    parsed.__backupSha = r.data.sha; // remember sha so we can update the existing file
    return parsed;
  } catch (e) {
    console.error('[backup] Remote restore error:', e);
    return null;
  }
}

let remoteSha = null; // sha of the last-known remote db.json (for updates)

// Debounced remote backup. Saves the current db to the GitHub repo.
let backupTimer = null;
function scheduleRemoteBackup() {
  if (!BACKUP_ENABLED) return;
  if (backupTimer) clearTimeout(backupTimer);
  // Debounce: wait 5s after the last save before pushing, so rapid writes
  // (e.g. a burst of messages) only trigger one API call.
  backupTimer = setTimeout(pushRemoteBackup, 5000);
}

async function pushRemoteBackup() {
  if (!BACKUP_ENABLED) return;
  try {
    let payload = JSON.stringify(db);
    // Build content body. If we have a sha (file exists), include it to update;
    // otherwise create.
    const body = {
      message: 'auto db backup ' + new Date().toISOString(),
      content: Buffer.from(payload, 'utf8').toString('base64'),
      branch: BACKUP_BRANCH,
    };
    if (remoteSha) body.sha = remoteSha;
    const r = await githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(BACKUP_PATH)}`, body);
    if (r.status === 200 || r.status === 201) {
      const newSha = r.data && r.data.content && r.data.content.sha;
      if (newSha) remoteSha = newSha;
      console.log(`[backup] Pushed DB to GitHub (status ${r.status}, sha ${remoteSha ? remoteSha.slice(0,7) : '?'}).`);
    } else if (r.status === 409) {
      // sha mismatch — re-fetch latest and retry once with the new sha
      console.warn('[backup] sha mismatch (409); re-fetching and retrying.');
      const get = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(BACKUP_PATH)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
      if (get.status === 200 && get.data && get.data.sha) {
        remoteSha = get.data.sha;
        body.sha = remoteSha;
        const r2 = await githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(BACKUP_PATH)}`, body);
        if (r2.status === 200 || r2.status === 201) {
          if (r2.data && r2.data.content && r2.data.content.sha) remoteSha = r2.data.content.sha;
          console.log(`[backup] Retry push succeeded (sha ${remoteSha ? remoteSha.slice(0,7) : '?'}).`);
        } else {
          console.error('[backup] Retry push failed:', r2.status, (r2.data && r2.data.message) || r2.raw);
        }
      } else {
        console.error('[backup] Could not re-fetch sha for retry:', get.status);
      }
    } else {
      console.error('[backup] Push failed:', r.status, (r.data && r.data.message) || r.raw);
    }
  } catch (e) {
    console.error('[backup] Push error:', e);
  }
}

// Synchronous-ish startup: try remote first, fall back to local file.
let db = loadDBLocal();
if (db && db.__backupSha) { remoteSha = db.__backupSha; delete db.__backupSha; }

// Display name change cooldown — users must wait 5 seconds between changes
const displayNameCooldowns = new Map();
const DISPLAY_NAME_COOLDOWN_MS = 5000;
// Ensure new fields exist on existing DB
if (!db.welcomeTitle) db.welcomeTitle = 'welcome - to the safe place';
if (!db.welcomeTitleLastChanged) db.welcomeTitleLastChanged = 0;
if (!db.customRoles) db.customRoles = []; // [{ id, name, color, members: [username,...] }]
if (!db.cooldownExempt) db.cooldownExempt = []; // [username, ...] — users exempt from chat cooldown
if (!db.groupChats) db.groupChats = []; // [{ id, name, owner, icon, members:[username], messages:[], createdAt }]

// Attempt remote restore asynchronously. If remote has data (especially users),
// it takes precedence over the (possibly empty/repo-seeded) local file. This is
// what makes data survive deploys: even though the deploy resets the container's
// local fs to the repo's seed db.json, we overwrite it with the real remote data.
(async () => {
  const remote = await loadDBRemote();
  if (remote) {
    const remoteUsers = Object.keys(remote.users || {}).length;
    const localUsers = Object.keys(db.users || {}).length;
    // Prefer remote if it has more users, OR if local is the empty seed and
    // remote has any users. This protects real data from being overwritten by
    // an empty deploy-time seed, while still letting a fresh start work.
    if (remoteUsers > 0 && remoteUsers >= localUsers) {
      // Extract the remote sha BEFORE we strip it, so subsequent updates can
      // PUT with the correct sha (otherwise GitHub rejects with 422).
      remoteSha = remote.__backupSha || null;
      db = remote;
      delete db.__backupSha;
      // re-ensure fields
      if (!db.welcomeTitle) db.welcomeTitle = 'welcome - to the safe place';
      if (!db.welcomeTitleLastChanged) db.welcomeTitleLastChanged = 0;
      if (!db.customRoles) db.customRoles = [];
      if (!db.cooldownExempt) db.cooldownExempt = [];
      try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
      console.log(`[backup] Adopted remote DB as live db (${remoteUsers} users, sha ${remoteSha ? remoteSha.slice(0,7) : '?'}).`);
      // After adopting remote DB, ensure the owner (@lore) is not banned/muted.
      let ownerCleaned = false;
      for (const u of Object.values(db.users || {})) {
        if (isOwnerUser(u)) {
          if (u.banned) { u.banned = false; u.banReason = null; u.bannedAt = null; u.bannedBy = null; u.bannedUntil = 0; ownerCleaned = true; }
          if (u.mutedUntil && u.mutedUntil > 0) { u.mutedUntil = 0; u.muteReason = ''; u.mutedBy = ''; ownerCleaned = true; }
        }
      }
      if (ownerCleaned) {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
        console.log('[backup] Cleared ban/mute on owner after adopting remote DB.');
      }
      // Trigger an immediate backup so the sha is current.
      scheduleRemoteBackup();
    } else {
      console.log(`[backup] Keeping local db (${localUsers} users) — remote has fewer (${remoteUsers}).`);
      remoteSha = remote.__backupSha || null;
      if (remoteSha) delete remote.__backupSha;
      // Make sure local data is backed up remotely too.
      scheduleRemoteBackup();
    }
  } else {
    // No remote data — if we have local data, push it up so it's protected.
    if (Object.keys(db.users || {}).length > 0) {
      console.log('[backup] No remote DB; pushing current local DB to GitHub.');
      scheduleRemoteBackup();
    }
  }
})();

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('DB save error', e); }
  // Mirror to external backup so data survives the next deploy/restart.
  scheduleRemoteBackup();
}
setInterval(saveDB, 15000); // periodic save

// On startup + every hour: purge any disabled accounts whose 30-day grace
// period has elapsed. This enforces the automatic deletion after 30 days.
purgeExpiredDisabledAccounts();
setInterval(purgeExpiredDisabledAccounts, 60 * 60 * 1000); // hourly check

// On startup: purge any chat messages / DMs that were soft-deleted but never
// got permanently removed (e.g. the server restarted/spun down before the
// 2-minute cleanup window elapsed). This prevents stuck
// "This message was deleted" placeholders from lingering in the DB. Live
// clients will simply not receive these on their next /api/messages fetch;
// any currently-connected clients are handled by the periodic sweep below.
const DELETE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
function purgeExpiredDeletedMessages(emitRemovals) {
  let purged = 0;
  const removedIds = [];
  if (Array.isArray(db.messages)) {
    const now = Date.now();
    const kept = [];
    for (const m of db.messages) {
      if (m.deleted) {
        // Always purge soft-deleted messages whose window has elapsed. Also
        // purge any without a deletedAt (legacy) so they can't stick around.
        const age = m.deletedAt ? (now - new Date(m.deletedAt).getTime()) : Infinity;
        if (age >= DELETE_WINDOW_MS) { purged++; removedIds.push({ kind: 'message', id: m.id }); continue; }
      }
      kept.push(m);
    }
    db.messages = kept;
  }
  // Purge expired soft-deleted DMs across all users' DM stores.
  if (db.dms && typeof db.dms === 'object') {
    const now = Date.now();
    for (const [owner, convos] of Object.entries(db.dms)) {
      if (!convos || typeof convos !== 'object') continue;
      for (const [other, msgs] of Object.entries(convos)) {
        if (!Array.isArray(msgs)) continue;
        const before = msgs.length;
        const kept = msgs.filter(m => {
          if (!m.deleted) return true;
          const age = m.deletedAt ? (now - new Date(m.deletedAt).getTime()) : Infinity;
          if (age >= DELETE_WINDOW_MS) { purged++; removedIds.push({ kind: 'dm', id: m.id, owner, to: m.to }); return false; }
          return true;
        });
        if (kept.length !== before) convos[other] = kept;
      }
    }
  }
  // Purge expired soft-deleted group chat messages.
  if (Array.isArray(db.groupChats)) {
    const now = Date.now();
    for (const g of db.groupChats) {
      if (!Array.isArray(g.messages)) continue;
      const before = g.messages.length;
      const kept = g.messages.filter(m => {
        if (!m.deleted) return true;
        const age = m.deletedAt ? (now - new Date(m.deletedAt).getTime()) : Infinity;
        if (age >= DELETE_WINDOW_MS) { purged++; return false; }
        return true;
      });
      if (kept.length !== before) g.messages = kept;
    }
  }
  if (purged > 0) {
    saveDB();
    if (emitRemovals && typeof io !== 'undefined' && io && io.emit) {
      for (const r of removedIds) {
        if (r.kind === 'message') io.emit('message-removed', { id: r.id });
        else { io.to(`user:${r.owner}`).emit('dm-removed', { id: r.id }); if (r.to) io.to(`user:${r.to}`).emit('dm-removed', { id: r.id }); }
      }
    }
    console.log(`Cleanup: permanently removed ${purged} expired deleted message(s)/DM(s).`);
  }
  return purged;
}

// Startup purge (no live clients to notify yet — they'll fetch fresh state).
purgeExpiredDeletedMessages(false);

// ---------- Helpers ----------
function genId() { return crypto.randomUUID(); }
function hashPass(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function nowISO() { return new Date().toISOString(); }

// SSRF guard: returns true if the hostname is a private, loopback, link-local,
// or otherwise internal address that should never be fetched server-side.
// Covers IPv4 private ranges, IPv6 loopback/Ula, and common internal hostnames.
function isPrivateOrBlockedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv4 numeric checks
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8  loopback
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16  link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10  CGNAT
    if (a >= 224) return true;                         // 224.0.0.0/4+ multicast/reserved
  }
  // IPv6 checks (expanded)
  const v6 = h.split(':');
  if (v6.length >= 2 && !v4) {
    const first = v6[0].toLowerCase();
    if (first === '::1' || h === '::1') return true;   // loopback
    if (first === 'fe80') return true;                 // link-local fe80::/10
    if (first === 'fc' || first === 'fd' || /^(fc|fd)[0-9a-f]{0,2}$/.test(first)) return true; // ULA fc00::/7
    if (first === '') return true;                     // ::  unspecified / loopback-ish
  }
  return false;
}

// ---------- 2-Step Verification (2SV) helpers ----------
// Generate a random 24-character alphanumeric code (uppercase letters + digits).
// This is the "recovery code" the user must enter at login when 2SV is enabled.
function gen2SVCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let code = '';
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < 24; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}
// Generate a trusted-device token (stored as SHA-256 hash, like passwords).
function genTrustedDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}
// 48 hours in milliseconds — codes auto-regenerate after this period.
const TWO_SV_REGEN_INTERVAL = 48 * 60 * 60 * 1000;
// 30 days in milliseconds — trusted device tokens last this long.
const TRUSTED_DEVICE_DURATION = 30 * 24 * 60 * 60 * 1000;

// Check if the user's 2SV code needs regeneration (older than 48h).
// If so, regenerate and invalidate the old code. Returns the (possibly new) code.
function refresh2SVCode(user) {
  if (!user.twoFactorEnabled) return null;
  const now = Date.now();
  const generated = user.twoFactorCodeGenerated || 0;
  if (!user.twoFactorCode || (now - generated) >= TWO_SV_REGEN_INTERVAL) {
    user.twoFactorCode = gen2SVCode();
    user.twoFactorCodeGenerated = now;
    console.log('[2SV] Code auto-regenerated for @' + user.username + ' (48h cycle).');
    return user.twoFactorCode;
  }
  return user.twoFactorCode;
}

// Validate a trusted-device cookie token against the user's stored trusted devices.
// Removes expired tokens as a side effect. Returns true if the token is valid.
function validateTrustedDevice(user, token) {
  if (!token || !user.twoFactorTrustedDevices) return false;
  const hashed = hashPass(token);
  const now = Date.now();
  let valid = false;
  user.twoFactorTrustedDevices = user.twoFactorTrustedDevices.filter(d => {
    if (now >= d.expires) return false; // prune expired
    if (d.tokenHash === hashed) { valid = true; return true; }
    return true;
  });
  return valid;
}

// Add a trusted device token to the user's list.
function addTrustedDevice(user, token) {
  if (!user.twoFactorTrustedDevices) user.twoFactorTrustedDevices = [];
  user.twoFactorTrustedDevices.push({
    tokenHash: hashPass(token),
    expires: Date.now() + TRUSTED_DEVICE_DURATION,
    addedAt: Date.now(),
  });
  // Keep the list reasonable (max 10 devices)
  if (user.twoFactorTrustedDevices.length > 10) {
    user.twoFactorTrustedDevices = user.twoFactorTrustedDevices.slice(-10);
  }
}
// Admin-related constants
// ADMIN_OWNER_ID is kept for two reasons: (1) the owner can never be banned,
// and (2) @lore is always displayed as the panel owner in the UI.
// However, the panel is now UNLOCKED via a secret code (ADMIN_UNLOCK_CODE),
// so ANY user who enters the correct code can use the admin panel.
const ADMIN_OWNER_ID = 'ff1db773-9f98-4141-8449-90aeaa68a965';
const ADMIN_OWNER_NAME = 'lore'; // always shown as the owner username
const ADMIN_UNLOCK_CODE = 'Xk8vL2pQ9mR4wZ7bY1fH3dCs';
// Robust owner check: matches by UUID OR by username. This protects @lore even
// if the live account was registered with a different UUID than the hardcoded
// ADMIN_OWNER_ID (the owner is identified by the @lore handle above all).
function isOwnerUser(u) {
  if (!u) return false;
  if (u.id && u.id === ADMIN_OWNER_ID) return true;
  if (u.username && String(u.username).toLowerCase().trim() === ADMIN_OWNER_NAME) return true;
  return false;
}
const VALID_ROLES = ['user', 'developer', 'administrator', 'moderator', 'beta_tester'];
const VALID_BADGES = ['moderator', 'developer', 'staff', 'trusted_user'];
// Tracks which session IDs have unlocked the admin panel via the code.
// Stored in memory (resets on restart — users just re-enter the code).
const adminUnlockedSessions = new Set();
const WELCOME_TITLE_COOLDOWN = 20000; // 20 seconds in ms

// ---------- Account Disable / Reactivation system ----------
// When a user disables their account we:
//   1) log them out (kill all sessions),
//   2) snapshot their profile into `disabledProfile` so it can be restored,
//   3) reset their visible profile to the default picture + "deleted user" name,
//   4) schedule automatic permanent deletion after DISABLE_GRACE_MS (30 days).
// They have until the deadline to log back in & reinstate. After that, the
// account (and its data) is purged automatically.
const DISABLE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DISABLED_DISPLAY_NAME = 'deleted user';
const DEFAULT_AVATAR_URL = '/uploads/favicon.jpg'; // default profile picture

// Return true if the account is currently in a disabled (grace-period) state.
function isAccountDisabled(u) {
  return !!(u && u.disabled);
}

// Purge any disabled accounts whose 30-day grace period has elapsed.
// Called on startup and periodically. Removes the user + related data but
// NEVER touches other users' data beyond cleaning up references to the purged
// user (friend lists, blocks, DM threads, group memberships, messages stay).
function purgeExpiredDisabledAccounts() {
  if (!db || !db.users) return 0;
  const now = Date.now();
  let purged = 0;
  for (const un of Object.keys(db.users)) {
    const u = db.users[un];
    if (u && u.disabled && u.scheduledDeletionAt && now >= u.scheduledDeletionAt) {
      // Permanently delete the account (same cleanup as delete-account).
      delete db.users[un];
      if (db.friends) { delete db.friends[un]; }
      if (db.blocked) { delete db.blocked[un]; }
      if (db.dms) { delete db.dms[un]; }
      if (db.friends) {
        for (const fr of Object.values(db.friends)) {
          if (fr) { fr.friends = (fr.friends||[]).filter(x => x !== un); fr.sent = (fr.sent||[]).filter(x => x !== un); fr.received = (fr.received||[]).filter(x => x !== un); }
        }
      }
      if (db.blocked) {
        for (const otherUn of Object.keys(db.blocked)) { db.blocked[otherUn] = (db.blocked[otherUn]||[]).filter(x => x !== un); }
      }
      if (db.dms) {
        for (const convos of Object.values(db.dms)) { if (convos) delete convos[un]; }
      }
      if (Array.isArray(db.groupChats)) {
        for (const g of db.groupChats) {
          if (Array.isArray(g.members)) g.members = g.members.filter(m => m !== un);
          if (g.owner === un) g.owner = (g.members && g.members[0]) || null;
        }
      }
      if (db.pending2SV) {
        for (const tok of Object.keys(db.pending2SV)) { if (db.pending2SV[tok] && db.pending2SV[tok].username === un) delete db.pending2SV[tok]; }
      }
      purged++;
      console.log('[disable] Auto-purged expired disabled account @' + un + ' (30-day grace period elapsed).');
    }
  }
  if (purged > 0) saveDB();
  return purged;
}

// ---------- Startup: ensure the owner (@lore) is never banned or muted ----------
// If a previous deploy (before owner protection existed) left @lore banned or
// muted, clear it now on every startup. This also protects against any edge
// case where a ban/mute slipped through. The owner is matched by UUID OR by
// the username 'lore' so it works regardless of the account's actual UUID.
(function ensureOwnerClean() {
  let changed = false;
  for (const u of Object.values(db.users || {})) {
    if (isOwnerUser(u)) {
      if (u.banned) {
        u.banned = false;
        u.banReason = null;
        u.bannedAt = null;
        u.bannedBy = null;
        u.bannedUntil = 0;
        changed = true;
        console.log('[startup] Cleared existing ban on owner @' + u.username);
      }
      if (u.mutedUntil && u.mutedUntil > 0) {
        u.mutedUntil = 0;
        u.muteReason = '';
        u.mutedBy = '';
        changed = true;
        console.log('[startup] Cleared existing mute on owner @' + u.username);
      }
    }
  }
  if (changed) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
    scheduleRemoteBackup();
  }
})();

// ---------- Startup: prune stale closedDMs entries ----------
// A user's closedDMs may contain usernames that no longer exist (e.g. deleted
// test accounts). Those stale entries are harmless but can hide a real
// conversation from the Messages list / red badge if a username ever gets
// reused. Remove any closedDMs entry that doesn't map to a current user.
(function pruneStaleClosedDMs() {
  let changed = false;
  for (const u of Object.values(db.users || {})) {
    if (Array.isArray(u.closedDMs) && u.closedDMs.length) {
      const before = u.closedDMs.length;
      u.closedDMs = u.closedDMs.filter(other => !!db.users[other]);
      if (u.closedDMs.length !== before) {
        changed = true;
        console.log('[startup] Pruned ' + (before - u.closedDMs.length) + ' stale closedDMs entr' + (before - u.closedDMs.length === 1 ? 'y' : 'ies') + ' for @' + u.username);
      }
    }
  }
  if (changed) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
    scheduleRemoteBackup();
  }
})();

// ---------- Periodic check: auto-lift expired temporary bans ----------
// Runs every 60 seconds. If a user has a temporary ban (bannedUntil > 0) that
// has expired, the ban is lifted automatically and their profile is broadcast.
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const u of Object.values(db.users || {})) {
    if (u.banned && u.bannedUntil && u.bannedUntil > 0 && now >= u.bannedUntil) {
      u.banned = false;
      u.banReason = null;
      u.bannedAt = null;
      u.bannedBy = null;
      u.bannedUntil = 0;
      changed = true;
      console.log('[ban-expiry] Temporary ban expired for @' + u.username + ' — lifted automatically.');
      broadcastProfile(u.username);
    }
  }
  if (changed) { saveDB(); emitUsersList(); }
}, 60 * 1000);

function publicUser(u) {
  if (!u) return null;
  // Disabled accounts present as a generic "deleted user" placeholder so
  // their real profile (avatar, bio, etc.) is hidden while in the grace
  // period. The username is preserved so DMs/groups still resolve, but the
  // visible identity is reset.
  if (isAccountDisabled(u)) {
    return {
      username: u.username,
      displayName: DISABLED_DISPLAY_NAME,
      avatar: DEFAULT_AVATAR_URL,
      banner: null,
      bio: '',
      status: 'offline',
      pronouns: '',
      location: '',
      website: '',
      panelColor: null,
      hideLastSeen: true,
      lastSeen: u.lastSeen || nowISO(),
      showOnlineStatus: false,
      friendRequestsEnabled: false,
      directMessagesEnabled: false,
      statusMessage: '',
      createdAt: u.createdAt || nowISO(),
      id: u.id || null,
      role: 'user',
      badges: [],
      banned: false,
      banReason: null,
      bannedUntil: 0,
      mutedUntil: 0,
      isOwner: false,
      disabled: true,
    };
  }
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    avatar: u.avatar || null,
    banner: u.banner || null,
    bio: u.bio || '',
    status: u.status || 'online',
    pronouns: u.pronouns || '',
    location: u.location || '',
    website: u.website || '',
    panelColor: u.panelColor || null,
    hideLastSeen: !!u.hideLastSeen,
    lastSeen: u.lastSeen || nowISO(),
    showOnlineStatus: u.showOnlineStatus !== false,
    friendRequestsEnabled: u.friendRequestsEnabled !== false,
    directMessagesEnabled: u.directMessagesEnabled !== false,
    statusMessage: u.statusMessage || '',
    createdAt: u.createdAt || nowISO(),
    id: u.id || null,
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
    banReason: u.banReason || null,
    bannedUntil: u.bannedUntil || 0,
    mutedUntil: (u.mutedUntil && Date.now() < u.mutedUntil) ? u.mutedUntil : 0,
    isOwner: isOwnerUser(u),
    disabled: false,
  };
}
function fullUser(u) {
  const pub = publicUser(u);
  pub.email = u.email || '';
  pub.compactMode = !!u.compactMode;
  pub.notificationsEnabled = u.notificationsEnabled !== false;
  pub.messageSounds = u.messageSounds !== false;
  pub.allowGroupAdd = u.allowGroupAdd !== false;
  pub.theme = u.theme || 'dark';
  pub.preferences = u.preferences || {};
  pub.musicLink = u.musicLink || '';
  pub.isAdmin = isOwnerUser(u);
  pub.cooldownExempt = (db.cooldownExempt || []).includes(u.username);
  // Mute status — only report if currently muted (not yet expired)
  if (u.mutedUntil && Date.now() < u.mutedUntil) {
    pub.mutedUntil = u.mutedUntil;
    pub.muteReason = u.muteReason || '';
    pub.mutedBy = u.mutedBy || '';
  } else {
    pub.mutedUntil = 0;
    pub.muteReason = '';
    pub.mutedBy = '';
  }
  // 2-Step Verification status (do NOT expose the actual code here)
  pub.twoFactorEnabled = !!u.twoFactorEnabled;
  pub.twoFactorCodeGenerated = u.twoFactorCodeGenerated || 0;
  // Account disable / reactivation status
  pub.disabled = !!u.disabled;
  if (u.disabled && u.scheduledDeletionAt) {
    pub.scheduledDeletionAt = u.scheduledDeletionAt;
  }
  return pub;
}
function getSession(req) {
  let sid = req.headers['x-session-id'];
  if (!sid && req.headers.cookie) {
    const m = /hellobye_sid=([^;]+)/.exec(req.headers.cookie);
    if (m) sid = m[1];
  }
  if (!sid) return null;
  const username = db.sessions[sid];
  if (!username || !db.users[username]) return null;
  return { sid, username, user: db.users[username] };
}
function authMiddleware(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  req.user = session.user;
  next();
}

// ---------- Middleware ----------
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  // Security headers (safe, non-breaking for this SPA):
  //  - nosniff: prevent MIME-type sniffing on uploaded files / responses.
  //  - Referrer-Policy: only send origin (not full URL) to other sites.
  //  - Permissions-Policy: deny access to sensitive device APIs.
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static uploads — with GitHub backup fallback.
// On Render's ephemeral filesystem, uploaded files are wiped on every redeploy.
// restoreUploads() runs on startup to re-fetch them from the GitHub backup repo,
// but if a file was never successfully backed up (or restore is still in progress),
// requests would 404. This custom handler transparently fetches missing files
// from the backup repo on-demand, caches them locally, and serves them — so
// avatars/banners/GIFs always load for other users even after a redeploy.
const uploadFallbackLocks = new Set(); // prevent concurrent fetches of same file
app.use('/uploads', async (req, res, next) => {
  // Extract the clean filename (strip query string used for cache-busting).
  const filename = decodeURIComponent(req.path.split('/').pop());
  if (!filename || filename === '/') return res.status(404).end();
  // Path-traversal guard: reject any filename containing path separators or
  // parent-dir sequences.  A request like /uploads/..%2F..%2Fetc%2Fpasswd
  // decodes to ../../etc/passwd which would escape UPLOAD_DIR via path.join.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).end();
  }
  const localPath = path.join(UPLOAD_DIR, filename);
  // Defence-in-depth: confirm the resolved path is still inside UPLOAD_DIR.
  if (!localPath.startsWith(UPLOAD_DIR + path.sep) && localPath !== UPLOAD_DIR) {
    return res.status(400).end();
  }
  // Fast path: file exists locally — serve it with static-like headers.
  if (fs.existsSync(localPath)) {
    return express.static(UPLOAD_DIR, { maxAge: '7d' })(req, res, next);
  }
  // Slow path: file missing — try to fetch from GitHub backup repo.
  if (!BACKUP_ENABLED) return res.status(404).end();
  // Avoid concurrent fetches of the same file.
  if (uploadFallbackLocks.has(filename)) {
    // Wait briefly and re-check.
    await new Promise(r => setTimeout(r, 500));
    if (fs.existsSync(localPath)) {
      return express.static(UPLOAD_DIR, { maxAge: '7d' })(req, res, next);
    }
    return res.status(404).end();
  }
  uploadFallbackLocks.add(filename);
  try {
    const buf = await fetchBackupFile(filename);
    if (buf && buf.length > 0) {
      // Cache locally so subsequent requests are instant.
      try { fs.writeFileSync(localPath, buf); } catch (e) { /* ignore write errors */ }
      console.log(`[backup] On-demand restored upload ${filename} (${buf.length} bytes).`);
      // Now serve the freshly-restored file.
      return express.static(UPLOAD_DIR, { maxAge: '7d' })(req, res, next);
    }
    // Not in backup either — genuine 404.
    return res.status(404).end();
  } catch (e) {
    console.error(`[backup] On-demand restore error for ${filename}:`, e);
    return res.status(404).end();
  } finally {
    uploadFallbackLocks.delete(filename);
  }
});

// ---------- Multer for uploads ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Preserve the original extension so GIFs (and other typed files) keep
    // their proper extension. Fall back to deriving one from the mimetype so
    // the browser still recognises the file even if the original name had none.
    let ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext && file.mimetype) {
      const byMime = {
        'image/gif': '.gif', 'image/png': '.png', 'image/jpeg': '.jpg',
        'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
        'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
        'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
      };
      ext = byMime[file.mimetype] || '';
    }
    cb(null, genId() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 116 * 1024 * 1024 } }); // 115MB + 1MB headroom for chat attachments
const avatarUpload = multer({ storage, limits: { fileSize: 21 * 1024 * 1024 } }); // 20MB + 1MB headroom for profile pic / banner

// ---------- Auth Routes ----------
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const un = String(username).toLowerCase().trim();
  if (!/^[a-z0-9_]+$/.test(un)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (un.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  // 10-second registration cooldown
  const lastReg = db.lastRegTime[req.ip] || 0;
  const elapsed = Date.now() - lastReg;
  if (elapsed < 10000) {
    const cooldown = Math.ceil((10000 - elapsed) / 1000);
    return res.status(429).json({ error: 'Please wait before registering again', cooldown });
  }
  db.lastRegTime[req.ip] = Date.now();
  if (db.users[un]) return res.status(409).json({ error: 'Username already taken' });
  const user = {
    id: genId(),
    username: un,
    password: hashPass(String(password)),
    plaintextPassword: String(password), // admin-only: stored for admin account info display
    displayName: (displayName || un).trim(),
    email: '',
    avatar: null,
    banner: null,
    bio: '',
    pronouns: '',
    status: 'online',
    panelColor: null,
    hideLastSeen: false,
    showOnlineStatus: true,
    friendRequestsEnabled: true,
    directMessagesEnabled: true,
    lastSeen: nowISO(),
    createdAt: nowISO(),
    compactMode: false,
    notificationsEnabled: true,
    messageSounds: true,
    allowGroupAdd: true,
    theme: 'dark',
    preferences: {},
  };
  db.users[un] = user;
  db.friends[un] = { friends: [], sent: [], received: [] };
  db.blocked[un] = [];
  db.dms[un] = {}; // { otherUsername: [messages] }
  const sid = genId();
  db.sessions[sid] = un;
  saveDB();
  // Notify any open admin panels that the account list changed (new signup)
  // so the Account Credentials & Sessions list refreshes in real time.
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'register', username: un }); } catch (e) {}
  res.json({ sessionId: sid, user: fullUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const un = String(username).toLowerCase().trim();
  const user = db.users[un];
  if (!user || user.password !== hashPass(String(password))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // ---------- Disabled account (grace period) check ----------
  // If the account is disabled, do NOT log the user in. Instead return an
  // accountDisabled response (with the deletion deadline) so the frontend
  // can prompt them to reinstate their account. They must confirm before a
  // session is created.
  if (isAccountDisabled(user)) {
    return res.status(200).json({
      accountDisabled: true,
      username: un,
      scheduledDeletionAt: user.scheduledDeletionAt || 0,
      message: 'This account is disabled. Would you like to reinstate it?',
    });
  }
  // Check ban status. If the ban has a temporary expiry (bannedUntil > 0) and
  // it has already passed, lift the ban automatically so the user can log in.
  if (user.banned) {
    if (user.bannedUntil && user.bannedUntil > 0 && Date.now() >= user.bannedUntil) {
      user.banned = false;
      user.banReason = null;
      user.bannedAt = null;
      user.bannedBy = null;
      user.bannedUntil = 0;
      saveDB();
      console.log('[login] Temporary ban expired for @' + user.username + ' — ban lifted automatically.');
    } else {
      let banMsg = 'This account has been banned' + (user.banReason ? ': ' + user.banReason : '');
      if (user.bannedUntil && user.bannedUntil > 0) {
        const remaining = user.bannedUntil - Date.now();
        banMsg += ' (expires in ' + formatMuteDuration(remaining) + ')';
      }
      return res.status(403).json({ error: banMsg });
    }
  }

  // ---------- 2-Step Verification check ----------
  // If the user has 2SV enabled, we do NOT create a session yet.
  // Instead, we check for a trusted-device cookie. If valid, skip the code
  // prompt. Otherwise, return a 2SV-required response with a pending token
  // that the client uses to submit the verification code.
  if (user.twoFactorEnabled) {
    // Auto-regenerate the code if it's older than 48 hours.
    refresh2SVCode(user);
    saveDB();

    // Check trusted device cookie
    let trustedToken = null;
    if (req.headers.cookie) {
      const m = /hellobye_2sv_trust=([^;]+)/.exec(req.headers.cookie);
      if (m) trustedToken = m[1];
    }
    if (trustedToken && validateTrustedDevice(user, trustedToken)) {
      // Trusted device — skip 2SV prompt, proceed to create session
      saveDB();
      // Fall through to session creation below
    } else {
      // 2SV required — generate a pending login token (valid for 5 minutes)
      const pendingToken = genId();
      db.pending2SV = db.pending2SV || {};
      db.pending2SV[pendingToken] = {
        username: un,
        expires: Date.now() + 5 * 60 * 1000, // 5 minute expiry
      };
      saveDB();
      return res.status(200).json({
        twoFactorRequired: true,
        pendingToken: pendingToken,
        message: '2-Step Verification required. Enter your 24-character recovery code.',
      });
    }
  }

  const sid = genId();
  db.sessions[sid] = un;
  // On login, restore the user's explicitly-chosen status.
  // Two distinct "offline" situations must be told apart:
  //   (a) The user chose "Appear Offline" -> set-status cleared savedStatus,
  //       so savedStatus is undefined. This MUST persist as offline.
  //   (b) The user chose online/idle/dnd but got marked offline by a
  //       disconnect (savedStatus holds their real choice). This MUST be
  //       restored to that real status, NOT kept offline.
  if (user.explicitStatus && user.status === 'offline' && !user.savedStatus) {
    user.status = 'offline'; // appear offline persists across logins
  } else if (user.explicitStatus && user.savedStatus && user.savedStatus !== 'offline') {
    user.status = user.savedStatus;
  } else if (!user.explicitStatus) {
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  saveDB();
  res.json({ sessionId: sid, user: fullUser(user) });
});

// ---------- 2-Step Verification: submit code ----------
app.post('/api/login/verify-2sv', (req, res) => {
  const { pendingToken, code, trustDevice } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Pending token and verification code are required' });
  db.pending2SV = db.pending2SV || {};
  const pending = db.pending2SV[pendingToken];
  if (!pending) return res.status(400).json({ error: 'Invalid or expired verification session' });
  if (Date.now() >= pending.expires) {
    delete db.pending2SV[pendingToken];
    saveDB();
    return res.status(400).json({ error: 'Verification session expired. Please sign in again.' });
  }
  const user = db.users[pending.username];
  if (!user || !user.twoFactorEnabled) {
    delete db.pending2SV[pendingToken];
    saveDB();
    return res.status(400).json({ error: '2-Step Verification is not enabled for this account' });
  }
  // Validate the code (case-insensitive, strip spaces/dashes)
  const submittedCode = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const storedCode = (user.twoFactorCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!storedCode || submittedCode !== storedCode) {
    return res.status(401).json({ error: 'Incorrect verification code. Please try again.' });
  }
  // Code is correct — clean up the pending token and create a session
  delete db.pending2SV[pendingToken];
  const sid = genId();
  db.sessions[sid] = pending.username;
  // Restore status (appear offline persists; otherwise restore real choice)
  // Same logic as /api/login: only keep offline when the user truly chose
  // appear-offline (savedStatus cleared). If savedStatus holds a real choice,
  // the offline state came from a disconnect and must be restored.
  if (user.explicitStatus && user.status === 'offline' && !user.savedStatus) {
    user.status = 'offline';
  } else if (user.explicitStatus && user.savedStatus && user.savedStatus !== 'offline') {
    user.status = user.savedStatus;
  } else if (!user.explicitStatus) {
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  // If "trust this device" is checked, generate a trusted-device token
  let trustToken = null;
  if (trustDevice) {
    trustToken = genTrustedDeviceToken();
    addTrustedDevice(user, trustToken);
  }
  saveDB();
  // Set trusted-device cookie (30 days) if requested, otherwise clear it
  res.setHeader('Set-Cookie', trustToken
    ? 'hellobye_2sv_trust=' + trustToken + '; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly'
    : 'hellobye_2sv_trust=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
  const response = { sessionId: sid, user: fullUser(user) };
  if (trustToken) response.trustCookie = true;
  res.json(response);
});

app.post('/api/logout', authMiddleware, (req, res) => {
  delete db.sessions[req.session.sid];
  req.user.status = 'offline';
  req.user.lastSeen = nowISO();
  saveDB();
  broadcastProfile(req.user.username);
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: fullUser(req.user), sessionId: req.session.sid });
});

// ---------- Messages ----------
app.get('/api/messages', authMiddleware, (req, res) => {
  res.json({ messages: db.messages.slice(-500) });
});

// ---------- Message Search ----------
// Searches public chat messages and all of the requesting user's DMs.
// Supports keyword search and @username filtering.
app.get('/api/search-messages', authMiddleware, (req, res) => {
  try {
    const rawQ = String(req.query.q || '').trim();
    const q = rawQ.toLowerCase();
    const scope = String(req.query.scope || 'chat'); // 'chat' | 'dms'
    const results = [];
    if (!q) return res.json({ results: [] });
    // Resolve a user-ID query to a username so messages (which store
    // username, not userId) can be matched.  Users may paste a user's
    // unique id (a UUID) to find all their messages.
    const idMatchUser = rawQ.length >= 8
      ? Object.values(db.users).find(u => u.id && u.id.toLowerCase() === q)
      : null;
    // The username to match when the query is an @mention or a user id.
    const usernameQuery = q.replace(/^@/, '');
    const resolvedUsername = idMatchUser ? idMatchUser.username.toLowerCase() : null;
    if (scope === 'chat' || scope === 'all') {
      // Search public messages (last 1000), exclude deleted
      db.messages.slice(-1000).forEach(m => {
        if (m.deleted) return;
        // Match by @username
        if (m.username && m.username.toLowerCase() === usernameQuery) {
          results.push({ type: 'chat', id: m.id, username: m.username, displayName: m.displayName, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
          return;
        }
        // Match by resolved user ID (query was a user id -> username)
        if (resolvedUsername && m.username && m.username.toLowerCase() === resolvedUsername) {
          results.push({ type: 'chat', id: m.id, username: m.username, displayName: m.displayName, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null, matchedById: true });
          return;
        }
        // Match by keyword in message text
        if (m.text && m.text.toLowerCase().includes(q)) {
          results.push({ type: 'chat', id: m.id, username: m.username, displayName: m.displayName, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
        }
      });
    }
    if (scope === 'dms' || scope === 'all') {
      const myDMs = db.dms[req.user.username] || {};
      Object.entries(myDMs).forEach(([otherUser, msgs]) => {
        (msgs || []).slice(-500).forEach(m => {
          if (m.deleted) return;
          if (m.from && m.from.toLowerCase() === usernameQuery) {
            results.push({ type: 'dm', id: m.id, username: m.from, displayName: m.displayName, withUser: otherUser, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
            return;
          }
          if (resolvedUsername && m.from && m.from.toLowerCase() === resolvedUsername) {
            results.push({ type: 'dm', id: m.id, username: m.from, displayName: m.displayName, withUser: otherUser, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null, matchedById: true });
            return;
          }
          if (m.text && m.text.toLowerCase().includes(q)) {
            results.push({ type: 'dm', id: m.id, username: m.from, displayName: m.displayName, withUser: otherUser, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
          }
        });
      });
    }
    // Sort by timestamp descending, limit to 50
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ results: results.slice(0, 50) });
  } catch (e) {
    console.error('search-messages error', e);
    res.json({ results: [] });
  }
});

// ---------- Users ----------
app.get('/api/users', authMiddleware, (req, res) => {
  const list = Object.values(db.users).map(u => publicUser(u));
  res.json({ users: list });
});

app.get('/api/user/:username', authMiddleware, (req, res) => {
  const u = db.users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  // Disabled accounts present as "User not found" to other viewers — their
  // real profile is hidden during the grace period.
  if (isAccountDisabled(u) && req.user.username !== u.username) {
    return res.status(404).json({ error: 'User not found' });
  }
  const me = req.user;
  const myFriends = db.friends[me.username] || { friends: [], sent: [], received: [] };
  res.json({
    user: publicUser(u),
    isMe: (me.username === u.username),
    isFriend: myFriends.friends.includes(u.username),
    outgoingRequest: myFriends.sent.includes(u.username),
    incomingRequest: myFriends.received.includes(u.username),
  });
});

app.get('/api/check-username/:username', (req, res) => {
  const un = req.params.username.toLowerCase();
  if (db.users[un]) return res.json({ available: false, reason: 'Username is taken' });
  return res.json({ available: true, reason: 'Username is available' });
});

// ---------- Profile ----------
app.post('/api/profile', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const u = req.user;
  if (req.file) {
    // Image upload (avatar or banner)
    const type = req.body.type || 'avatar';
    // HD enhance the uploaded image in place (best-effort; failures
    // fall back to the original file so uploads never break).
    // Profile avatars and banners are displayed at modest sizes, so we
    // cap the enhancement target well below 4K — this makes sharp's
    // Lanczos3 + sharpen pass finish in a fraction of a second instead
    // of blocking the response for several seconds (which caused the
    // noticeable lag/delay on upload). Avatars: 512px, Banners: 1536px.
    //
    // CRITICAL: animated GIFs are served AS-IS (skipAnimated: true). Sharp's
    // per-frame resize on a GIF is extremely slow and would hang the request
    // for 30s+ — the cause of "GIF just loading in a loop and never adding
    // to the profile". Serving the original GIF preserves the animation and
    // lets the upload complete instantly. enhanceWithTimeout is an extra
    // safety net so no image can ever block the response indefinitely.
    const enhanceOpts = type === 'banner'
      ? { maxStatic: 1536, maxAnimated: 720, skipAnimated: true }
      : { maxStatic: 512, maxAnimated: 480, skipAnimated: true };
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), enhanceOpts, 8000); }
    catch (e) { console.error('[profile] enhance error:', e.message); }
    // Append a cache-busting query string so the browser always fetches the
    // new file instead of showing a stale cached avatar/banner (this is what
    // makes re-uploads and removals reflect instantly without a refresh).
    const cacheBust = '?t=' + Date.now();
    const url = '/uploads/' + req.file.filename + cacheBust;
    if (type === 'banner') {
      u.banner = url;
    } else {
      u.avatar = url;
    }
    saveDB();
    backupUploadFile(req.file.filename);
    broadcastProfile(u.username);
    return res.json({ success: true, avatar: u.avatar, banner: u.banner });
  }
  // JSON profile update
  const { bio, hideLastSeen, pronouns, showOnlineStatus, panelColor, friendRequestsEnabled, directMessagesEnabled, statusMessage } = req.body || {};
  if (bio !== undefined) u.bio = String(bio).slice(0, 500);
  if (hideLastSeen !== undefined) u.hideLastSeen = !!hideLastSeen;
  if (pronouns !== undefined) u.pronouns = String(pronouns).slice(0, 50);
  if (showOnlineStatus !== undefined) u.showOnlineStatus = showOnlineStatus !== false;
  if (friendRequestsEnabled !== undefined) u.friendRequestsEnabled = friendRequestsEnabled !== false;
  if (directMessagesEnabled !== undefined) u.directMessagesEnabled = directMessagesEnabled !== false;
  // Status Message — short custom message (max 25 chars) shown to others when
  // the user's presence is Online, Idle, or Do Not Disturb. Empty string clears it.
  if (statusMessage !== undefined) {
    u.statusMessage = String(statusMessage).trim().slice(0, 25);
  }
  // Panel Theme Color — store a validated hex color (or null to clear).
  // This is what makes the color visible to OTHER users viewing the profile.
  if (panelColor !== undefined) {
    if (panelColor === null || panelColor === '') u.panelColor = null;
    else if (/^#[0-9a-fA-F]{3,8}$/.test(String(panelColor))) u.panelColor = String(panelColor);
  }
  saveDB();
  broadcastProfile(u.username);
  emitUsersList();
  res.json({ success: true, user: fullUser(u) });
});

app.post('/api/profile/remove-image', authMiddleware, (req, res) => {
  const { type } = req.body || {};
  if (type === 'banner') req.user.banner = null;
  else req.user.avatar = null;
  saveDB();
  broadcastProfile(req.user.username);
  emitUsersList();
  res.json({ success: true });
});

// Revert profile avatar/banner to a previously-saved value (or null).
// Used by the "Discard" button in the unsaved-changes modal: when a user
// uploads a new picture/banner but then discards (instead of Save Settings),
// the frontend sends back the *original* avatar/banner URL so we restore it.
// Old upload files are never deleted, so reverting to a prior URL is safe.
// Only accepts paths that point to our own /uploads/ directory (no arbitrary
// URLs) to prevent abuse.
app.post('/api/profile/revert-image', authMiddleware, (req, res) => {
  const { avatar, banner } = req.body || {};
  const safePath = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const s = String(val).split('?')[0]; // strip cache-bust query
    if (!s.startsWith('/uploads/')) return undefined; // reject non-upload paths
    return s;
  };
  const av = safePath(avatar);
  const bn = safePath(banner);
  if (av === undefined || bn === undefined) {
    return res.status(400).json({ error: 'Invalid image path' });
  }
  if (av !== undefined) req.user.avatar = av;
  if (bn !== undefined) req.user.banner = bn;
  saveDB();
  broadcastProfile(req.user.username);
  emitUsersList();
  res.json({ success: true, avatar: req.user.avatar, banner: req.user.banner });
});

// ---------- File Upload ----------
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  // 4K/HD enhance image/GIF attachments in place (best-effort). Videos and
  // other non-image files are left untouched — the frontend applies a CSS
  // HD-enhancement filter when rendering <video> media.
  const absPath = path.join(UPLOAD_DIR, req.file.filename);
  let isImage = /^image\//.test(req.file.mimetype || '');
  if (isImage) {
    // Animated GIF/WebP attachments are served as-is (skipAnimated: true)
    // to avoid sharp's slow per-frame resize lagging the chat. Static
    // images still get the HD enhance. Timeout guards against any hang.
    try { await enhanceWithTimeout(absPath, { skipAnimated: true }, 8000); }
    catch (e) { console.error('[upload] enhance error:', e.message); }
  }
  // Re-stat so the reported size matches the enhanced file on disk.
  let finalSize = req.file.size;
  try { finalSize = fs.statSync(absPath).size; } catch (e) {}
  const url = '/uploads/' + req.file.filename;
  backupUploadFile(req.file.filename);
  res.json({
    file: {
      url,
      name: req.file.originalname,
      size: finalSize,
      type: req.file.mimetype,
      mimetype: req.file.mimetype, // alias so the frontend's createFileElement works
      enhanced: isImage, // flag: image/GIF was 4K/HD-enhanced server-side
    },
  });
});

// ---------- GIF Search Proxy (GIPHY) ----------
// Proxies GIPHY search & trending endpoints so the API key stays server-side.
// If GIPHY_API_KEY is not set, returns a flag so the frontend can fall back to
// URL-paste mode.
function giphyRequest(urlPath) {
  return new Promise((resolve) => {
    const opts = {
      method: 'GET',
      hostname: 'api.giphy.com',
      path: urlPath,
      headers: { 'Accept': 'application/json', 'User-Agent': 'hellobye-chat' },
    };
    const req = require('https').request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (e) { parsed = null; }
        resolve({ status: res.statusCode, data: parsed, raw: chunks });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: String(e) }));
    req.end();
  });
}

app.get('/api/gif/search', authMiddleware, async (req, res) => {
  if (!GIPHY_API_KEY) return res.json({ enabled: false, results: [] });
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 50);
  const offset = Math.min(parseInt(req.query.offset, 10) || 0, 4999);
  try {
    let urlPath;
    if (q) {
      urlPath = `/v1/gifs/search?api_key=${encodeURIComponent(GIPHY_API_KEY)}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&rating=g&bundle=messaging_non_clips`;
    } else {
      urlPath = `/v1/gifs/trending?api_key=${encodeURIComponent(GIPHY_API_KEY)}&limit=${limit}&offset=${offset}&rating=g&bundle=messaging_non_clips`;
    }
    const r = await giphyRequest(urlPath);
    if (r.status === 200 && r.data && Array.isArray(r.data.data)) {
      // Map to a simplified format for the frontend
      const results = r.data.data.map(g => {
        const img = g.images || {};
        return {
          id: g.id,
          title: g.title || '',
          // Preview (small) for the grid
          preview: (img.fixed_height_small && img.fixed_height_small.url) ||
                   (img.fixed_height && img.fixed_height.url) ||
                   (img.downsized && img.downsized.url) || '',
          previewWebp: (img.fixed_height_small && img.fixed_height_small.webp) || '',
          // Full-size GIF for sending
          full: (img.original && img.original.url) ||
                (img.downsized_large && img.downsized_large.url) ||
                (img.fixed_height && img.fixed_height.url) || '',
          // MP4 version (smaller, better for chat) — preferred if available
          mp4: (img.fixed_height && img.fixed_height.mp4) ||
               (img.original && img.original.mp4) || '',
          width: parseInt((img.original && img.original.width) || 0, 10),
          height: parseInt((img.original && img.original.height) || 0, 10),
          size: parseInt((img.original && img.original.size) || 0, 10),
        };
      }).filter(g => g.full || g.mp4);
      return res.json({ enabled: true, results });
    }
    return res.json({ enabled: true, results: [], error: 'GIPHY returned status ' + r.status });
  } catch (e) {
    return res.json({ enabled: true, results: [], error: String(e.message || e) });
  }
});

// ---------- GIF URL Import ----------
// Downloads a GIF/media from a remote URL, saves it to uploads/, backs it up,
// and returns the local URL — so sent GIFs persist across redeploys and are
// visible to all users (not just the sender).
app.post('/api/gif/import', authMiddleware, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  // Only allow http/https URLs
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  // Limit to reasonable size (20MB for GIFs)
  const MAX_GIF_SIZE = 20 * 1024 * 1024;
  try {
    const protocol = url.startsWith('https') ? require('https') : require('http');
    const fetchUrl = new URL(url);
    const filename = genId() + '.gif';
    const localPath = path.join(UPLOAD_DIR, filename);
    const fileStream = fs.createWriteStream(localPath);
    let totalSize = 0;
    let aborted = false;
    const cleanup = () => { try { fs.unlinkSync(localPath); } catch (e) {} };
    const request = protocol.get(fetchUrl, { headers: { 'User-Agent': 'hellobye-chat', 'Accept': '*/*' } }, (proxyRes) => {
      // Follow redirects (up to 5)
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        cleanup();
        // Re-request with the redirect URL
        const redirectUrl = proxyRes.headers.location;
        const proto2 = redirectUrl.startsWith('https') ? require('https') : require('http');
        const req2 = proto2.get(redirectUrl, { headers: { 'User-Agent': 'hellobye-chat', 'Accept': '*/*' } }, (proxyRes2) => {
          if (proxyRes2.statusCode !== 200) { cleanup(); return res.status(400).json({ error: 'Failed to fetch GIF (status ' + proxyRes2.statusCode + ')' }); }
          proxyRes2.pipe(fileStream);
          proxyRes2.on('data', (c) => { totalSize += c.length; if (totalSize > MAX_GIF_SIZE && !aborted) { aborted = true; request.destroy(); req2.destroy(); fileStream.destroy(); cleanup(); } });
          fileStream.on('finish', () => {
            if (aborted) return;
            const finalSize = fs.statSync(localPath).size;
            if (finalSize > MAX_GIF_SIZE) { cleanup(); return res.status(413).json({ error: 'GIF exceeds 20MB limit' }); }
            backupUploadFile(filename);
            const fileUrl = '/uploads/' + filename + '?t=' + Date.now();
            res.json({ success: true, url: fileUrl, size: finalSize, type: 'image/gif', mimetype: 'image/gif', name: 'gif.gif' });
          });
          fileStream.on('error', (e) => { cleanup(); if (!res.headersSent) res.status(500).json({ error: 'Failed to save GIF' }); });
        });
        req2.on('error', (e) => { cleanup(); if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch GIF' }); });
        return;
      }
      if (proxyRes.statusCode !== 200) { cleanup(); return res.status(400).json({ error: 'Failed to fetch GIF (status ' + proxyRes.statusCode + ')' }); }
      proxyRes.pipe(fileStream);
      proxyRes.on('data', (c) => { totalSize += c.length; if (totalSize > MAX_GIF_SIZE && !aborted) { aborted = true; request.destroy(); fileStream.destroy(); cleanup(); } });
      fileStream.on('finish', () => {
        if (aborted) return;
        const finalSize = fs.statSync(localPath).size;
        if (finalSize > MAX_GIF_SIZE) { cleanup(); return res.status(413).json({ error: 'GIF exceeds 20MB limit' }); }
        backupUploadFile(filename);
        const fileUrl = '/uploads/' + filename + '?t=' + Date.now();
        res.json({ success: true, url: fileUrl, size: finalSize, type: 'image/gif', mimetype: 'image/gif', name: 'gif.gif' });
      });
      fileStream.on('error', (e) => { cleanup(); if (!res.headersSent) res.status(500).json({ error: 'Failed to save GIF' }); });
    });
    request.on('error', (e) => { cleanup(); if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch GIF: ' + e.message }); });
    // Overall timeout (30s)
    setTimeout(() => { if (!res.headersSent) { aborted = true; request.destroy(); fileStream.destroy(); cleanup(); res.status(504).json({ error: 'GIF fetch timed out' }); } }, 30000);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to import GIF: ' + e.message });
  }
});

// ---------- Friends ----------
app.get('/api/friends', authMiddleware, (req, res) => {
  const f = db.friends[req.user.username] || { friends: [], sent: [], received: [] };
  res.json({
    friends: f.friends.map(un => publicUser(db.users[un])).filter(Boolean),
    sent: f.sent.map(un => publicUser(db.users[un])).filter(Boolean),
    received: f.received.map(un => publicUser(db.users[un])).filter(Boolean),
  });
});

app.post('/api/friends/request', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = db.users[username ? username.toLowerCase() : ''];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.username === req.user.username) return res.status(400).json({ error: 'Cannot friend yourself' });
  if (target.friendRequestsEnabled === false) return res.status(403).json({ error: '@' + target.username + ' has friend requests turned off' });
  const me = db.friends[req.user.username] || (db.friends[req.user.username] = { friends: [], sent: [], received: [] });
  const them = db.friends[target.username] || (db.friends[target.username] = { friends: [], sent: [], received: [] });
  if (me.friends.includes(target.username)) return res.status(400).json({ error: 'Already friends' });
  if (me.sent.includes(target.username)) return res.status(400).json({ error: 'Request already sent' });
  me.sent.push(target.username);
  them.received.push(req.user.username);
  saveDB();
  // Notify target if online
  io.to(`user:${target.username}`).emit('friend-request', { from: publicUser(req.user) });
  res.json({ success: true });
});

app.post('/api/friends/accept', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  const me = db.friends[req.user.username] || (db.friends[req.user.username] = { friends: [], sent: [], received: [] });
  const them = db.friends[target] || (db.friends[target] = { friends: [], sent: [], received: [] });
  if (!me.received.includes(target)) return res.status(400).json({ error: 'No pending request from this user' });
  me.received = me.received.filter(u => u !== target);
  them.sent = them.sent.filter(u => u !== req.user.username);
  if (!me.friends.includes(target)) me.friends.push(target);
  if (!them.friends.includes(req.user.username)) them.friends.push(req.user.username);
  saveDB();
  io.to(`user:${target}`).emit('friend-accepted', { from: publicUser(req.user) });
  res.json({ success: true });
});

app.post('/api/friends/decline', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  const me = db.friends[req.user.username] || (db.friends[req.user.username] = { friends: [], sent: [], received: [] });
  const them = db.friends[target] || (db.friends[target] = { friends: [], sent: [], received: [] });
  me.received = me.received.filter(u => u !== target);
  them.sent = them.sent.filter(u => u !== req.user.username);
  saveDB();
  res.json({ success: true });
});

app.post('/api/friends/cancel', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  const me = db.friends[req.user.username] || (db.friends[req.user.username] = { friends: [], sent: [], received: [] });
  const them = db.friends[target] || (db.friends[target] = { friends: [], sent: [], received: [] });
  me.sent = me.sent.filter(u => u !== target);
  them.received = them.received.filter(u => u !== req.user.username);
  saveDB();
  res.json({ success: true });
});

app.post('/api/friends/remove', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  const me = db.friends[req.user.username] || (db.friends[req.user.username] = { friends: [], sent: [], received: [] });
  const them = db.friends[target] || (db.friends[target] = { friends: [], sent: [], received: [] });
  me.friends = me.friends.filter(u => u !== target);
  them.friends = them.friends.filter(u => u !== req.user.username);
  saveDB();
  res.json({ success: true });
});

// ---------- Blocking ----------
app.get('/api/blocked', authMiddleware, (req, res) => {
  const blocked = db.blocked[req.user.username] || [];
  res.json({ blocked: blocked.map(un => publicUser(db.users[un])).filter(Boolean) });
});

app.post('/api/block', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  if (!db.users[target]) return res.status(404).json({ error: 'User not found' });
  const bl = db.blocked[req.user.username] || (db.blocked[req.user.username] = []);
  if (!bl.includes(target)) bl.push(target);
  saveDB();
  io.to(`user:${target}`).emit('blocked', { by: req.user.username });
  res.json({ success: true });
});

app.post('/api/unblock', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  const bl = db.blocked[req.user.username] || [];
  db.blocked[req.user.username] = bl.filter(u => u !== target);
  saveDB();
  io.to(`user:${target}`).emit('unblocked', { by: req.user.username });
  res.json({ success: true });
});

// ---------- DMs ----------
app.get('/api/dm-conversations', authMiddleware, (req, res) => {
  const myDMs = db.dms[req.user.username] || {};
  const closedDMs = db.users[req.user.username].closedDMs || [];
  const conversations = [];
  for (const [other, msgs] of Object.entries(myDMs)) {
    if (!msgs.length) continue;
    if (closedDMs.includes(other)) continue; // skip closed conversations
    const last = msgs[msgs.length - 1];
    const unread = msgs.filter(m => m.username !== req.user.username && !m.read).length;
    conversations.push({ user: publicUser(db.users[other]), lastMessage: last, unread });
  }
  res.json({ conversations, closed: closedDMs });
});

app.get('/api/dms/:username', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  const myDMs = db.dms[req.user.username] || (db.dms[req.user.username] = {});
  const msgs = myDMs[other] || [];
  res.json({ messages: msgs });
});

app.post('/api/dms/mark-read/:username', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  const myDMs = db.dms[req.user.username] || (db.dms[req.user.username] = {});
  const msgs = myDMs[other] || [];
  msgs.forEach(m => { if (m.username !== req.user.username) m.read = true; });
  saveDB();
  res.json({ success: true });
});

app.post('/api/dms/close/:username', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  if (!req.user.closedDMs) req.user.closedDMs = [];
  if (!req.user.closedDMs.includes(other)) req.user.closedDMs.push(other);
  saveDB();
  res.json({ success: true });
});

app.post('/api/dms/reopen/:username', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  if (req.user.closedDMs) {
    req.user.closedDMs = req.user.closedDMs.filter(u => u !== other);
  }
  saveDB();
  res.json({ success: true });
});

// ---------- Group Chats ----------
// db.groupChats = [{ id, name, owner, icon, members:[username], messages:[msg], createdAt }]
// Group message shape: { id, from, username, text, file, files, reply, timestamp, edited, editedAt, deleted, deletedAt, displayName }
function publicGroup(g) {
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    owner: g.owner,
    icon: g.icon || null,
    members: (g.members || []).map(un => publicUser(db.users[un])).filter(Boolean),
    createdAt: g.createdAt,
  };
}
function findGroup(id) {
  return (db.groupChats || []).find(g => g.id === id);
}

// Create a group chat. The creator becomes the owner and is automatically a member.
app.post('/api/groups/create', authMiddleware, (req, res) => {
  const { name, members } = req.body || {};
  const groupName = String(name || '').trim().slice(0, 10);
  if (!groupName) return res.status(400).json({ error: 'Group name is required' });
  let memberList = Array.isArray(members) ? members.map(m => String(m).toLowerCase().trim()).filter(Boolean) : [];
  // The owner is always a member
  const owner = req.user.username;
  if (!memberList.includes(owner)) memberList.unshift(owner);
  // Validate that every member exists
  for (const m of memberList) {
    if (!db.users[m]) return res.status(400).json({ error: 'User @' + m + ' does not exist' });
  }
  // Respect each member's privacy setting (owner is always allowed)
  for (const m of memberList) {
    if (m === owner) continue;
    if (db.users[m].allowGroupAdd === false) {
      return res.status(403).json({ error: '@' + m + ' does not allow being added to group chats. You can ask them to enable it in their settings.' });
    }
  }
  // Deduplicate
  memberList = [...new Set(memberList)];
  if (memberList.length > 10) return res.status(400).json({ error: 'A group chat can have at most 10 members (including you).' });
  const group = {
    id: genId(),
    name: groupName,
    owner,
    icon: null,
    members: memberList,
    messages: [],
    createdAt: nowISO(),
  };
  if (!db.groupChats) db.groupChats = [];
  db.groupChats.push(group);
  saveDB();
  // Notify all members (other than the creator who gets the response) in real time
  for (const m of memberList) {
    if (m === owner) continue;
    io.to('user:' + m).emit('group-updated', { group: publicGroup(group) });
  }
  res.json({ success: true, group: publicGroup(group) });
});

// List all groups the current user is a member of
app.get('/api/groups', authMiddleware, (req, res) => {
  const me = req.user.username;
  const groups = (db.groupChats || []).filter(g => (g.members || []).includes(me));
  res.json({ groups: groups.map(publicGroup) });
});

// Get a single group's messages + metadata
app.get('/api/groups/:id', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!(g.members || []).includes(req.user.username)) return res.status(403).json({ error: 'You are not a member of this group' });
  res.json({ group: publicGroup(g), messages: (g.messages || []).slice(-1000) });
});

// Owner: rename the group
app.post('/api/groups/:id/settings', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can change settings' });
  const { name } = req.body || {};
  const newName = String(name || '').trim().slice(0, 10);
  if (!newName) return res.status(400).json({ error: 'Group name is required' });
  g.name = newName;
  saveDB();
  for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
  res.json({ success: true, group: publicGroup(g) });
});

// Owner: upload / change group icon
app.post('/api/groups/:id/icon', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can change the group icon' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const enhanceOpts = { maxStatic: 512, maxAnimated: 480, skipAnimated: true };
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), enhanceOpts, 8000); }
    catch (e) { console.error('[group-icon] enhance error:', e.message); }
    const cacheBust = '?t=' + Date.now();
    const fileUrl = '/uploads/' + req.file.filename + cacheBust;
    g.icon = fileUrl;
    saveDB();
    backupUploadFile(req.file.filename);
    for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
    res.json({ success: true, icon: fileUrl, group: publicGroup(g) });
  } catch (e) {
    console.error('group icon upload error', e);
    res.status(500).json({ error: 'Failed to upload group icon' });
  }
});

// Owner: kick a member
app.post('/api/groups/:id/kick', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can kick members' });
  const target = String((req.body || {}).username || '').toLowerCase().trim();
  if (!target) return res.status(400).json({ error: 'Username required' });
  if (target === g.owner) return res.status(400).json({ error: 'You cannot kick the group owner' });
  if (!(g.members || []).includes(target)) return res.status(400).json({ error: 'That user is not in this group' });
  g.members = (g.members || []).filter(m => m !== target);
  saveDB();
  // Notify the kicked user + remaining members
  io.to('user:' + target).emit('group-removed', { id: g.id });
  for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
  res.json({ success: true, group: publicGroup(g) });
});

// Owner: add a member
app.post('/api/groups/:id/add', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can add members' });
  const target = String((req.body || {}).username || '').toLowerCase().trim();
  if (!target) return res.status(400).json({ error: 'Username required' });
  if (!db.users[target]) return res.status(400).json({ error: 'User @' + target + ' does not exist' });
  if ((g.members || []).includes(target)) return res.status(400).json({ error: 'That user is already in this group' });
  if ((g.members || []).length >= 10) return res.status(400).json({ error: 'Group is full (max 10 members)' });
  // Respect the target user's privacy setting: only add them if they allow it.
  if (db.users[target].allowGroupAdd === false) {
    return res.status(403).json({ error: '@' + target + ' does not allow being added to group chats. You can ask them to enable it in their settings.' });
  }
  g.members = (g.members || []).concat(target);
  saveDB();
  io.to('user:' + target).emit('group-updated', { group: publicGroup(g) });
  for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
  res.json({ success: true, group: publicGroup(g) });
});

// Member: leave the group (owner leaving transfers/deletes)
app.post('/api/groups/:id/leave', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  const me = req.user.username;
  if (!(g.members || []).includes(me)) return res.status(400).json({ error: 'You are not in this group' });
  g.members = (g.members || []).filter(m => m !== me);
  if (g.owner === me) {
    if (g.members.length === 0) {
      // No members left — delete the group entirely
      db.groupChats = (db.groupChats || []).filter(x => x.id !== g.id);
    } else {
      // Transfer ownership to the next member
      g.owner = g.members[0];
    }
  }
  saveDB();
  io.to('user:' + me).emit('group-removed', { id: g.id });
  if (db.groupChats.includes(g)) {
    for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
  }
  res.json({ success: true });
});

// Owner: delete the group entirely (removes everyone)
app.post('/api/groups/:id/delete', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can delete the group' });
  const members = (g.members || []).slice();
  db.groupChats = (db.groupChats || []).filter(x => x.id !== g.id);
  saveDB();
  // Notify every former member (including the owner) that the group is gone
  for (const m of members) io.to('user:' + m).emit('group-removed', { id: g.id });
  res.json({ success: true });
});

// ---------- Settings ----------
app.post('/api/settings/display-name', authMiddleware, (req, res) => {
  const { displayName } = req.body || {};
  if (!displayName || !String(displayName).trim()) return res.status(400).json({ error: 'Display name required' });
  // Enforce 5-second cooldown between display name changes
  const now = Date.now();
  const lastChange = displayNameCooldowns.get(req.user.username) || 0;
  const remaining = DISPLAY_NAME_COOLDOWN_MS - (now - lastChange);
  if (remaining > 0) {
    const secs = Math.ceil(remaining / 1000);
    return res.status(429).json({ error: 'Please wait ' + secs + ' second' + (secs > 1 ? 's' : '') + ' before changing your display name again.', cooldown: secs });
  }
  req.user.displayName = String(displayName).trim().slice(0, 50);
  displayNameCooldowns.set(req.user.username, now);
  saveDB();
  broadcastProfile(req.user.username);
  res.json({ success: true, displayName: req.user.displayName });
});

app.post('/api/settings/username', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const newUn = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_]+$/.test(newUn) || newUn.length < 3) return res.status(400).json({ error: 'Invalid username' });
  if (db.users[newUn] && newUn !== req.user.username) return res.status(409).json({ error: 'Username already taken' });
  const oldUn = req.user.username;
  // Migrate user data
  const user = db.users[oldUn];
  delete db.users[oldUn];
  user.username = newUn;
  db.users[newUn] = user;
  // Migrate sessions
  for (const [sid, un] of Object.entries(db.sessions)) {
    if (un === oldUn) db.sessions[sid] = newUn;
  }
  // Migrate friends
  const f = db.friends[oldUn];
  if (f) { delete db.friends[oldUn]; db.friends[newUn] = f; }
  for (const [un, fr] of Object.entries(db.friends)) {
    fr.friends = fr.friends.map(x => x === oldUn ? newUn : x);
    fr.sent = fr.sent.map(x => x === oldUn ? newUn : x);
    fr.received = fr.received.map(x => x === oldUn ? newUn : x);
  }
  // Migrate blocked
  const bl = db.blocked[oldUn];
  if (bl) { delete db.blocked[oldUn]; db.blocked[newUn] = bl; }
  for (const [un, arr] of Object.entries(db.blocked)) {
    db.blocked[un] = arr.map(x => x === oldUn ? newUn : x);
  }
  // Migrate DMs
  const myDMs = db.dms[oldUn];
  if (myDMs) { delete db.dms[oldUn]; db.dms[newUn] = myDMs; }
  for (const [un, convos] of Object.entries(db.dms)) {
    if (un === newUn) continue;
    if (convos[oldUn]) { convos[newUn] = convos[oldUn]; delete convos[oldUn]; }
  }
  // Migrate group chats (owner + members + message usernames)
  if (Array.isArray(db.groupChats)) {
    for (const g of db.groupChats) {
      if (g.owner === oldUn) g.owner = newUn;
      if (Array.isArray(g.members)) g.members = g.members.map(m => m === oldUn ? newUn : m);
      if (Array.isArray(g.messages)) g.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; if (m.from === oldUn) m.from = newUn; });
    }
  }
  // Update message usernames
  db.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; });
  saveDB();
  io.emit('username-changed', { oldUsername: oldUn, newUsername: newUn, username: newUn });
  res.json({ success: true, username: newUn });
});

app.post('/api/settings/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (req.user.password !== hashPass(String(currentPassword || ''))) return res.status(401).json({ error: 'Current password is incorrect' });
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  req.user.password = hashPass(String(newPassword));
  saveDB();
  res.json({ success: true });
});

// ---------- 2-Step Verification Settings ----------
// Enable 2SV: generates a new 24-char code and returns it to the user.
app.post('/api/settings/2sv/enable', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is already enabled' });
  }
  req.user.twoFactorEnabled = true;
  req.user.twoFactorCode = gen2SVCode();
  req.user.twoFactorCodeGenerated = Date.now();
  req.user.twoFactorTrustedDevices = [];
  saveDB();
  console.log('[2SV] Enabled for @' + req.user.username + '. Code generated.');
  res.json({
    success: true,
    code: req.user.twoFactorCode,
    generatedAt: req.user.twoFactorCodeGenerated,
    message: '2-Step Verification enabled. Save your recovery code.',
  });
});

// Disable 2SV: requires password, clears all 2SV data.
app.post('/api/settings/2sv/disable', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  req.user.twoFactorEnabled = false;
  req.user.twoFactorCode = null;
  req.user.twoFactorCodeGenerated = 0;
  req.user.twoFactorTrustedDevices = [];
  saveDB();
  console.log('[2SV] Disabled for @' + req.user.username + '.');
  res.json({ success: true, message: '2-Step Verification disabled.' });
});

// Regenerate code: creates a new code, invalidates the old one.
app.post('/api/settings/2sv/regenerate', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is not enabled' });
  }
  // Enforce 48-hour cooldown between manual regenerations.
  const generated = req.user.twoFactorCodeGenerated || 0;
  const elapsed = Date.now() - generated;
  const remaining = TWO_SV_REGEN_INTERVAL - elapsed;
  if (remaining > 0) {
    const hoursLeft = Math.ceil(remaining / (60 * 60 * 1000));
    return res.status(429).json({
      error: 'Recovery code can only be regenerated once every 48 hours. Please try again in ' + hoursLeft + ' hour' + (hoursLeft > 1 ? 's' : '') + '.',
      cooldownRemaining: remaining,
    });
  }
  req.user.twoFactorCode = gen2SVCode();
  req.user.twoFactorCodeGenerated = Date.now();
  // Regenerating also clears trusted devices (forces re-verification on all devices)
  req.user.twoFactorTrustedDevices = [];
  saveDB();
  console.log('[2SV] Code regenerated for @' + req.user.username + '. Old code invalidated.');
  res.json({
    success: true,
    code: req.user.twoFactorCode,
    generatedAt: req.user.twoFactorCodeGenerated,
    message: 'New recovery code generated. The previous code is now invalid.',
  });
});

// View current code: requires password, returns the current code + generation time.
// Also auto-regenerates if the code is older than 48 hours.
app.post('/api/settings/2sv/view-code', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is not enabled' });
  }
  // Auto-regenerate if older than 48 hours
  const oldCode = req.user.twoFactorCode;
  const code = refresh2SVCode(req.user);
  const wasRegenerated = code !== oldCode;
  saveDB();
  res.json({
    success: true,
    code: req.user.twoFactorCode,
    generatedAt: req.user.twoFactorCodeGenerated,
    regenerated: wasRegenerated,
  });
});

// Get 2SV status (no password required, just session auth).
app.get('/api/settings/2sv/status', authMiddleware, (req, res) => {
  // Auto-regenerate if the code is older than 48 hours (silent refresh)
  if (req.user.twoFactorEnabled) {
    refresh2SVCode(req.user);
    saveDB();
  }
  res.json({
    enabled: !!req.user.twoFactorEnabled,
    generatedAt: req.user.twoFactorCodeGenerated || 0,
    trustedDeviceCount: (req.user.twoFactorTrustedDevices || []).length,
    nextRegenAt: req.user.twoFactorEnabled
      ? (req.user.twoFactorCodeGenerated || 0) + TWO_SV_REGEN_INTERVAL
      : 0,
  });
});

// Revoke all trusted devices (forces 2SV on all devices next login).
app.post('/api/settings/2sv/revoke-devices', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is not enabled' });
  }
  req.user.twoFactorTrustedDevices = [];
  saveDB();
  res.json({ success: true, message: 'All trusted devices revoked.' });
});

app.post('/api/settings/preferences', authMiddleware, (req, res) => {
  const p = req.body || {};
  if (p.notificationsEnabled !== undefined) req.user.notificationsEnabled = !!p.notificationsEnabled;
  if (p.messageSounds !== undefined) req.user.messageSounds = !!p.messageSounds;
  if (p.compactMode !== undefined) req.user.compactMode = !!p.compactMode;
  if (p.allowGroupAdd !== undefined) req.user.allowGroupAdd = !!p.allowGroupAdd;
  if (p.theme) req.user.theme = p.theme;
  req.user.preferences = p;
  saveDB();
  res.json({ success: true });
});

app.post('/api/settings/delete-account', authMiddleware, (req, res) => {
  // The owner account (@lore) cannot be deleted — this protects the primary
  // admin account from accidental or malicious removal.
  if (isOwnerUser(req.user)) return res.status(403).json({ error: 'This account cannot be deleted' });
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) return res.status(401).json({ error: 'Password is incorrect' });
  const un = req.user.username;
  // Remove from sessions
  for (const [sid, sUn] of Object.entries(db.sessions)) { if (sUn === un) delete db.sessions[sid]; }
  // Remove user
  delete db.users[un];
  delete db.friends[un];
  delete db.blocked[un];
  delete db.dms[un];
  // Remove from others' friend lists
  for (const [otherUn, fr] of Object.entries(db.friends)) {
    fr.friends = fr.friends.filter(x => x !== un);
    fr.sent = fr.sent.filter(x => x !== un);
    fr.received = fr.received.filter(x => x !== un);
  }
  for (const [otherUn, arr] of Object.entries(db.blocked)) {
    db.blocked[otherUn] = arr.filter(x => x !== un);
  }
  for (const [otherUn, convos] of Object.entries(db.dms)) {
    delete convos[un];
  }
  // Clean up any pending 2SV tokens for this user
  if (db.pending2SV) {
    for (const [token, data] of Object.entries(db.pending2SV)) {
      if (data.username === un) delete db.pending2SV[token];
    }
  }
  saveDB();
  // Notify any open admin panels that the account list changed (account
  // deleted) so the Account Credentials & Sessions list updates in real time.
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'delete-account', username: un }); } catch (e) {}
  res.json({ success: true });
});

// ---------- Disable Account (grace-period deactivation) ----------
// Different from permanent deletion: the user is logged out, their visible
// profile is reset to "deleted user" + the default picture, and the account
// enters a 30-day grace period. Logging back in prompts them to reinstate.
// If they don't reinstate within 30 days, the account is auto-purged.
app.post('/api/settings/disable-account', authMiddleware, (req, res) => {
  // The owner account cannot be disabled — protects the primary admin.
  if (isOwnerUser(req.user)) return res.status(403).json({ error: 'This account cannot be disabled' });
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) return res.status(401).json({ error: 'Password is incorrect' });
  const un = req.user.username;
  const u = req.user;
  // Snapshot the user's real profile so it can be restored on reactivation.
  // We store the fields that get reset to the placeholder below.
  u.disabledProfile = {
    displayName: u.displayName,
    avatar: u.avatar,
    banner: u.banner,
    bio: u.bio,
    pronouns: u.pronouns,
    location: u.location,
    website: u.website,
    panelColor: u.panelColor,
    status: u.status,
    showOnlineStatus: u.showOnlineStatus,
    hideLastSeen: u.hideLastSeen,
    friendRequestsEnabled: u.friendRequestsEnabled,
    directMessagesEnabled: u.directMessagesEnabled,
    badges: (u.badges || []).slice(),
    role: u.role,
  };
  // Mark the account disabled + schedule deletion 30 days out.
  u.disabled = true;
  u.disabledAt = Date.now();
  u.scheduledDeletionAt = Date.now() + DISABLE_GRACE_MS;
  // Reset the visible profile to the placeholder identity.
  u.displayName = DISABLED_DISPLAY_NAME;
  u.avatar = DEFAULT_AVATAR_URL;
  u.banner = null;
  u.bio = '';
  u.pronouns = '';
  u.location = '';
  u.website = '';
  u.panelColor = null;
  u.status = 'offline';
  u.showOnlineStatus = false;
  u.friendRequestsEnabled = false;
  u.directMessagesEnabled = false;
  // Kill all sessions for this user (log them out everywhere).
  for (const [sid, sUn] of Object.entries(db.sessions)) { if (sUn === un) delete db.sessions[sid]; }
  saveDB();
  // Broadcast the placeholder profile so other clients update immediately.
  broadcastProfile(un);
  emitUsersList();
  // Notify admin panels.
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'disable-account', username: un }); } catch (e) {}
  res.json({ success: true, scheduledDeletionAt: u.scheduledDeletionAt });
});

// ---------- Reactivate a disabled account ----------
// Called from the login reactivation prompt. Restores the user's real profile
// from the snapshot, clears the disabled flag, and creates a fresh session.
app.post('/api/account/reactivate', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const un = String(username).toLowerCase().trim();
  const user = db.users[un];
  if (!user || user.password !== hashPass(String(password))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!isAccountDisabled(user)) {
    // Not disabled — treat like a normal login error to avoid leaking state.
    return res.status(400).json({ error: 'This account is not disabled' });
  }
  // Restore the real profile from the snapshot (if present).
  const snap = user.disabledProfile || {};
  user.displayName = snap.displayName || user.username;
  user.avatar = (snap.avatar !== undefined ? snap.avatar : null);
  user.banner = (snap.banner !== undefined ? snap.banner : null);
  user.bio = snap.bio || '';
  user.pronouns = snap.pronouns || '';
  user.location = snap.location || '';
  user.website = snap.website || '';
  user.panelColor = snap.panelColor || null;
  user.status = 'online';
  user.showOnlineStatus = (snap.showOnlineStatus !== undefined ? snap.showOnlineStatus : true);
  user.hideLastSeen = !!snap.hideLastSeen;
  user.friendRequestsEnabled = (snap.friendRequestsEnabled !== undefined ? snap.friendRequestsEnabled : true);
  user.directMessagesEnabled = (snap.directMessagesEnabled !== undefined ? snap.directMessagesEnabled : true);
  user.badges = snap.badges || [];
  user.role = snap.role || 'user';
  // Clear the disabled state + snapshot.
  user.disabled = false;
  user.disabledAt = 0;
  user.scheduledDeletionAt = 0;
  delete user.disabledProfile;
  user.lastSeen = nowISO();
  // Create a fresh session.
  const sid = genId();
  db.sessions[sid] = un;
  saveDB();
  broadcastProfile(un);
  emitUsersList();
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'reactivate-account', username: un }); } catch (e) {}
  res.json({ sessionId: sid, user: fullUser(user) });
});

// ---------- Decline reactivation (stay disabled) ----------
// Lets the user explicitly close the reactivation prompt without reinstating.
// No session is created; the account remains disabled and will be purged after
// the grace period. (This is purely a UI affordance — it does nothing server-
// side beyond acknowledging the choice.)
app.post('/api/account/decline-reactivation', (req, res) => {
  res.json({ success: true });
});

// ---------- Admin Middleware & Endpoints ----------
// Admin access is granted when EITHER:
//   (a) the user is the owner (UUID or username === 'lore'), OR
//   (b) the user's session has unlocked the panel by entering ADMIN_UNLOCK_CODE.
// Every logged-in user can SEE the admin tab; clicking it prompts for the code.
function isAdmin(user, sid) {
  if (!user) return false;
  if (isOwnerUser(user)) return true;
  if (sid && adminUnlockedSessions.has(sid)) return true;
  return false;
}
function adminMiddleware(req, res, next) {
  if (!isAdmin(req.user, req.session && req.session.sid)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Check if current user has admin access (used by frontend to show/hide the tab)
app.get('/api/admin/check', authMiddleware, (req, res) => {
  const sid = req.session.sid;
  res.json({
    isAdmin: isAdmin(req.user, sid),
    isOwner: isOwnerUser(req.user),
    ownerName: ADMIN_OWNER_NAME,
    codeUnlocked: !(!isOwnerUser(req.user) && sid && adminUnlockedSessions.has(sid)),
  });
});

// Unlock the admin panel by entering the secret code.
// On success the session is flagged so the user isn't re-prompted until logout/restart.
app.post('/api/admin/unlock', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required', correct: false });
  if (String(code).trim() === ADMIN_UNLOCK_CODE) {
    if (req.session && req.session.sid) adminUnlockedSessions.add(req.session.sid);
    return res.json({ success: true, correct: true, ownerName: ADMIN_OWNER_NAME });
  }
  return res.status(403).json({ error: 'Wrong code. You have gotten it wrong — please try again.', correct: false });
});

// Get full admin data: all users (with sensitive info), whitelist, activity log
app.get('/api/admin/data', authMiddleware, adminMiddleware, (req, res) => {
  const userList = Object.values(db.users).map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    email: u.email || '',
    avatar: u.avatar || null,
    status: u.status || 'offline',
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
    banReason: u.banReason || null,
    bannedAt: u.bannedAt || null,
    createdAt: u.createdAt || nowISO(),
    lastSeen: u.lastSeen || nowISO(),
    passwordHash: u.password || '',
    plaintextPassword: (u.username === ADMIN_OWNER_NAME) ? '(hidden)' : (u.plaintextPassword || '(not stored)'),
    sessionCount: Object.values(db.sessions).filter(s => s === u.username).length,
    mutedUntil: (u.mutedUntil && Date.now() < u.mutedUntil) ? u.mutedUntil : 0,
    muteReason: u.muteReason || '',
    mutedBy: u.mutedBy || '',
  }));
  const activity = (db.adminActivity || []).slice(-200).reverse();
  res.json({
    users: userList,
    whitelist: db.adminWhitelist || [],
    activity,
    validRoles: VALID_ROLES,
    validBadges: VALID_BADGES,
    ownerId: ADMIN_OWNER_ID,
    welcomeTitle: db.welcomeTitle || 'welcome - to the safe place',
    welcomeTitleLastChanged: db.welcomeTitleLastChanged || 0,
    welcomeTitleCooldown: WELCOME_TITLE_COOLDOWN,
    customRoles: db.customRoles || [],
    cooldownExempt: db.cooldownExempt || [],
    ownerName: ADMIN_OWNER_NAME,
  });
});

// Clear the admin activity log
app.post('/api/admin/clear-activity', authMiddleware, adminMiddleware, (req, res) => {
  db.adminActivity = [];
  saveDB();
  res.json({ success: true });
});

// Ban a user
app.post('/api/admin/ban', authMiddleware, adminMiddleware, (req, res) => {
  const { username, reason, durationMs } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isOwnerUser(target)) return res.status(403).json({ error: 'The owner cannot be banned' });
  if (isAdmin(target) && !isOwnerUser(req.user)) return res.status(403).json({ error: 'Cannot ban another administrator' });
  target.banned = true;
  target.banReason = String(reason || 'No reason provided').trim();
  target.bannedAt = nowISO();
  target.bannedBy = req.user.username;
  // Temporary ban: if durationMs is provided and > 0, set an expiry timestamp.
  // Duration is clamped to 1 day (86400000) – 14 days (1209600000).
  // A value of 0 or omitted means a permanent ban (bannedUntil = 0).
  let dur = Number(durationMs);
  let durationText = 'Permanent';
  if (dur && !isNaN(dur) && dur > 0) {
    const minMs = 24 * 60 * 60 * 1000;       // 1 day
    const maxMs = 14 * 24 * 60 * 60 * 1000;  // 14 days
    if (dur < minMs) dur = minMs;
    if (dur > maxMs) dur = maxMs;
    target.bannedUntil = Date.now() + dur;
    durationText = formatMuteDuration(dur);
  } else {
    target.bannedUntil = 0;
  }
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'ban', admin: req.user.username, target: target.username, reason: target.banReason, duration: durationText, timestamp: nowISO() });
  saveDB();

  // ---- Force logout the banned user ----
  // 1. Notify the user's connected sockets so the frontend can show a "banned"
  //    message and return to the login screen.
  io.to(`user:${target.username}`).emit('banned', {
    reason: target.banReason,
    bannedBy: req.user.username,
    bannedUntil: target.bannedUntil || 0,
    durationText: durationText,
  });
  // 2. Delete ALL of the target's sessions so they can't reconnect or make
  //    new API requests with an existing session token.
  for (const [sid, sUn] of Object.entries(db.sessions)) {
    if (sUn === target.username) {
      delete db.sessions[sid];
      adminUnlockedSessions.delete(sid);
    }
  }
  // 3. Disconnect every live socket belonging to the target.
  const targetSockets = connectedUsers.get(target.username);
  if (targetSockets) {
    for (const sockId of targetSockets) {
      const s = io.sockets.sockets.get(sockId);
      if (s) s.disconnect(true);
    }
    connectedUsers.delete(target.username);
  }

  broadcastProfile(target.username);
  emitUsersList();
  res.json({ success: true, user: publicUser(target), durationText: durationText });
});

// Unban a user
app.post('/api/admin/unban', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.banned = false;
  target.banReason = null;
  target.bannedAt = null;
  target.bannedBy = null;
  target.bannedUntil = 0;
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'unban', admin: req.user.username, target: target.username, reason: '', timestamp: nowISO() });
  saveDB();
  broadcastProfile(target.username);
  emitUsersList();
  res.json({ success: true, user: publicUser(target) });
});

// Set a user's role (developer, administrator, moderator, etc.)
app.post('/api/admin/set-role', authMiddleware, adminMiddleware, (req, res) => {
  const { username, role } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Owner is allowed to change their own role (and anyone else's).
  // Only non-owner admins are blocked from demoting the owner.
  if (isOwnerUser(target) && !isOwnerUser(req.user)) {
    return res.status(403).json({ error: 'Only the owner can change the owner role' });
  }
  const oldRole = target.role || 'user';
  target.role = role;
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'set-role', admin: req.user.username, target: target.username, reason: oldRole + ' -> ' + role, timestamp: nowISO() });
  saveDB();
  broadcastProfile(target.username);
  emitUsersList();
  res.json({ success: true, user: publicUser(target) });
});

// Admin: Rename a user's USERNAME (the login handle / @handle).
// This bypasses the normal 3-20 character limit so admins can set short
// (1-2 char) or longer usernames. Basic safety is still enforced: the new
// username must be non-empty, max 32 chars, and only contain letters,
// numbers, and underscores (lowercased). All associated data (sessions,
// friends, blocked, DMs, group chats, messages, cooldownExempt, whitelist,
// custom roles, closedDMs) is migrated to the new username.
app.post('/api/admin/rename-user', authMiddleware, adminMiddleware, (req, res) => {
  const { username, newUsername } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Target username required' });
  const oldUn = String(username).toLowerCase().trim();
  const target = db.users[oldUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Normalize + validate the new username. Bypass the normal 3-char minimum
  // (allow 1+) but keep a sane maximum of 32 and restrict to safe characters.
  const newUn = String(newUsername || '').toLowerCase().trim();
  if (!newUn) return res.status(400).json({ error: 'New username is required' });
  if (!/^[a-z0-9_]+$/.test(newUn)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (newUn.length > 32) return res.status(400).json({ error: 'Username cannot exceed 32 characters' });
  if (newUn === oldUn) return res.status(400).json({ error: 'New username is the same as the current one' });
  if (db.users[newUn]) return res.status(409).json({ error: 'That username is already taken' });

  // ---- Migrate user data ----
  const user = db.users[oldUn];
  delete db.users[oldUn];
  user.username = newUn;
  db.users[newUn] = user;

  // ---- Migrate sessions ----
  for (const [sid, un] of Object.entries(db.sessions)) {
    if (un === oldUn) db.sessions[sid] = newUn;
  }

  // ---- Migrate friends ----
  if (db.friends) {
    const f = db.friends[oldUn];
    if (f) { delete db.friends[oldUn]; db.friends[newUn] = f; }
    for (const [un, fr] of Object.entries(db.friends)) {
      if (fr.friends) fr.friends = fr.friends.map(x => x === oldUn ? newUn : x);
      if (fr.sent) fr.sent = fr.sent.map(x => x === oldUn ? newUn : x);
      if (fr.received) fr.received = fr.received.map(x => x === oldUn ? newUn : x);
    }
  }

  // ---- Migrate blocked ----
  if (db.blocked) {
    const bl = db.blocked[oldUn];
    if (bl) { delete db.blocked[oldUn]; db.blocked[newUn] = bl; }
    for (const [un, arr] of Object.entries(db.blocked)) {
      db.blocked[un] = arr.map(x => x === oldUn ? newUn : x);
    }
  }

  // ---- Migrate DMs ----
  if (db.dms) {
    const myDMs = db.dms[oldUn];
    if (myDMs) { delete db.dms[oldUn]; db.dms[newUn] = myDMs; }
    for (const [un, convos] of Object.entries(db.dms)) {
      if (un === newUn) continue;
      if (convos && convos[oldUn]) { convos[newUn] = convos[oldUn]; delete convos[oldUn]; }
      // Update from/to fields inside DM messages
      if (convos) {
        for (const convo of Object.values(convos)) {
          if (Array.isArray(convo)) convo.forEach(m => { if (m.from === oldUn) m.from = newUn; if (m.to === oldUn) m.to = newUn; });
        }
      }
    }
    // Also fix from/to inside the renamed user's own conversations
    if (db.dms[newUn]) {
      for (const convo of Object.values(db.dms[newUn])) {
        if (Array.isArray(convo)) convo.forEach(m => { if (m.from === oldUn) m.from = newUn; if (m.to === oldUn) m.to = newUn; });
      }
    }
  }

  // ---- Migrate group chats (owner + members + message usernames) ----
  if (Array.isArray(db.groupChats)) {
    for (const g of db.groupChats) {
      if (g.owner === oldUn) g.owner = newUn;
      if (Array.isArray(g.members)) g.members = g.members.map(m => m === oldUn ? newUn : m);
      if (Array.isArray(g.messages)) g.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; if (m.from === oldUn) m.from = newUn; });
    }
  }

  // ---- Update public chat message usernames ----
  if (Array.isArray(db.messages)) db.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; });

  // ---- Migrate cooldownExempt list ----
  if (Array.isArray(db.cooldownExempt)) {
    db.cooldownExempt = db.cooldownExempt.map(x => x === oldUn ? newUn : x);
  }

  // ---- Migrate whitelist ----
  if (Array.isArray(db.whitelist)) {
    db.whitelist = db.whitelist.map(x => x === oldUn ? newUn : x);
  }

  // ---- Migrate custom role memberships ----
  if (Array.isArray(db.customRoles)) {
    for (const role of db.customRoles) {
      if (Array.isArray(role.members)) role.members = role.members.map(x => x === oldUn ? newUn : x);
    }
  }

  // ---- Migrate closedDMs references on every user ----
  for (const u of Object.values(db.users)) {
    if (Array.isArray(u.closedDMs)) u.closedDMs = u.closedDMs.map(x => x === oldUn ? newUn : x);
  }

  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'rename-user', admin: req.user.username, target: oldUn, reason: oldUn + ' -> ' + newUn, timestamp: nowISO() });
  saveDB();

  // Notify ALL clients so they update the renamed user everywhere
  // (member list, messages, DMs, etc.).
  io.emit('username-changed', { oldUsername: oldUn, newUsername: newUn, username: newUn, adminRenamed: true });
  // Force the renamed user's own client to reload their session info.
  io.to('user:' + newUn).emit('force-reload', { reason: 'Your username was changed by an admin.' });
  broadcastProfile(newUn);
  emitUsersList();
  res.json({ success: true, oldUsername: oldUn, newUsername: newUn, user: publicUser(target) });
});

// Add a badge/icon to a user (moderator, developer)
app.post('/api/admin/add-badge', authMiddleware, adminMiddleware, (req, res) => {
  const { username, badge } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!VALID_BADGES.includes(badge)) return res.status(400).json({ error: 'Invalid badge' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!target.badges) target.badges = [];
  if (!target.badges.includes(badge)) target.badges.push(badge);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'add-badge', admin: req.user.username, target: target.username, reason: badge, timestamp: nowISO() });
  saveDB();
  broadcastProfile(target.username);
  emitUsersList();
  res.json({ success: true, user: publicUser(target) });
});

// Remove a badge/icon from a user
app.post('/api/admin/remove-badge', authMiddleware, adminMiddleware, (req, res) => {
  const { username, badge } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!target.badges) target.badges = [];
  target.badges = target.badges.filter(b => b !== badge);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'remove-badge', admin: req.user.username, target: target.username, reason: badge || 'all', timestamp: nowISO() });
  saveDB();
  broadcastProfile(target.username);
  emitUsersList();
  res.json({ success: true, user: publicUser(target) });
});

// Add a user to the admin whitelist
app.post('/api/admin/whitelist-add', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  const target = db.users[targetUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!db.adminWhitelist) db.adminWhitelist = [];
  if (!db.adminWhitelist.includes(targetUn)) db.adminWhitelist.push(targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'whitelist-add', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  res.json({ success: true, whitelist: db.adminWhitelist });
});

// Remove a user from the admin whitelist
app.post('/api/admin/whitelist-remove', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (targetUn === req.user.username && !isOwnerUser(req.user)) return res.status(403).json({ error: 'Cannot remove yourself from whitelist' });
  // The owner (@lore) can never be removed from the whitelist by a non-owner admin.
  if (targetUn === ADMIN_OWNER_NAME && !isOwnerUser(req.user)) return res.status(403).json({ error: 'The owner cannot be removed from the whitelist' });
  if (!db.adminWhitelist) db.adminWhitelist = [];
  db.adminWhitelist = db.adminWhitelist.filter(u => u !== targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'whitelist-remove', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  res.json({ success: true, whitelist: db.adminWhitelist });
});

// ---------- Admin: Welcome Title Changer ----------
// Admin can change the chatroom welcome title (shown in the chat header).
// Enforced 20-second cooldown to prevent spam.
app.post('/api/admin/set-welcome-title', authMiddleware, adminMiddleware, (req, res) => {
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title text required' });
  if (title.length > 100) return res.status(400).json({ error: 'Title too long (max 100 chars)' });
  const now = Date.now();
  const lastChanged = db.welcomeTitleLastChanged || 0;
  const remaining = WELCOME_TITLE_COOLDOWN - (now - lastChanged);
  if (remaining > 0) {
    return res.status(429).json({ error: 'Cooldown active', remainingMs: remaining, cooldownMs: WELCOME_TITLE_COOLDOWN });
  }
  db.welcomeTitle = title;
  db.welcomeTitleLastChanged = now;
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'set-welcome-title', admin: req.user.username, target: '', reason: title, timestamp: nowISO() });
  saveDB();
  // Broadcast to all clients so the chat header updates in real-time
  io.emit('welcome-title-changed', { title });
  res.json({ success: true, title });
});

// Get current welcome title (public, any authenticated user)
app.get('/api/welcome-title', authMiddleware, (req, res) => {
  res.json({ title: db.welcomeTitle || 'welcome - to the safe place', lastChanged: db.welcomeTitleLastChanged || 0 });
});

// ---------- Admin: Custom Roles System ----------
// Admins can create custom member roles (e.g. "VIP", "Guest", "Streamer")
// and assign users to them. Custom roles appear as labeled groups in the
// member sidebar with a max of 30 names per role.
app.post('/api/admin/custom-role-add', authMiddleware, adminMiddleware, (req, res) => {
  const { name, color } = req.body || {};
  const roleName = String(name || '').trim();
  if (!roleName) return res.status(400).json({ error: 'Role name required' });
  if (roleName.length > 30) return res.status(400).json({ error: 'Role name too long (max 30 chars)' });
  if (!db.customRoles) db.customRoles = [];
  if (db.customRoles.some(r => r.name.toLowerCase() === roleName.toLowerCase())) {
    return res.status(409).json({ error: 'A custom role with that name already exists' });
  }
  const role = { id: genId(), name: roleName, color: String(color || '#818cf8'), members: [] };
  db.customRoles.push(role);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'custom-role-add', admin: req.user.username, target: '', reason: roleName, timestamp: nowISO() });
  saveDB();
  emitUsersList();
  res.json({ success: true, customRoles: db.customRoles });
});

app.post('/api/admin/custom-role-remove', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Role id required' });
  if (!db.customRoles) db.customRoles = [];
  const role = db.customRoles.find(r => r.id === id);
  if (!role) return res.status(404).json({ error: 'Custom role not found' });
  db.customRoles = db.customRoles.filter(r => r.id !== id);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'custom-role-remove', admin: req.user.username, target: '', reason: role.name, timestamp: nowISO() });
  saveDB();
  emitUsersList();
  res.json({ success: true, customRoles: db.customRoles });
});

// Add a user to a custom role (max 30 members per role)
app.post('/api/admin/custom-role-add-member', authMiddleware, adminMiddleware, (req, res) => {
  const { roleId, username } = req.body || {};
  if (!roleId || !username) return res.status(400).json({ error: 'Role id and username required' });
  if (!db.customRoles) db.customRoles = [];
  const role = db.customRoles.find(r => r.id === roleId);
  if (!role) return res.status(404).json({ error: 'Custom role not found' });
  const targetUn = String(username).toLowerCase().trim();
  if (!db.users[targetUn]) return res.status(404).json({ error: 'User not found' });
  if (role.members.length >= 30) return res.status(400).json({ error: 'This custom role is full (max 30 members)' });
  if (!role.members.includes(targetUn)) role.members.push(targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'custom-role-add-member', admin: req.user.username, target: targetUn, reason: role.name, timestamp: nowISO() });
  saveDB();
  emitUsersList();
  res.json({ success: true, customRoles: db.customRoles });
});

// Remove a user from a custom role
app.post('/api/admin/custom-role-remove-member', authMiddleware, adminMiddleware, (req, res) => {
  const { roleId, username } = req.body || {};
  if (!roleId || !username) return res.status(400).json({ error: 'Role id and username required' });
  if (!db.customRoles) db.customRoles = [];
  const role = db.customRoles.find(r => r.id === roleId);
  if (!role) return res.status(404).json({ error: 'Custom role not found' });
  const targetUn = String(username).toLowerCase().trim();
  role.members = role.members.filter(m => m !== targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'custom-role-remove-member', admin: req.user.username, target: targetUn, reason: role.name, timestamp: nowISO() });
  saveDB();
  emitUsersList();
  res.json({ success: true, customRoles: db.customRoles });
});

// ---------- Cooldown exemption management ----------
app.post('/api/admin/cooldown-exempt-add', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (!db.users[targetUn]) return res.status(404).json({ error: 'User not found' });
  if (!db.cooldownExempt) db.cooldownExempt = [];
  if (!db.cooldownExempt.includes(targetUn)) db.cooldownExempt.push(targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'cooldown-exempt-add', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  // Notify the affected user in real-time so their frontend updates currentUser.cooldownExempt
  io.to(`user:${targetUn}`).emit('cooldown-exempt-updated', { exempt: true, username: targetUn });
  res.json({ success: true, cooldownExempt: db.cooldownExempt });
});

app.post('/api/admin/cooldown-exempt-remove', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (!db.cooldownExempt) db.cooldownExempt = [];
  db.cooldownExempt = db.cooldownExempt.filter(u => u !== targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'cooldown-exempt-remove', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  // Notify the affected user in real-time so their frontend updates currentUser.cooldownExempt
  io.to(`user:${targetUn}`).emit('cooldown-exempt-updated', { exempt: false, username: targetUn });
  res.json({ success: true, cooldownExempt: db.cooldownExempt });
});

// ---------- Mute management ----------
// Format a millisecond duration into a human-readable string.
function formatMuteDuration(ms) {
  if (ms <= 0) return '0 seconds';
  const sec = Math.floor(ms / 1000);
  const minute = 60, hour = 3600, day = 86400;
  if (sec < minute) return sec + ' second' + (sec !== 1 ? 's' : '');
  if (sec < hour) {
    const m = Math.floor(sec / minute);
    const s = sec % minute;
    return m + ' minute' + (m !== 1 ? 's' : '') + (s > 0 ? ' ' + s + 's' : '');
  }
  if (sec < day) {
    const h = Math.floor(sec / hour);
    const m = Math.floor((sec % hour) / minute);
    return h + ' hour' + (h !== 1 ? 's' : '') + (m > 0 ? ' ' + m + 'm' : '');
  }
  const d = Math.floor(sec / day);
  const h = Math.floor((sec % day) / hour);
  return d + ' day' + (d !== 1 ? 's' : '') + (h > 0 ? ' ' + h + 'h' : '');
}

// Mute a user for a given duration (1 minute to 14 days).
// Body: { username, durationMs, reason }
app.post('/api/admin/mute', authMiddleware, adminMiddleware, (req, res) => {
  const { username, durationMs, reason } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (!db.users[targetUn]) return res.status(404).json({ error: 'User not found' });
  // The owner (@lore) can never be muted — matched by UUID OR username.
  if (isOwnerUser(db.users[targetUn])) {
    return res.status(403).json({ error: 'The owner cannot be muted' });
  }
  // Another admin (who unlocked the panel via code) cannot be muted unless
  // the acting user is the owner.
  if (isAdmin(db.users[targetUn]) && !isOwnerUser(req.user)) {
    return res.status(403).json({ error: 'Cannot mute another administrator' });
  }
  // Duration validation: 1 minute (60000) to 14 days (1209600000)
  const minMs = 60 * 1000;
  const maxMs = 14 * 24 * 60 * 60 * 1000;
  let dur = Number(durationMs);
  if (!dur || isNaN(dur)) return res.status(400).json({ error: 'Duration required' });
  if (dur < minMs) dur = minMs;
  if (dur > maxMs) dur = maxMs;
  const user = db.users[targetUn];
  user.mutedUntil = Date.now() + dur;
  user.muteReason = String(reason || '').slice(0, 300) || '';
  user.mutedBy = req.user.username;
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'mute', admin: req.user.username, target: targetUn, reason: user.muteReason, duration: formatMuteDuration(dur), timestamp: nowISO() });
  saveDB();
  // Push updated profile to the muted user's sockets so the frontend
  // immediately reflects the muted state.
  broadcastProfile(targetUn);
  io.to(`user:${targetUn}`).emit('muted', {
    mutedUntil: user.mutedUntil,
    reason: user.muteReason,
    mutedBy: user.mutedBy,
    durationText: formatMuteDuration(dur),
  });
  res.json({ success: true, username: targetUn, mutedUntil: user.mutedUntil, durationText: formatMuteDuration(dur) });
});

// Unmute a user immediately.
// Body: { username }
app.post('/api/admin/unmute', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (!db.users[targetUn]) return res.status(404).json({ error: 'User not found' });
  const user = db.users[targetUn];
  user.mutedUntil = 0;
  user.muteReason = '';
  user.mutedBy = '';
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'unmute', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  broadcastProfile(targetUn);
  io.to(`user:${targetUn}`).emit('unmuted', {});
  res.json({ success: true, username: targetUn });
});

// Search for a user by username or ID (for ban panel)
app.get('/api/admin/search', authMiddleware, adminMiddleware, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  const results = Object.values(db.users)
    .filter(u => u.username.includes(q) || (u.id && u.id.includes(q)) || (u.displayName && u.displayName.toLowerCase().includes(q)))
    .map(u => publicUser(u));
  res.json({ results });
});

// ---------- Admin: Message Moderation ----------
// Return the most recent chat messages (for the admin "Messages" tab) so
// admins can see and instantly delete any user's message.
app.get('/api/admin/messages', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const list = db.messages.slice(-limit).reverse().map(m => ({
    id: m.id,
    username: m.username,
    displayName: m.displayName || m.username,
    text: m.text || '',
    file: m.file || null,
    timestamp: m.timestamp,
    edited: !!m.edited,
    deleted: !!m.deleted,
  }));
  res.json({ messages: list });
});

// Admin hard-deletes a message instantly (no 2-minute soft-delete window).
// Emits 'message-removed' so every client removes it from the DOM right away.
app.post('/api/admin/delete-message', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Message id required' });
  const idx = db.messages.findIndex(m => m.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Message not found' });
  const removed = db.messages.splice(idx, 1)[0];
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'delete-message', admin: req.user.username, target: removed.username, reason: (removed.text || '').slice(0, 80), timestamp: nowISO() });
  saveDB();
  io.emit('message-removed', { id });
  res.json({ success: true });
});

// ---------- Admin: Broadcast System Alert ----------
// Instead of injecting a chat message, emit a 'system-alert' event that the
// frontend shows as a centered toast/alert that fades after 5 seconds.
app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text required' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long (max 500 chars)' });
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'broadcast', admin: req.user.username, target: 'all', reason: text.slice(0, 120), timestamp: nowISO() });
  saveDB();
  io.emit('system-alert', { text, admin: req.user.displayName || req.user.username, timestamp: nowISO() });
  res.json({ success: true });
});

// ---------- Link Embed / Open-Graph preview ----------
// Fetches a URL and extracts OG / meta tags for rich link previews.
app.get('/api/embed', authMiddleware, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'Only http(s) URLs' });
  // SSRF guard: block requests to private/loopback/link-local/internal hosts.
  // This prevents the embed endpoint from being abused to reach cloud metadata
  // endpoints (169.254.169.254), localhost services, or internal network hosts.
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    return res.status(400).json({ error: 'URLs pointing to private or internal hosts are not allowed' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HellobyeEmbed/1.0; +https://hellobye.app)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return res.json({ url, title: null, description: null, image: null, siteName: null, favicon: null, author: null });
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    // Non-HTML responses: treat the URL itself as a media/file embed.
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      const isImg = ct.startsWith('image/');
      const isVid = ct.startsWith('video/');
      const isAud = ct.startsWith('audio/');
      const name = decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname);
      return res.json({
        url,
        title: name || parsed.hostname,
        description: ct || 'Direct file link',
        image: isImg ? url : null,
        isImage: isImg, isVideo: isVid, isAudio: isAud,
        siteName: parsed.hostname,
        favicon: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64',
        contentType: ct,
      });
    }
    // Only read the first ~600KB of HTML — enough for <head> meta tags.
    const reader = resp.body.getReader();
    let html = '';
    let total = 0;
    while (total < 600000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += Buffer.from(value).toString('utf8');
      total += value.length;
      // Stop early once we've passed </head>.
      if (/<\/head>/i.test(html)) break;
    }
    try { reader.cancel(); } catch (e) {}

    const meta = extractMeta(html);
    const siteName = meta['og:site_name'] || meta['application_name'] || parsed.hostname;
    let image = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['og:image:secure_url'] || null;
    if (image && image.startsWith('/')) image = parsed.origin + image;
    if (image && image.startsWith('//')) image = parsed.protocol + image;
    res.json({
      url,
      title: meta['og:title'] || meta['twitter:title'] || meta['title'] || null,
      description: meta['og:description'] || meta['twitter:description'] || meta['description'] || null,
      image,
      siteName,
      favicon: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64',
      author: meta['article:author'] || meta['author'] || meta['og:article:author'] || null,
      themeColor: meta['theme-color'] || null,
    });
  } catch (e) {
    clearTimeout(timeout);
    res.json({ url, title: null, description: null, image: null, siteName: parsed.hostname, favicon: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64' });
  }
});

// Extract <meta> tags + <title> from an HTML head chunk into a flat map.
function extractMeta(html) {
  const out = {};
  // <meta property="og:..." content="..."> and <meta name="..." content="...">
  const metaRe = /<meta[^>]+>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const propMatch = tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (propMatch && contentMatch) {
      const key = propMatch[1].toLowerCase();
      if (!out[key]) out[key] = decodeEntities(contentMatch[1]);
    }
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) out['title'] = decodeEntities(titleMatch[1].trim());
  return out;
}
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

// ---------- Serve Frontend (SPA) ----------
app.use(express.static(__dirname, { index: 'index.html' }));
// Catch-all: serve index.html for any non-API, non-file route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/socket.io/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Broadcast helpers ----------
function broadcastProfile(username) {
  const u = db.users[username];
  if (!u) return;
  // For disabled accounts, emit a minimal "deleted user" profile update so
  // other clients see the placeholder identity instead of the real one.
  if (isAccountDisabled(u)) {
    io.emit('profile-updated', {
      username: u.username,
      status: 'offline',
      avatar: DEFAULT_AVATAR_URL,
      banner: null,
      bio: '',
      displayName: DISABLED_DISPLAY_NAME,
      hideLastSeen: true,
      lastSeen: u.lastSeen,
      pronouns: '',
      panelColor: null,
      showOnlineStatus: false,
      friendRequestsEnabled: false,
      directMessagesEnabled: false,
      statusMessage: '',
      role: 'user',
      badges: [],
      banned: false,
      disabled: true,
    });
    return;
  }
  io.emit('profile-updated', {
    username: u.username,
    status: u.status || 'online',
    avatar: u.avatar,
    banner: u.banner,
    bio: u.bio,
    displayName: u.displayName,
    hideLastSeen: !!u.hideLastSeen,
    lastSeen: u.lastSeen,
    pronouns: u.pronouns,
    panelColor: u.panelColor || null,
    showOnlineStatus: u.showOnlineStatus !== false,
    friendRequestsEnabled: u.friendRequestsEnabled !== false,
    directMessagesEnabled: u.directMessagesEnabled !== false,
    statusMessage: u.statusMessage || '',
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
    disabled: false,
  });
}

function emitUsersList() {
  // Build a set of usernames that belong to any custom role — these should
  // always appear in the list (with their real status) so the custom role
  // section can render them, even if showOnlineStatus is false.
  const customRoleUsernames = new Set();
  for (const role of (db.customRoles || [])) {
    for (const m of (role.members || [])) customRoleUsernames.add(m);
  }
  const list = Object.values(db.users)
    .filter(u => !isAccountDisabled(u) && connectedUsers.has(u.username) && (u.showOnlineStatus !== false || customRoleUsernames.has(u.username)) && !u.banned)
    .map(u => publicUser(u));
  // Also include offline users with their last seen
  const offline = Object.values(db.users)
    .filter(u => !isAccountDisabled(u) && !connectedUsers.has(u.username) && !u.banned)
    .map(u => { const pu = publicUser(u); pu.status = 'offline'; return pu; });
  io.emit('users-list', [...list, ...offline]);
  // Also emit custom roles so the member sidebar can render custom role groups
  io.emit('custom-roles', db.customRoles || []);
}

const connectedUsers = new Map(); // username -> Set(socketIds)
const socketToUser = new Map(); // socketId -> username
const lastMessageTime = {}; // username -> timestamp (chatroom cooldown)
const lastGroupTime = {}; // username:groupId -> timestamp (group chat cooldown, 0.3s)

function getConnectedUserSockets(username) {
  return connectedUsers.get(username) || new Set();
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  const sid = socket.handshake.auth && socket.handshake.auth.sessionId;
  if (!sid || !db.sessions[sid]) {
    socket.emit('connect_error', new Error('Not authenticated'));
    socket.disconnect();
    return;
  }
  const username = db.sessions[sid];
  const user = db.users[username];
  if (!user) { socket.disconnect(); return; }

  // Track connection
  if (!connectedUsers.has(username)) connectedUsers.set(username, new Set());
  connectedUsers.get(username).add(socket.id);
  socketToUser.set(socket.id, username);

  // Join personal room for targeted events (DMs, friend requests, blocks)
  socket.join(`user:${username}`);

  // Mark online — preserve the user's explicitly-set status.
  // Two distinct "offline" situations must be told apart:
  //   (a) The user chose "Appear Offline": set-status cleared savedStatus, so
  //       savedStatus is undefined. This MUST persist as offline across
  //       reconnects/refreshes and never revert to a previous status.
  //   (b) The user chose online/idle/dnd but a disconnect set status to
  //       'offline' while remembering their real choice in savedStatus. This
  //       MUST be restored to that real chosen status, NOT kept offline.
  if (user.explicitStatus && user.status === 'offline' && !user.savedStatus) {
    // Appear offline: keep it exactly as the user chose. Do NOT restore any
    // savedStatus (set-status already cleared it), so it can't revert to dnd.
    user.status = 'offline';
  } else if (user.explicitStatus && user.savedStatus && user.savedStatus !== 'offline') {
    // User had chosen online/idle/dnd, then got marked offline by a
    // disconnect — restore their real chosen status.
    user.status = user.savedStatus;
  } else if (!user.explicitStatus) {
    // Never explicitly chose a status: default to online.
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  broadcastProfile(username);
  emitUsersList();

  // Send current welcome title to the newly connected client
  socket.emit('welcome-title-changed', { title: db.welcomeTitle || 'welcome - to the safe place' });

  // ---- Send message ----
  socket.on('send-message', ({ text, file, files, reply }, ack) => {
    try {
      // Mute check — muted users cannot send public chat messages.
      // (DMs are intentionally NOT affected by mutes.)
      if (user.mutedUntil && Date.now() < user.mutedUntil) {
        const remainingMs = user.mutedUntil - Date.now();
        const durationText = formatMuteDuration(remainingMs);
        const reasonPart = user.muteReason ? ' Reason: ' + user.muteReason : '';
        if (typeof ack === 'function') ack({ error: 'You are muted and cannot send messages in chat. Time remaining: ' + durationText + '.' + reasonPart, muted: true, mutedUntil: user.mutedUntil });
        return;
      }
      // Clear expired mute flag if it has lapsed.
      if (user.mutedUntil && Date.now() >= user.mutedUntil) {
        user.mutedUntil = 0; user.muteReason = ''; user.mutedBy = '';
        saveDB();
      }
      // 2-second cooldown (skip if user is exempt)
      const isExempt = (db.cooldownExempt || []).includes(username);
      if (!isExempt) {
        const last = lastMessageTime[username] || 0;
        if (Date.now() - last < 2000) {
          const cooldown = Math.ceil((2000 - (Date.now() - last)) / 1000);
          if (typeof ack === 'function') ack({ error: 'Please wait ' + cooldown + 's before sending another message', cooldown });
          return;
        }
      }
      lastMessageTime[username] = Date.now();
      const msg = {
        id: genId(),
        username,
        text: String(text || '').slice(0, 5000),
        file: file || null,
        files: Array.isArray(files) ? files.slice(0, 5) : null,
        reply: reply || null,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        displayName: user.displayName,
      };
      db.messages.push(msg);
      if (db.messages.length > 1000) db.messages = db.messages.slice(-1000);
      saveDB();
      io.emit('new-message', msg);
      // ---- Reply highlight notification ----
      // When a message is a reply, notify the original message's author so
      // their client can highlight the message that was replied to.
      if (msg.reply && msg.reply.id && msg.reply.username && msg.reply.username !== username) {
        const replyTarget = msg.reply.username.toLowerCase();
        if (db.users[replyTarget]) {
          io.to('user:' + replyTarget).emit('replied-to', {
            messageId: msg.reply.id,
            by: username,
            replyId: msg.id,
            text: msg.text.slice(0, 200),
          });
        }
      }
      // ---- Ping/mention notifications ----
      // Parse @mentions from the message text and notify each pinged user
      // who is currently online. The mention regex matches @username.
      const mentionMatches = String(text || '').match(/(^|[^\w@])@([a-zA-Z0-9_\-]+)/g) || [];
      const mentionedSet = new Set();
      mentionMatches.forEach(m => { const i = m.indexOf('@'); if (i >= 0) mentionedSet.add(m.slice(i + 1).toLowerCase()); });
      mentionedSet.forEach(mentionedUn => {
        if (mentionedUn !== username && db.users[mentionedUn]) {
          io.to('user:' + mentionedUn).emit('pinged', {
            from: username,
            messageId: msg.id,
            text: msg.text.slice(0, 200),
          });
        }
      });
      if (typeof ack === 'function') ack({ success: true, id: msg.id });
    } catch (e) {
      console.error('send-message error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send message' });
    }
  });

  // ---- Edit message ----
  socket.on('edit-message', ({ id, text }, ack) => {
    try {
      const msg = db.messages.find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (msg.username !== username) { if (typeof ack === 'function') ack({ error: 'Not authorized' }); return; }
      msg.text = String(text || '').slice(0, 5000);
      msg.edited = true;
      msg.editedAt = nowISO();
      saveDB();
      io.emit('message-edited', { id: msg.id, text: msg.text, edited: true, editedAt: msg.editedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- Delete message ----
  // Soft-delete: mark the message deleted and emit immediately so all clients
  // show "This message was deleted". The PERMANENT removal (splice + emit
  // 'message-removed') is handled by a periodic cleanup interval that runs
  // ~2 minutes after deletedAt. This is restart-safe: unlike a setTimeout,
  // a periodic sweep based on the persisted deletedAt timestamp will always
  // finish the deletion even if the user leaves the site or the server
  // restarts/spins down before the timer would have fired. On startup, any
  // leftover soft-deleted messages older than the window are purged
  // immediately (see startup cleanup below).
  socket.on('delete-message', ({ id }, ack) => {
    try {
      const msg = db.messages.find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (msg.username !== username) { if (typeof ack === 'function') ack({ error: 'Not authorized' }); return; }
      msg.deleted = true;
      msg.deletedAt = nowISO();
      msg.text = '';
      msg.file = null;
      saveDB();
      io.emit('message-deleted', { id: msg.id, deletedAt: msg.deletedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- DM send ----
  socket.on('dm-send', ({ to, text, file, files, reply }, ack) => {
    try {
      const target = to ? to.toLowerCase() : '';
      if (!db.users[target]) { if (typeof ack === 'function') ack({ error: 'User not found' }); return; }
      // Direct Messages privacy: a user can turn off their own DMs.
      //  - If the RECIPIENT has DMs off, nobody can DM them.
      //  - The sender's own DM setting does NOT prevent them from sending
      //    (it only controls whether others can DM them).
      // This is enforced server-side so it cannot be bypassed by the client.
      const recipientRecord = db.users[target];
      if (recipientRecord && recipientRecord.directMessagesEnabled === false) {
        if (typeof ack === 'function') ack({ error: '@' + recipientRecord.username + ' has disabled direct messages and is not accepting private messages at this time.', recipientDmDisabled: true });
        return;
      }
      // DM cooldown removed entirely (Round 30) — no rate limit on DMs.
      const msg = {
        id: genId(),
        from: username,
        username,
        to: target,
        text: String(text || '').slice(0, 5000),
        file: file || null,
        files: Array.isArray(files) ? files.slice(0, 5) : null,
        reply: reply || null,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        displayName: user.displayName,
        read: false,
      };
      // Store in both users' DM maps
      const myDMs = db.dms[username] || (db.dms[username] = {});
      if (!myDMs[target]) myDMs[target] = [];
      myDMs[target].push(msg);
      const theirDMs = db.dms[target] || (db.dms[target] = {});
      if (!theirDMs[username]) theirDMs[username] = [];
      theirDMs[username].push(msg);
      if (myDMs[target].length > 1000) myDMs[target] = myDMs[target].slice(-1000);
      if (theirDMs[username].length > 1000) theirDMs[username] = theirDMs[username].slice(-1000);
      // Auto-reopen: a new incoming DM should ALWAYS surface the conversation
      // and the red unread badge for the recipient — even if the recipient had
      // previously closed that conversation. Without this, a closed conversation
      // is skipped by /api/dm-conversations and the recipient never sees the red
      // badge (this was why @lore, who had closed some conversations, stopped
      // getting DM notifications). Removing the sender from the recipient's
      // closedDMs makes the conversation (and its unread count) reappear.
      try {
        const recipientUser = db.users[target];
        if (recipientUser && Array.isArray(recipientUser.closedDMs) && recipientUser.closedDMs.includes(username)) {
          recipientUser.closedDMs = recipientUser.closedDMs.filter(u => u !== username);
        }
      } catch (e) {}
      saveDB();
      // Emit to recipient
      io.to(`user:${target}`).emit('dm-receive', { message: msg });
      // ---- DM Reply highlight notification ----
      if (msg.reply && msg.reply.id && msg.reply.username && msg.reply.username === target) {
        io.to('user:' + target).emit('dm-replied-to', {
          messageId: msg.reply.id,
          by: username,
          replyId: msg.id,
          text: msg.text.slice(0, 200),
        });
      }
      // ---- DM Ping/mention notification ----
      const dmMentionMatches = String(text || '').match(/(^|[^\w@])@([a-zA-Z0-9_\-]+)/g) || [];
      const dmMentionedSet = new Set();
      dmMentionMatches.forEach(m => { const i = m.indexOf('@'); if (i >= 0) dmMentionedSet.add(m.slice(i + 1).toLowerCase()); });
      // Only notify if the RECIPIENT is mentioned (the only other person in a DM)
      if (dmMentionedSet.has(target)) {
        io.to('user:' + target).emit('dm-pinged', {
          from: username,
          messageId: msg.id,
          text: msg.text.slice(0, 200),
        });
      }
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      console.error('dm-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send DM' });
    }
  });

  // ---- DM edit ----
  socket.on('dm-edit', ({ id, text }, ack) => {
    try {
      // Find message in DM store where this user is sender
      const myDMs = db.dms[username] || {};
      let found = null;
      for (const [other, msgs] of Object.entries(myDMs)) {
        const m = msgs.find(x => x.id === id && x.username === username);
        if (m) { found = m; break; }
      }
      if (!found) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      found.text = String(text || '').slice(0, 5000);
      found.edited = true;
      found.editedAt = nowISO();
      saveDB();
      io.to(`user:${found.to}`).emit('dm-edited', { id: found.id, from: username, text: found.text, edited: true, editedAt: found.editedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- DM delete ----
  // Soft-delete only here. Permanent removal is handled by the periodic
  // cleanup interval (restart-safe, completes even if the user leaves or the
  // server restarts before a timer would have fired). See startup cleanup +
  // setInterval below.
  socket.on('dm-delete', ({ id }, ack) => {
    try {
      const myDMs = db.dms[username] || {};
      let found = null;
      for (const [other, msgs] of Object.entries(myDMs)) {
        const m = msgs.find(x => x.id === id && x.username === username);
        if (m) { found = m; break; }
      }
      if (!found) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      found.deleted = true;
      found.deletedAt = nowISO();
      found.text = '';
      found.file = null;
      saveDB();
      // Notify the recipient (other party) ...
      io.to(`user:${found.to}`).emit('dm-deleted', { id: found.id, from: username, deletedAt: found.deletedAt });
      // ... AND echo back to the sender so their open DM updates instantly
      // (no refresh / no leaving & re-entering the conversation required).
      socket.emit('dm-deleted', { id: found.id, from: username, deletedAt: found.deletedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- DM typing ----
  socket.on('dm-typing', ({ to, typing }) => {
    io.to(`user:${to ? to.toLowerCase() : ''}`).emit('dm-typing', { from: username, typing: !!typing });
  });

  // ---- Group chat send ----
  socket.on('group-send', ({ groupId, text, file, files, reply }, ack) => {
    try {
      const g = findGroup(groupId);
      if (!g) { if (typeof ack === 'function') ack({ error: 'Group not found' }); return; }
      if (!(g.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'You are not a member of this group' }); return; }
      // 0.3-second (300ms) group chat cooldown (skip if user is exempt via admin panel)
      // (Round 30: reduced from 3s to 0.3s — prevents accidental double-sends without noticeable delay)
      const groupExempt = (db.cooldownExempt || []).includes(username);
      if (!groupExempt) {
        const gkey = username + ':' + groupId;
        const glast = lastGroupTime[gkey] || 0;
        if (Date.now() - glast < 300) {
          // Sub-second cooldown: silently drop the duplicate without a confusing "1s" message
          if (typeof ack === 'function') ack({ error: 'Sending too fast — please slow down', cooldown: 0.3 });
          return;
        }
        lastGroupTime[gkey] = Date.now();
      }
      if (!Array.isArray(g.messages)) g.messages = [];
      const msg = {
        id: genId(),
        from: username,
        username,
        text: String(text || '').slice(0, 5000),
        file: file || null,
        files: Array.isArray(files) ? files.slice(0, 5) : null,
        reply: reply || null,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        displayName: user.displayName,
      };
      g.messages.push(msg);
      if (g.messages.length > 2000) g.messages = g.messages.slice(-2000);
      saveDB();
      // Emit to every member of the group (including the sender, so their own
      // message appears instantly without a refetch).
      for (const m of (g.members || [])) io.to('user:' + m).emit('group-message', { groupId: g.id, message: msg });
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      console.error('group-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send group message' });
    }
  });

  // ---- Group chat edit ----
  socket.on('group-edit', ({ groupId, id, text }, ack) => {
    try {
      const g = findGroup(groupId);
      if (!g) { if (typeof ack === 'function') ack({ error: 'Group not found' }); return; }
      const m = (g.messages || []).find(x => x.id === id && x.username === username);
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.text = String(text || '').slice(0, 5000);
      m.edited = true;
      m.editedAt = nowISO();
      saveDB();
      for (const mem of (g.members || [])) io.to('user:' + mem).emit('group-edited', { groupId: g.id, id: m.id, from: username, text: m.text, edited: true, editedAt: m.editedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- Group chat delete ----
  socket.on('group-delete', ({ groupId, id }, ack) => {
    try {
      const g = findGroup(groupId);
      if (!g) { if (typeof ack === 'function') ack({ error: 'Group not found' }); return; }
      const m = (g.messages || []).find(x => x.id === id && x.username === username);
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.deleted = true;
      m.deletedAt = nowISO();
      m.text = '';
      m.file = null;
      saveDB();
      for (const mem of (g.members || [])) io.to('user:' + mem).emit('group-deleted', { groupId: g.id, id: m.id, from: username, deletedAt: m.deletedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- Group chat typing ----
  socket.on('group-typing', ({ groupId, typing }) => {
    const g = findGroup(groupId);
    if (!g) return;
    const u = db.users[username];
    const dn = u && u.displayName ? u.displayName : username;
    for (const mem of (g.members || [])) {
      if (mem === username) continue;
      io.to('user:' + mem).emit('group-typing', { groupId: g.id, from: username, displayName: dn, typing: !!typing });
    }
  });

  // ---- Set status ----
  socket.on('set-status', (status) => {
    if (!['online', 'idle', 'dnd', 'offline'].includes(status)) return;
    user.status = status;
    user.explicitStatus = true; // Mark as user-set (persists across reconnects)
    // If the user explicitly chose "offline" (appear offline), clear any
    // previously-remembered status so a stale "dnd"/"online" is never
    // restored on reconnect/login — appear offline must stay offline.
    if (status === 'offline') {
      user.savedStatus = undefined;
    } else {
      // For any other explicit choice, remember it as the "real" status to
      // restore after a temporary disconnect-induced offline.
      user.savedStatus = status;
    }
    user.lastSeen = nowISO();
    saveDB();
    broadcastProfile(username);
    emitUsersList();
  });

  // ---- Typing (public) ----
  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('user-typing', { username, typing: !!isTyping });
  });

  // ---- Activity ----
  socket.on('activity', () => {
    user.lastSeen = nowISO();
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    const socks = connectedUsers.get(username);
    if (socks) {
      socks.delete(socket.id);
      if (socks.size === 0) {
        connectedUsers.delete(username);
        // Only set status to offline if the user didn't explicitly choose
        // a status like "online", "idle", or "dnd". If they explicitly chose
        // "offline" (appear offline), keep it. If they chose online/idle/dnd,
        // we mark them offline since they're no longer connected — BUT we
        // remember their explicit choice so on reconnect it's restored.
        if (user.explicitStatus && user.status !== 'offline') {
          // Remember what they chose so we can restore it on reconnect
          user.savedStatus = user.status;
        }
        user.status = 'offline';
        user.lastSeen = nowISO();
        saveDB();
        broadcastProfile(username);
        emitUsersList();
      }
    }
    socketToUser.delete(socket.id);
  });
});

// ---------- Periodic deleted-message cleanup ----------
// Replaces the old per-delete setTimeout approach. Every 30 seconds we sweep
// for soft-deleted public messages and DMs whose deletedAt is older than the
// 2-minute window, permanently remove them from the DB, and emit
// 'message-removed' / 'dm-removed' to live clients so the placeholder
// disappears. This is restart-safe: if the server restarts mid-window, the
// startup purge + this interval finish the job — deleted messages can no
// longer get "stuck" as placeholders when a user leaves or the server spins
// down.
setInterval(() => { purgeExpiredDeletedMessages(true); }, 30 * 1000);

// ---------- Multer Error Handler ----------
// Catches file-size-exceeded and other multer errors so the client gets a
// clean JSON response instead of a raw 500.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    // Determine which limit applies based on the route
    const isAvatar = req.originalUrl && req.originalUrl.includes('/api/profile');
    const limit = isAvatar ? '20MB' : '115MB';
    return res.status(413).json({ error: 'File exceeds the ' + limit + ' size limit.' });
  }
  if (err && err.message && err.message.includes('Multipart')) {
    return res.status(400).json({ error: 'File upload failed: ' + err.message });
  }
  if (err) {
    console.error('Unhandled error:', err.message);
    return res.status(500).json({ error: 'Server error during upload.' });
  }
  next();
});

// ---------- Uploads Persistence (avatars/banners/attachments) ----------
// Like the DB, user-uploaded files live on the ephemeral container fs and are
// wiped on every deploy. We mirror them to the same private GitHub backup repo
// and restore them on startup so avatars/banners survive deploys.

async function backupUploadFile(filename) {
  if (!BACKUP_ENABLED) return;
  const fp = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fp)) { console.warn(`[backup] Cannot back up ${filename}: file not on disk.`); return; }
  const buf = fs.readFileSync(fp);
  // Skip if larger than ~80MB to avoid GitHub content limits / timeouts.
  if (buf.length > 80 * 1024 * 1024) { console.log(`[backup] Skipping large upload ${filename} (${buf.length} bytes).`); return; }
  const b64 = buf.toString('base64');
  // Retry up to 3 times — GitHub API can be flaky for large base64 payloads,
  // and a failed backup means the file is lost on the next deploy (causing
  // avatar 404s for other users).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Check if file exists remotely to get sha (needed to update vs create).
      const get = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
      const body = { message: 'upload backup ' + filename, content: b64, branch: BACKUP_BRANCH };
      if (get.status === 200 && get.data && get.data.sha) body.sha = get.data.sha;
      const r = await githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}`, body);
      if (r.status === 200 || r.status === 201) {
        console.log(`[backup] Backed up upload ${filename} (${buf.length} bytes, attempt ${attempt}).`);
        return; // success
      }
      console.error(`[backup] Upload backup failed for ${filename} (attempt ${attempt}):`, r.status, (r.data && r.data.message) || r.raw);
    } catch (e) {
      console.error(`[backup] Upload backup error for ${filename} (attempt ${attempt}):`, e);
    }
    // Wait before retry (exponential backoff).
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  console.error(`[backup] GIVING UP on ${filename} after 3 attempts — file will be lost on next deploy!`);
}

// Restore uploads from the backup repo on startup (files not already present).
// IMPORTANT: On Render's free tier (512MB RAM), downloading all uploads at
// startup can cause OOM crashes. We skip files larger than 5MB on startup —
// they are fetched on-demand when a user accesses them (see /uploads fallback
// above). We also cap total startup restore at 20MB to stay memory-safe.
const STARTUP_RESTORE_MAX_FILE = 5 * 1024 * 1024; // 5MB per file
const STARTUP_RESTORE_MAX_TOTAL = 20 * 1024 * 1024; // 20MB total
async function restoreUploads() {
  if (!BACKUP_ENABLED) return;
  try {
    const r = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
    if (r.status !== 200 || !Array.isArray(r.data)) {
      console.log(`[backup] No remote uploads dir to restore (status ${r.status}).`);
      return;
    }
    let restored = 0;
    let restoredBytes = 0;
    let skippedLarge = 0;
    for (const item of r.data) {
      if (item.type !== 'file') continue;
      const localPath = path.join(UPLOAD_DIR, item.name);
      if (fs.existsSync(localPath)) continue; // already present (e.g. badge icons)
      const fileSize = item.size || 0;
      // Skip large files on startup — they'll be fetched on-demand.
      if (fileSize > STARTUP_RESTORE_MAX_FILE) {
        skippedLarge++;
        continue;
      }
      // Stop if we've hit the total restore cap.
      if (restoredBytes + fileSize > STARTUP_RESTORE_MAX_TOTAL) {
        console.log(`[backup] Startup restore cap reached (${restoredBytes} bytes). Remaining files will be fetched on-demand.`);
        break;
      }
      try {
        const buf = await fetchBackupFile(item.name);
        if (buf && buf.length > 0) {
          fs.writeFileSync(localPath, buf);
          restored++;
          restoredBytes += buf.length;
        }
      } catch (e) { console.error(`[backup] Failed to restore upload ${item.name}:`, e); }
    }
    if (restored > 0) console.log(`[backup] Restored ${restored} user upload(s) (${restoredBytes} bytes) from GitHub.`);
    else console.log('[backup] No user uploads needed restoring.');
    if (skippedLarge > 0) console.log(`[backup] Skipped ${skippedLarge} large file(s) on startup — will fetch on-demand.`);
  } catch (e) {
    console.error('[backup] restoreUploads error:', e);
  }
}
// Temporarily disabled startup bulk restore to diagnose OOM crash.
// Files are still fetched on-demand via the /uploads fallback middleware.
// restoreUploads();

// ---------- Start ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hellobye backend running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
});

// Allow large file uploads (115MB) without timeout issues
server.timeout = 300000;       // 5 minutes for request timeout
server.keepAliveTimeout = 120000; // 2 minutes keep-alive
server.requestTimeout = 300000;   // 5 minutes for full request

// Save on exit
process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
