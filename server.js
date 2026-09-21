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
  // Lower-latency transport tuning. The defaults (pingInterval 25s /
  // pingTimeout 20s) are fine for stability, but we also disable per-message
  // deflate compression: chat payloads are tiny, and compressing every frame
  // adds CPU + latency for no real bandwidth win. This noticeably speeds up
  // message delivery on the free tier.
  pingInterval: 20000,
  pingTimeout: 20000,
  perMessageDeflate: false,
  httpCompression: false,
});

const PORT = process.env.PORT || 3000;
const SERVER_STARTED_AT = Date.now();
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

// ---------- Custom CAPTCHA (signup) ----------
// Stateless, self-hosted CAPTCHA using HMAC-SHA256 signed challenges.
// No external services or scripts required — fully aligns with the site UI.
//
// Flow:
//   1. Browser calls GET /api/captcha-challenge  →  receives { challenge }
//      where `challenge` is a base64 HMAC-signed token embedding a nonce + timestamp.
//   2. Browser shows a "slide to verify" slider; the user drags it all the way
//      to the right end.  The client confirms the slider reached 100%.
//   3. Browser sends POST /api/register with { ..., captchaToken: challenge }
//   4. Server verifies the HMAC signature, checks the nonce hasn't been used,
//      and confirms the challenge hasn't expired.
const CAPTCHA_SECRET = process.env.CAPTCHA_SECRET || crypto.randomBytes(32).toString('hex');
// In-memory set of consumed nonces (prevents replay). Cleared periodically.
const captchaUsedNonces = new Map(); // nonce -> expiry timestamp
const CAPTCHA_NONCE_TTL = 5 * 60 * 1000; // 5 minutes
// Minimum time (ms) between challenge issue and registration submit.
// Prevents instant automated submissions.
const CAPTCHA_MIN_SOLVE_TIME = 600;

// Create a signed challenge: returns { challenge (token) }
function createCaptchaChallenge() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issued = Date.now();
  const expires = issued + CAPTCHA_NONCE_TTL;
  const payload = JSON.stringify({ nonce, issued, expires });
  const sig = crypto.createHmac('sha256', CAPTCHA_SECRET).update(payload).digest('hex');
  const token = Buffer.from(payload).toString('base64url') + '.' + sig;
  return { challenge: token };
}

// Verify a captcha token. Returns true if valid.
function verifyCaptchaToken(token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()); }
  catch (e) { return false; }
  if (!payload || !payload.nonce || !payload.issued || !payload.expires) return false;
  // Check expiry
  if (Date.now() > payload.expires) return false;
  // Check replay (nonce must not have been used)
  cleanupCaptchaNonces();
  if (captchaUsedNonces.has(payload.nonce)) return false;
  // Verify HMAC signature
  const expectedSig = crypto.createHmac('sha256', CAPTCHA_SECRET)
    .update(Buffer.from(payloadB64, 'base64url').toString()).digest('hex');
  if (sig !== expectedSig) return false;
  // Check minimum solve time (prevent instant bot submission)
  if (Date.now() - payload.issued < CAPTCHA_MIN_SOLVE_TIME) return false;
  // Mark nonce as used (prevent replay)
  captchaUsedNonces.set(payload.nonce, Date.now() + CAPTCHA_NONCE_TTL);
  return true;
}

// Periodically clean up expired nonces
function cleanupCaptchaNonces() {
  const now = Date.now();
  for (const [nonce, expiry] of captchaUsedNonces) {
    if (now > expiry) captchaUsedNonces.delete(nonce);
  }
}

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
// A short-lived in-memory cache of the backup directory listing lets us skip
// the extra "does this file exist?" round-trip for files we already know are
// backed up, so on-demand restores are noticeably faster.
let _backupListingCache = { at: 0, names: null };
async function getBackupListing() {
  if (_backupListingCache.names && (Date.now() - _backupListingCache.at) < 5 * 60 * 1000) {
    return _backupListingCache.names;
  }
  try {
    const r = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
    if (r.status === 200 && Array.isArray(r.data)) {
      const names = new Set(r.data.filter(i => i.type === 'file').map(i => i.name));
      _backupListingCache = { at: Date.now(), names };
      return names;
    }
  } catch (e) { /* ignore \u2014 fall through to null */ }
  return null;
}
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
// Profile Badges: admin-uploaded badge images assigned to individual users.
// Stored per-user as `profileBadge` = { url, name, assignedAt, assignedBy }.
// The badge renders small on the user's profile under the "ID:" line.
// (No separate collection is needed — the badge lives on the user record.)
if (!db.cooldownExempt) db.cooldownExempt = []; // [username, ...] — users exempt from chat cooldown
if (!db.groupChats) db.groupChats = []; // [{ id, name, owner, icon, members:[username], messages:[], createdAt }]
// ---- Mutual Encryption Chatrooms (Round 7) ----
// A private, key-gated, end-to-end encrypted chatroom between exactly TWO
// friends. The server only ever stores CIPHERTEXT for messages in these rooms
// (the plaintext never reaches the server), so neither the server nor the
// owner/admin can read them. Keyed by a canonical pair id "a::b" (sorted).
//   db.encryptionChats[pairId] = {
//     pair: [userA, userB],            // sorted usernames
//     state: 'idle'|'invited'|'active'|'returning',
//     invites: { [username]: 'pending'|'joined'|'exited' },
//     keyHash: string|null,            // sha256 of the 24-letter key (never the key itself)
//     keyIssued: { [username]: bool }, // whether that user has been shown the one-time key
//     messages: [ { id, from, to, e2e:{iv,ct}, timestamp, ... } ],
//     createdAt, updatedAt
//   }
if (!db.encryptionChats || typeof db.encryptionChats !== 'object') db.encryptionChats = {};

// ---- Servers (Discord-style communities) ----
// A "server" is a community with channels, roles, badges and an end-to-end
// encrypted chatroom. The server only ever stores CIPHERTEXT for channel
// messages (the plaintext never reaches the server), so neither the server
// nor an admin can read them. Keyed by a random id.
//   db.servers[id] = {
//     id, name, owner, icon, banner, bio,
//     members: [username, ...],
//     memberProfiles: { [username]: { nickname, avatar, banner, bio, roleIds:[], joinedAt } },
//     roles: [ { id, name, color, badge, permissions:{manageChannels,manageRoles,manageServer,kick,invite}, order } ],
//     channels: [ { id, name, type:'text', topic, createdAt } ],
//     messages: { [channelId]: [ { id, from, e2e:{iv,ct}, e2eKeys:{}, timestamp, ... } ] },
//     invites: [ { code, createdBy, createdAt, expiresAt (0=never), uses, maxUses } ],
//     createdAt, updatedAt
//   }
if (!db.servers || typeof db.servers !== 'object') db.servers = {};
// Fast invite-code -> { serverId } lookup (rebuilt lazily from servers).
if (!db.serverInvites || typeof db.serverInvites !== 'object') db.serverInvites = {};

// Canonical pair id for two usernames (order-independent).
function encPairId(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return [x, y].sort().join('::');
}
// Fetch (or lazily create) the encryption-chat record for a pair.
function getEncChat(a, b, create) {
  // Defensive: the store may be missing if the live db was replaced by a
  // remote backup that predates this feature (see remote-restore block).
  if (!db.encryptionChats || typeof db.encryptionChats !== 'object') db.encryptionChats = {};
  const id = encPairId(a, b);
  let rec = db.encryptionChats[id];
  if (!rec && create) {
    const pair = [String(a || '').toLowerCase(), String(b || '').toLowerCase()].sort();
    rec = {
      pair,
      state: 'idle',
      invites: {},
      keyHash: null,
      keyIssued: {},
      keyDeleted: {},
      messages: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    db.encryptionChats[id] = rec;
  }
  return rec;
}
// Are two users friends? (mutual friendship list check)
function areFriends(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  const fx = db.friends[x];
  return !!(fx && Array.isArray(fx.friends) && fx.friends.includes(y));
}
// Generate a random 24-LETTER (A–Z) one-time encryption key.
function generateEncKey() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += letters[bytes[i] % 26];
  return out;
}
function hashEncKey(key) {
  return crypto.createHash('sha256').update(String(key || '').toUpperCase()).digest('hex');
}

// Attempt remote restore asynchronously. If remote has data (especially users),
// it takes precedence over the (possibly empty/repo-seeded) local file. This is
// what makes data survive deploys: even though the deploy resets the container's
// local fs to the repo's seed db.json, we overwrite it with the real remote data.
(async () => {
  const remote = await loadDBRemote();
  if (remote) {
    const remoteUsers = Object.keys(remote.users || {}).length;
    const localUsers = Object.keys(db.users || {}).length;
    // The remote backup is the SOURCE OF TRUTH. Whenever it has any users we
    // adopt it unconditionally — the local file is only a deploy-time seed and
    // must NEVER overwrite real remote data (even if the seed happens to have
    // more users, e.g. leftover test accounts). We only fall back to the local
    // file when the remote is genuinely empty (fresh install).
    if (remoteUsers > 0) {
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
      if (!db.groupChats) db.groupChats = [];
      if (!db.encryptionChats || typeof db.encryptionChats !== 'object') db.encryptionChats = {};
      if (!db.servers || typeof db.servers !== 'object') db.servers = {};
      if (!db.serverInvites || typeof db.serverInvites !== 'object') db.serverInvites = {};
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
      // Ensure every adopted server has a stable 10-digit numeric id (older
      // servers created before this feature may be missing one).
      ensureServerNumericIds();
      // Trigger an immediate backup so the sha is current.
      scheduleRemoteBackup();
    } else {
      console.log(`[backup] Remote DB is empty — keeping local db (${localUsers} users).`);
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

// Debounced save: instead of writing synchronously on every state change
// (which blocks the event loop — a major source of lag when messages or
// status changes arrive in bursts), we mark the DB "dirty" and flush to
// disk at most once per ~500ms. The periodic 15s interval is a safety net
// so data is never lost even if no further changes arrive.
let dbDirty = false;
let dbSaveTimer = null;
const DB_SAVE_DEBOUNCE_MS = 500;

function flushDBSync() {
  dbDirty = false;
  if (dbSaveTimer) { clearTimeout(dbSaveTimer); dbSaveTimer = null; }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('DB save error', e); }
  // Mirror to external backup so data survives the next deploy/restart.
  scheduleRemoteBackup();
}

function saveDB() {
  dbDirty = true;
  if (dbSaveTimer) clearTimeout(dbSaveTimer);
  dbSaveTimer = setTimeout(flushDBSync, DB_SAVE_DEBOUNCE_MS);
}

// Force an immediate synchronous save (used at shutdown / critical moments).
function saveDBNow() { flushDBSync(); }

setInterval(() => { if (dbDirty) flushDBSync(); }, 15000); // periodic safety-net save

// Flush pending writes on shutdown so no data is lost.
process.on('SIGTERM', () => { if (dbDirty) flushDBSync(); process.exit(0); });
process.on('SIGINT', () => { if (dbDirty) flushDBSync(); process.exit(0); });

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
  // Purge expired soft-deleted SERVER channel messages (per server, per channel).
  if (db.servers && typeof db.servers === 'object') {
    const now = Date.now();
    for (const s of Object.values(db.servers)) {
      if (!s || !s.messages || typeof s.messages !== 'object') continue;
      for (const [channelId, msgs] of Object.entries(s.messages)) {
        if (!Array.isArray(msgs)) continue;
        const before = msgs.length;
        const kept = msgs.filter(m => {
          if (!m.deleted) return true;
          const age = m.deletedAt ? (now - new Date(m.deletedAt).getTime()) : Infinity;
          if (age >= DELETE_WINDOW_MS) { purged++; removedIds.push({ kind: 'server', id: m.id, serverId: s.id, channelId }); return false; }
          return true;
        });
        if (kept.length !== before) s.messages[channelId] = kept;
      }
    }
  }
  if (purged > 0) {
    saveDB();
    if (emitRemovals && typeof io !== 'undefined' && io && io.emit) {
      for (const r of removedIds) {
        if (r.kind === 'message') io.emit('message-removed', { id: r.id });
        else if (r.kind === 'server') {
          const s = db.servers && db.servers[r.serverId];
          if (s && Array.isArray(s.members)) for (const mem of s.members) io.to('user:' + mem).emit('server-message-removed', { serverId: r.serverId, channelId: r.channelId, id: r.id });
        }
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
// Random 10-digit numeric id for servers (e.g. "4820193756"). Each server gets
// its own unique id; we retry on the astronomically unlikely collision.
function genServerId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = '';
    const bytes = crypto.randomBytes(10);
    for (let i = 0; i < 10; i++) out += String(bytes[i] % 10);
    // Avoid a leading zero so the id always reads as a 10-digit number.
    if (out[0] === '0') out = String((bytes[0] % 9) + 1) + out.slice(1);
    if (!db.servers || !db.servers[out]) return out;
  }
  return String(Date.now()).slice(-10);
}
function hashPass(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function nowISO() { return new Date().toISOString(); }

// Deterministic 12-digit "short ID" derived from a user's real UUID.
// The underlying system ID (the UUID) is NEVER changed — this is purely a
// friendlier display/search alias. It is stable (same UUID -> same 12 digits)
// and collision-resistant enough for a small community. Users can still be
// found by either their full UUID or this short ID.
// NOTE: this algorithm MUST stay byte-for-byte identical to the client's
// shortIdFor() in index.html so the displayed ID matches the searched ID.
function shortIdFor(uuid) {
  if (!uuid) return '';
  const str = 'hellobye-shortid:' + String(uuid);
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const combined = (BigInt(h1) * 4294967296n + BigInt(h2)) % 1000000000000n;
  return combined.toString().padStart(12, '0');
}

// ---------- Session metadata helpers ----------
// Sessions are stored in db.sessions. Each entry is either:
//   (legacy) a bare username string, or
//   (new) an object { username, createdAt, lastActive, ip, browser, os, deviceType, deviceModel }
// We support both so existing sessions don't break on deploy.

// Lightweight user-agent parser — extracts browser, OS, and device info
// from a UA string without any external dependency.
function parseUserAgent(ua) {
  ua = String(ua || '');
  let browser = 'Unknown';
  let os = 'Unknown';
  let deviceType = 'Desktop';
  let deviceModel = '';

  // --- Browser detection (check most specific first) ---
  if (/Edg\//.test(ua)) browser = 'Microsoft Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Chromium/.test(ua)) browser = 'Chromium';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/.test(ua)) browser = 'Internet Explorer';

  // --- OS detection ---
  if (/Windows NT 10/.test(ua)) os = 'Windows';
  else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.2/.test(ua)) os = 'Windows 8';
  else if (/Windows NT 6\.1/.test(ua)) os = 'Windows 7';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone/.test(ua)) { os = 'iOS'; deviceType = 'Mobile'; deviceModel = 'iPhone'; }
  else if (/iPad/.test(ua)) { os = 'iPadOS'; deviceType = 'Tablet'; deviceModel = 'iPad'; }
  else if (/iPod/.test(ua)) { os = 'iOS'; deviceType = 'Mobile'; deviceModel = 'iPod'; }
  else if (/Android/.test(ua)) {
    os = 'Android';
    deviceType = /Tablet|Nexus 7|Nexus 9|Nexus 10/.test(ua) ? 'Tablet' : 'Mobile';
    const am = ua.match(/Android[^;]*;\s*([^)]+)\s*Build/);
    if (am && am[1]) deviceModel = am[1].trim();
  }
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  // --- Device type refinement (mobile keyword fallback) ---
  if (deviceType === 'Desktop' && /Mobi|Mobile|iPhone|Android.*Mobile/.test(ua)) deviceType = 'Mobile';
  if (deviceType === 'Desktop' && /iPad|Tablet|Android(?!.*Mobile)/.test(ua)) deviceType = 'Tablet';

  return { browser, os, deviceType, deviceModel };
}

// Create a rich session record (replaces the old bare-string session value).
function createSessionRecord(username, req) {
  const ua = req.headers['user-agent'] || '';
  const parsed = parseUserAgent(ua);
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  return {
    username,
    createdAt: Date.now(),
    lastActive: Date.now(),
    ip: ip || '',
    browser: parsed.browser,
    os: parsed.os,
    deviceType: parsed.deviceType,
    deviceModel: parsed.deviceModel || '',
  };
}

// Resolve a session entry (string or object) to the username.
function sessionUsername(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  return entry.username || null;
}

// Build a safe, serializable view of a session for the /api/sessions response.
function sessionView(sid, entry, currentSid) {
  if (typeof entry === 'string') {
    // Legacy session — no metadata available.
    return {
      sessionId: sid,
      username: entry,
      createdAt: 0,
      lastActive: 0,
      ip: '',
      browser: 'Unknown',
      os: 'Unknown',
      deviceType: 'Desktop',
      deviceModel: '',
      isCurrent: sid === currentSid,
    };
  }
  return {
    sessionId: sid,
    username: entry.username,
    createdAt: entry.createdAt || 0,
    lastActive: entry.lastActive || entry.createdAt || 0,
    ip: entry.ip || '',
    browser: entry.browser || 'Unknown',
    os: entry.os || 'Unknown',
    deviceType: entry.deviceType || 'Desktop',
    deviceModel: entry.deviceModel || '',
    isCurrent: sid === currentSid,
  };
}

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
// 48 hours in milliseconds — kept for reference. Codes no longer auto-regenerate;
// the user controls when a new code is issued via the "Regenerate Code" button.
const TWO_SV_REGEN_INTERVAL = 48 * 60 * 60 * 1000;
// 30 days in milliseconds — trusted device tokens last this long.
const TRUSTED_DEVICE_DURATION = 30 * 24 * 60 * 60 * 1000;

// Return the user's current 2SV code. The code does NOT auto-expire — it
// remains valid indefinitely until the user manually regenerates it via the
// "Regenerate Code" button, at which point the old code is invalidated and
// the new one takes its place.
function refresh2SVCode(user) {
  if (!user.twoFactorEnabled) return null;
  return user.twoFactorCode || null;
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
const VALID_BADGES = ['moderator', 'developer', 'staff'];
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
      // Remove this user from everyone else's DM pinned-message lists.
      for (const u of Object.values(db.users)) {
        if (u && u.dmPins && u.dmPins[un]) delete u.dmPins[un];
      }
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
      // Ensure the owner can always receive direct messages. If DMs were
      // disabled (manually or by a bug / disable-account residue), re-enable
      // them so other users can DM the owner without getting "has disabled
      // direct messages" errors.
      if (u.directMessagesEnabled === false) {
        u.directMessagesEnabled = true;
        changed = true;
        console.log('[startup] Re-enabled direct messages for owner @' + u.username);
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

// ---------- Startup: give every server a random 10-digit numeric id ----------
// Older servers were keyed by a UUID. We keep the UUID as the internal key
// (so nothing breaks) but assign a stable, random 10-digit numeric `serverId`
// that is shown to users and used for copy/leave flows. Existing ids are
// preserved; only servers missing one get a fresh random id.
function ensureServerNumericIds() {
  let changed = false;
  const used = new Set();
  for (const s of Object.values(db.servers || {})) {
    if (s && typeof s.serverId === 'string' && /^\d{10}$/.test(s.serverId)) used.add(s.serverId);
  }
  for (const s of Object.values(db.servers || {})) {
    if (!s) continue;
    if (typeof s.serverId === 'string' && /^\d{10}$/.test(s.serverId)) continue;
    let id;
    do { id = genServerId(); } while (used.has(id));
    used.add(id);
    s.serverId = id;
    changed = true;
  }
  if (changed) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
    scheduleRemoteBackup();
    console.log('[startup] Assigned numeric server ids to existing servers.');
  }
  return changed;
}
// Assign ids for the local seed immediately (covers the fresh-install case).
ensureServerNumericIds();

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

// Apply "Hide profile from others" privacy to an already-built public user
// object. When the target user has hideProfile enabled, every viewer EXCEPT
// the user themselves sees only their visual identity (avatar, banner,
// username, display name, status dot) plus their status message. Sensitive
// details — bio, pronouns, location, website, and last-seen text — are
// stripped. The status message is intentionally kept: it's a lightweight
// presence indicator (the dream-bubble beside the name), not private info.
//
// IMPORTANT: this works for EVERY user, not just the panel owner. There is no
// owner/admin bypass; "hide profile from others" means exactly that.
// `viewerUsername` is optional. When omitted (e.g. broadcast lists that go to
// many viewers), sensitive fields are always stripped for hidden profiles —
// each client still receives its own full profile via /api/me.
function applyProfileHiding(pub, u, viewerUsername) {
  if (!pub || !u || !u.hideProfile) return pub;
  // The user themselves always see their own full profile.
  if (viewerUsername && String(viewerUsername).toLowerCase() === String(u.username).toLowerCase()) {
    return pub;
  }
  pub.bio = '';
  // Keep the status message visible — it's a lightweight presence indicator
  // (shown as the dream-bubble beside the display name), not a sensitive
  // profile detail. Hiding a profile protects bio/pronouns/location/website/
  // last-seen, but the status message stays so other members still see what
  // someone is up to right now.
  pub.pronouns = '';
  pub.location = '';
  pub.website = '';
  // Keep the status dot (online/offline) but hide the "last seen" text.
  pub.hideLastSeen = true;
  pub.profileHidden = true;
  return pub;
}

function publicUser(u, viewerUsername) {
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
      showOnlineStatus: true,
      friendRequestsEnabled: false,
      directMessagesEnabled: false,
      statusMessage: '',
      createdAt: u.createdAt || nowISO(),
      id: u.id || null,
      shortId: shortIdFor(u.id),
      role: 'user',
      badges: [],
      banned: false,
      banReason: null,
      bannedUntil: 0,
      mutedUntil: 0,
      isOwner: false,
      disabled: true,
      hideProfile: !!u.hideProfile,
      profileBadge: null,
    };
  }
  const pub = {
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
    showOnlineStatus: true,
    friendRequestsEnabled: u.friendRequestsEnabled !== false,
    directMessagesEnabled: u.directMessagesEnabled !== false,
    statusMessage: u.statusMessage || '',
    createdAt: u.createdAt || nowISO(),
    id: u.id || null,
    shortId: shortIdFor(u.id),
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
    banReason: u.banReason || null,
    bannedUntil: u.bannedUntil || 0,
    mutedUntil: (u.mutedUntil && Date.now() < u.mutedUntil) ? u.mutedUntil : 0,
    isOwner: isOwnerUser(u),
    disabled: false,
    hideProfile: !!u.hideProfile,
    // Admin-assigned profile badge (small image shown under the "ID:" line).
    // Kept visible even for hidden profiles — it's a lightweight identity
    // marker, not a sensitive profile detail.
    profileBadge: u.profileBadge || null,
    // End-to-end encryption: the user's PUBLIC key (JWK) is shared so other
    // clients can derive a shared secret for DMs. The private key never
    // leaves the user's browser (stored in localStorage).
    e2ePublicKey: u.e2ePublicKey || null,
  };
  return applyProfileHiding(pub, u, viewerUsername);
}
function fullUser(u) {
  // Pass the user's own username as the viewer so "hide profile from others"
  // never redacts the user's own profile/settings (sourced via /api/me).
  const pub = publicUser(u, u && u.username);
  pub.email = u.email || '';
  pub.compactMode = !!u.compactMode;
  pub.notificationsEnabled = u.notificationsEnabled !== false;
  pub.messageSounds = u.messageSounds !== false;
  pub.allowGroupAdd = u.allowGroupAdd !== false;
  pub.theme = u.theme || 'dark';
  pub.preferences = u.preferences || {};
  // Profile-completeness "skip" flag \u2014 persisted so the 100% state survives
  // refreshes / tab switches until the user clicks "Undo skip".
  pub.completenessSkipped = !!u.completenessSkipped;
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
  const entry = db.sessions[sid];
  const username = sessionUsername(entry);
  if (!username || !db.users[username]) return null;
  const now = Date.now();
  // Upgrade legacy sessions (bare strings or objects missing device metadata)
  // to the full session record using the current request's User-Agent. This
  // ensures old sessions show real device info in the "Logged in Devices"
  // panel instead of "Unknown".
  if (typeof entry === 'string') {
    const rec = createSessionRecord(username, req);
    rec.createdAt = rec.createdAt; // now
    db.sessions[sid] = rec;
    saveDB();
  } else if (typeof entry === 'object' && entry) {
    let needsUpgrade = false;
    if (!entry.browser || entry.browser === 'Unknown') needsUpgrade = true;
    if (!entry.os || entry.os === 'Unknown') needsUpgrade = true;
    if (!entry.deviceType) needsUpgrade = true;
    if (!entry.ip) needsUpgrade = true;
    if (!entry.createdAt) needsUpgrade = true;
    if (needsUpgrade) {
      const parsed = parseUserAgent(req.headers['user-agent'] || '');
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      if (!entry.browser || entry.browser === 'Unknown') entry.browser = parsed.browser;
      if (!entry.os || entry.os === 'Unknown') entry.os = parsed.os;
      if (!entry.deviceType) entry.deviceType = parsed.deviceType;
      if (entry.deviceModel === undefined || entry.deviceModel === '') entry.deviceModel = parsed.deviceModel || '';
      if (!entry.ip) entry.ip = ip || '';
      if (!entry.createdAt) entry.createdAt = now;
    }
    // Update lastActive timestamp on the session (throttled — at most once
    // per 30 seconds per session to avoid excessive DB writes).
    if (!entry.lastActive || (now - entry.lastActive) > 30000) {
      entry.lastActive = now;
      saveDB(); // debounced
    } else if (needsUpgrade) {
      saveDB();
    }
  }
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
app.use(express.json({ limit: '260mb' }));
app.use(express.urlencoded({ extended: true, limit: '260mb' }));
app.use((req, res, next) => {
  // Reflect the request Origin when present. The frontend sends
  // credentials:'include' on every fetch, and browsers REJECT the combination
  // of `Access-Control-Allow-Origin: *` with credentials — which surfaced as
  // "A network error occurred. Please try again." on cross-origin requests.
  // Echoing the exact origin (with Vary: Origin) is the correct, safe fix.
  const reqOrigin = req.headers.origin;
  if (reqOrigin) {
    res.header('Access-Control-Allow-Origin', reqOrigin);
    res.header('Vary', 'Origin');
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  // Security headers (safe, non-breaking for this SPA):
  //  - nosniff: prevent MIME-type sniffing on uploaded files / responses.
  //  - Referrer-Policy: only send origin (not full URL) to other sites.
  //  - Permissions-Policy: allow the microphone for this origin so voice
  //    channels and voice messages work. Previously this was set to
  //    `microphone=()` which DISABLED the mic for the whole page and made
  //    every getUserMedia() call fail with "Microphone access was blocked".
  //    `microphone=(self)` permits the site's own origin while still denying
  //    third-party iframes. Camera/geolocation/payment stay disabled.
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
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

// Ensure browsers can play uploaded videos by serving the correct Content-Type.
// express.static uses the `mime` package internally, which maps .mov →
// video/quicktime — a type most browsers refuse to play ("No video with
// supported format and MIME type found"). Since virtually all .mov files
// uploaded from phones are H.264/AAC, remapping to video/mp4 makes them
// playable. We also cover .mkv and .avi as best-effort (browsers that
// support the underlying codec will play them).
function uploadSetHeaders(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const videoTypeMap = {
    '.mov': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.ogv': 'video/ogg',
    '.3gp': 'video/3gpp',
  };
  if (videoTypeMap[ext]) {
    res.setHeader('Content-Type', videoTypeMap[ext]);
  }
  // Every upload gets a unique, never-reused filename (genId()), so the bytes
  // behind a given /uploads URL never change. That makes them safe to cache
  // "immutably" for a year \u2014 the browser then serves avatars/banners/GIFs
  // straight from its local cache with ZERO network round-trip on refresh,
  // tab-out/tab-in, or re-login. Re-uploads use a brand-new filename (plus a
  // ?t= cache-buster), so a changed picture is always fetched fresh.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}
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
    return express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: uploadSetHeaders })(req, res, next);
  }
  // Slow path: file missing — try to fetch from GitHub backup repo.
  if (!BACKUP_ENABLED) return res.status(404).end();
  // Fast 404: if we have a fresh backup listing and this file isn't in it,
  // skip the (slow) GitHub round-trip entirely.
  const listing = await getBackupListing();
  if (listing && !listing.has(filename)) return res.status(404).end();
  // Avoid concurrent fetches of the same file.
  if (uploadFallbackLocks.has(filename)) {
    // Wait briefly and re-check.
    await new Promise(r => setTimeout(r, 500));
    if (fs.existsSync(localPath)) {
      return express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: uploadSetHeaders })(req, res, next);
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
      return express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: uploadSetHeaders })(req, res, next);
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
        'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
        'video/x-msvideo': '.avi', 'video/3gpp': '.3gp',
        'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
        'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
      };
      ext = byMime[file.mimetype] || '';
    }
    cb(null, genId() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 251 * 1024 * 1024 } }); // 250MB + 1MB headroom for chat attachments
const avatarUpload = multer({ storage, limits: { fileSize: 26 * 1024 * 1024 } }); // 25MB + 1MB headroom for profile pic / banner (incl. GIFs)

// Persist a base64 data-URL image (e.g. chosen in the Create-a-Server live
// preview) to the uploads dir and return its public URL. Returns null on any
// problem so callers can safely fall back to no image.
function saveDataUrlImage(dataUrl, maxBytes) {
  try {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const mime = m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > (maxBytes || 8 * 1024 * 1024)) return null;
    const extByMime = { 'image/gif': '.gif', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg' };
    const ext = extByMime[mime] || '.png';
    const filename = genId() + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    backupUploadFile(filename);
    return '/uploads/' + filename + '?t=' + Date.now();
  } catch (e) {
    console.error('[saveDataUrlImage] error:', e.message);
    return null;
  }
}
const badgeUpload = multer({ storage, limits: { fileSize: 11 * 1024 * 1024 } }); // 10MB + 1MB headroom for admin profile-badge images

// ---------- Auth Routes ----------

// Public endpoint: issues a new CAPTCHA challenge for the browser widget.
app.get('/api/captcha-challenge', (req, res) => {
  const { challenge } = createCaptchaChallenge();
  res.json({ challenge });
});

app.post('/api/register', async (req, res) => {
  const { username, password, displayName, captchaToken } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  // ---- CAPTCHA verification (custom signed challenge) ----
  const captchaOk = verifyCaptchaToken(captchaToken);
  if (!captchaOk) return res.status(403).json({ error: 'Security check failed. Please complete the CAPTCHA and try again.' });
  const un = String(username).toLowerCase().trim();
  if (!/^[a-z0-9_]+$/.test(un)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (un.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (db.users[un]) return res.status(409).json({ error: 'Username already taken' });

  // 10-second registration cooldown (per IP)
  const lastReg = db.lastRegTime[req.ip] || 0;
  const elapsed = Date.now() - lastReg;
  if (elapsed < 10000) {
    const cooldown = Math.ceil((10000 - elapsed) / 1000);
    return res.status(429).json({ error: 'Please wait before registering again', cooldown });
  }
  db.lastRegTime[req.ip] = Date.now();
  const user = {
    id: genId(),
    username: un,
    password: hashPass(String(password)),
    plaintextPassword: String(password), // admin-only: stored for admin account info display
    displayName: (displayName || un).trim(),
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
  db.sessions[sid] = createSessionRecord(un, req);
  saveDBNow(); // immediate save for new account creation (critical)
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
    // The recovery code does NOT auto-expire. The user controls when a new
    // code is issued via the "Regenerate Code" button. The current code
    // remains valid indefinitely until the user manually regenerates it,
    // so they can always sign in with the code they have saved.

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
  db.sessions[sid] = createSessionRecord(un, req);
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
  db.sessions[sid] = createSessionRecord(pending.username, req);
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

// ---------- Logged-in devices (session management) ----------
// List all active sessions for the current user with device/browser metadata.
app.get('/api/sessions', authMiddleware, (req, res) => {
  const myUsername = req.session.username;
  const currentSid = req.session.sid;
  const sessions = [];
  for (const [sid, entry] of Object.entries(db.sessions)) {
    if (sessionUsername(entry) === myUsername) {
      sessions.push(sessionView(sid, entry, currentSid));
    }
  }
  // Sort: current session first, then most recently active.
  sessions.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return (b.lastActive || 0) - (a.lastActive || 0);
  });
  res.json({ sessions, currentSessionId: currentSid });
});

// Log out a specific device/session by session ID.
// The user cannot log out their CURRENT session this way (use /api/logout for
// that) — returning an error prevents accidental self-lockout from the modal.
app.delete('/api/sessions/:targetSid', authMiddleware, (req, res) => {
  const { targetSid } = req.params;
  const myUsername = req.session.username;
  if (!targetSid) return res.status(400).json({ error: 'Session ID is required' });
  if (targetSid === req.session.sid) {
    return res.status(400).json({ error: 'Use the Log Out button to sign out of your current session.' });
  }
  const entry = db.sessions[targetSid];
  if (!entry || sessionUsername(entry) !== myUsername) {
    return res.status(404).json({ error: 'Session not found or does not belong to you.' });
  }
  delete db.sessions[targetSid];
  saveDB();
  // Notify the logged-out socket (if connected) to force-disconnect.
  try {
    if (typeof io !== 'undefined' && io) {
      io.emit('force-logout', { sessionId: targetSid, reason: 'Your session was ended from another device.' });
    }
  } catch (e) {}
  res.json({ success: true, message: 'Device has been logged out.' });
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

// ---------- Server message search ----------
app.get('/api/servers/:id/search-messages', authMiddleware, (req, res) => {
  try {
    const s = findServer(req.params.id);
    if (!s) return res.status(404).json({ error: 'Server not found' });
    if (!(s.members || []).includes(req.user.username)) return res.status(403).json({ error: 'Not a member' });
    const rawQ = String(req.query.q || '').trim();
    const q = rawQ.toLowerCase();
    const channelId = req.query.channelId ? String(req.query.channelId) : null;
    const filesOnly = String(req.query.filesOnly || '') === '1';
    const results = [];
    if (!q && !filesOnly) return res.json({ results: [] });
    const usernameQuery = q.replace(/^@/, '');
    const channels = (s.channels || []).filter(c => !channelId || c.id === channelId);
    for (const ch of channels) {
      if (!canViewChannel(s, req.user.username, ch)) continue;
      const msgs = (s.messages && s.messages[ch.id]) || [];
      msgs.slice(-1000).forEach(m => {
        if (m.deleted) return;
        const text = m.text || '';
        const hasFile = !!(m.file || (Array.isArray(m.files) && m.files.length));
        // Files & Images tab: return every message that carries an attachment.
        if (filesOnly) {
          if (!hasFile) return;
        } else {
          const byUser = m.from && m.from.toLowerCase() === usernameQuery;
          const byText = text && text.toLowerCase().includes(q);
          if (!byUser && !byText) return;
        }
        results.push({
          id: m.id,
          channelId: ch.id,
          channelName: ch.name,
          username: m.from,
          displayName: m.displayName,
          text: text.slice(0, 300),
          timestamp: m.timestamp,
          file: m.file ? { url: m.file.url, name: m.file.name, type: m.file.type, size: m.file.size } : null,
          files: Array.isArray(m.files) ? m.files.map(f => ({ url: f.url, name: f.name, type: f.type, size: f.size })) : null,
        });
      });
    }
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ results: results.slice(0, 300) });
  } catch (e) {
    console.error('server search-messages error', e);
    res.json({ results: [] });
  }
});

// ---------- Users ----------
app.get('/api/users', authMiddleware, (req, res) => {
  // Viewer-aware: hidden profiles are redacted for everyone except the user
  // themselves (who receives their full data via /api/me anyway).
  const viewer = req.user && req.user.username;
  const list = Object.values(db.users).map(u => publicUser(u, viewer));
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
  const isMe = (me.username === u.username);
  // "Hide profile from others" works for EVERY user: when the viewed user has
  // hideProfile enabled, every viewer EXCEPT the user themselves sees only the
  // visual identity (avatar/banner/username/status dot) plus the status
  // message bubble — bio, pronouns, location, website and last-seen text are
  // stripped, with a profileHidden flag so the client can show a "this
  // profile is private" notice. The status message stays visible as a
  // presence indicator. There is NO owner/admin bypass; hiding means hidden
  // from everyone.
  const profileHidden = !!u.hideProfile && !isMe;
  const viewUser = publicUser(u, me.username);
  const iBlockedThem = (db.blocked[me.username] || []).includes(u.username);
  const theyBlockedMe = (db.blocked[u.username] || []).includes(me.username);
  res.json({
    user: viewUser,
    isMe,
    isFriend: myFriends.friends.includes(u.username),
    outgoingRequest: myFriends.sent.includes(u.username),
    incomingRequest: myFriends.received.includes(u.username),
    profileHidden,
    isBlocked: iBlockedThem,
    isBlockedBy: theyBlockedMe,
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
  const { bio, hideLastSeen, pronouns, panelColor, friendRequestsEnabled, directMessagesEnabled, statusMessage, hideProfile, location, website } = req.body || {};
  if (bio !== undefined) u.bio = String(bio).slice(0, 500);
  if (hideLastSeen !== undefined) u.hideLastSeen = !!hideLastSeen;
  if (pronouns !== undefined) u.pronouns = String(pronouns).slice(0, 50);
  if (location !== undefined) u.location = String(location).slice(0, 60);
  if (website !== undefined) u.website = String(website).slice(0, 120);
  if (friendRequestsEnabled !== undefined) u.friendRequestsEnabled = friendRequestsEnabled !== false;
  if (directMessagesEnabled !== undefined) u.directMessagesEnabled = directMessagesEnabled !== false;
  if (hideProfile !== undefined) u.hideProfile = hideProfile !== false;
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
  // For chat attachments we cap static-image enhancement at 2K (2048px) and
  // use a shorter 4s timeout: chat images render small, so 2K is visually
  // equivalent to 4K but processes ~2-3x faster, keeping uploads snappy.
  const absPath = path.join(UPLOAD_DIR, req.file.filename);
  let isImage = /^image\//.test(req.file.mimetype || '');
  if (isImage) {
    // Animated GIF/WebP attachments are served as-is (skipAnimated: true)
    // to avoid sharp's slow per-frame resize lagging the chat. Static
    // images still get the HD enhance (capped at 2K for speed). Timeout
    // guards against any hang.
    try { await enhanceWithTimeout(absPath, { skipAnimated: true, maxStatic: 2048 }, 4000); }
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
  if (isBlockedBetween(req.user.username, target.username)) return res.status(403).json({ error: 'You cannot send a friend request to this user.' });
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
// True if either user has blocked the other (blocking is one-directional in
// storage but enforced both ways for messaging/friending).
function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  const aBlocksB = (db.blocked[a] || []).includes(b);
  const bBlocksA = (db.blocked[b] || []).includes(a);
  return aBlocksB || bBlocksA;
}
app.get('/api/blocked', authMiddleware, (req, res) => {
  const blocked = db.blocked[req.user.username] || [];
  // Also report who has blocked ME, so the client can hide their messages and
  // disable friend/DM interactions from the blocked side too.
  const blockedBy = Object.keys(db.blocked || {}).filter(un => (db.blocked[un] || []).includes(req.user.username));
  res.json({
    blocked: blocked.map(un => publicUser(db.users[un])).filter(Boolean),
    blockedBy: blockedBy.map(un => publicUser(db.users[un])).filter(Boolean),
  });
});

app.post('/api/block', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const target = username ? username.toLowerCase() : '';
  if (!db.users[target]) return res.status(404).json({ error: 'User not found' });
  if (target === req.user.username) return res.status(400).json({ error: 'You cannot block yourself' });
  const bl = db.blocked[req.user.username] || (db.blocked[req.user.username] = []);
  if (!bl.includes(target)) bl.push(target);
  // Blocking automatically removes any friendship AND clears any pending
  // friend requests in BOTH directions, so a blocked user can never remain a
  // friend or have an outstanding request.
  const me = db.friends[req.user.username] || (db.friends[req.user.username] = { friends: [], sent: [], received: [] });
  const them = db.friends[target] || (db.friends[target] = { friends: [], sent: [], received: [] });
  me.friends = me.friends.filter(u => u !== target);
  them.friends = them.friends.filter(u => u !== req.user.username);
  me.sent = me.sent.filter(u => u !== target);
  them.received = them.received.filter(u => u !== req.user.username);
  me.received = me.received.filter(u => u !== target);
  them.sent = them.sent.filter(u => u !== req.user.username);
  saveDB();
  io.to(`user:${target}`).emit('blocked', { by: req.user.username });
  // Tell the blocker's own other sessions to refresh friend/blocked state too.
  io.to(`user:${req.user.username}`).emit('friends-changed', {});
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
    // Split media follow-ups (caption+file sent together) don't count as a
    // separate unread message — the caption already did.
    const unread = msgs.filter(m => m.username !== req.user.username && !m.read && !m.followup).length;
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

// ---------- DM Pinned Messages ----------
// Per-user, per-conversation pin list. Stored on the user record as:
//   db.users[me].dmPins = { otherUsername: [msgId, msgId, ...] }
// This is private to each user (you pin for yourself, like a bookmark) and
// never modifies or wipes any existing DM message data.
function getUserDMPins(username, other) {
  const u = db.users[username];
  if (!u) return [];
  if (!u.dmPins) u.dmPins = {};
  if (!Array.isArray(u.dmPins[other])) u.dmPins[other] = [];
  return u.dmPins[other];
}

// GET pinned messages (full message objects) for a conversation
app.get('/api/dms/:username/pins', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  const pins = getUserDMPins(req.user.username, other);
  const myDMs = db.dms[req.user.username] || {};
  const msgs = myDMs[other] || [];
  // Resolve each pinned id to its current message object (skip missing/deleted)
  const out = [];
  pins.forEach(id => {
    const m = msgs.find(x => x.id === id);
    if (m && !m.deleted) out.push(m);
  });
  res.json({ pins: out });
});

// POST pin a message
app.post('/api/dms/:username/pin', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  const messageId = String((req.body && req.body.messageId) || '').trim();
  if (!messageId) return res.status(400).json({ error: 'Message id required' });
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  // Verify the message exists in this conversation for this user
  const myDMs = db.dms[req.user.username] || {};
  const msgs = myDMs[other] || [];
  const m = msgs.find(x => x.id === messageId);
  if (!m) return res.status(404).json({ error: 'Message not found' });
  const pins = getUserDMPins(req.user.username, other);
  if (!pins.includes(messageId)) pins.push(messageId);
  saveDB();
  res.json({ success: true, pinned: true });
});

// POST unpin a message
app.post('/api/dms/:username/unpin', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  const messageId = String((req.body && req.body.messageId) || '').trim();
  if (!messageId) return res.status(400).json({ error: 'Message id required' });
  const pins = getUserDMPins(req.user.username, other);
  const idx = pins.indexOf(messageId);
  let pinned = true;
  if (idx >= 0) { pins.splice(idx, 1); pinned = false; saveDB(); }
  res.json({ success: true, pinned });
});

// GET search messages within a single DM conversation
app.get('/api/dms/:username/search', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  const rawQ = String(req.query.q || '').trim();
  const q = rawQ.toLowerCase();
  if (!q) return res.json({ results: [] });
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  const myDMs = db.dms[req.user.username] || {};
  const msgs = (myDMs[other] || []).slice(-1000);
  const results = [];
  // Resolve a user-id query to a username (like the global search)
  const idMatchUser = rawQ.length >= 8
    ? Object.values(db.users).find(u => u.id && u.id.toLowerCase() === q)
    : null;
  const usernameQuery = q.replace(/^@/, '');
  const resolvedUsername = idMatchUser ? idMatchUser.username.toLowerCase() : null;
  msgs.forEach(m => {
    if (m.deleted) return;
    if (m.from && m.from.toLowerCase() === usernameQuery) {
      results.push({ type: 'dm', id: m.id, username: m.from, displayName: m.displayName, withUser: other, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
      return;
    }
    if (resolvedUsername && m.from && m.from.toLowerCase() === resolvedUsername) {
      results.push({ type: 'dm', id: m.id, username: m.from, displayName: m.displayName, withUser: other, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null, matchedById: true });
      return;
    }
    if (m.text && m.text.toLowerCase().includes(q)) {
      results.push({ type: 'dm', id: m.id, username: m.from, displayName: m.displayName, withUser: other, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
    }
  });
  results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ results: results.slice(0, 50) });
});

// ---------- Mutual Encryption Chatrooms (Round 7) ----------
// REST endpoints powering the friend-only, key-gated, end-to-end encrypted
// chatroom. The server NEVER sees plaintext for these rooms: the client
// encrypts with a key derived from the shared 24-letter key, and only the
// ciphertext envelope is stored/relayed. The owner/admin has no access.

// Public (safe) view of an encryption-chat record for a given viewer.
function publicEncChat(rec, viewer) {
  if (!rec) return null;
  const v = String(viewer || '').toLowerCase();
  const other = (rec.pair || []).find(u => u !== v) || null;
  return {
    pairId: encPairId(rec.pair[0], rec.pair[1]),
    pair: rec.pair,
    other,
    state: rec.state,
    myInvite: rec.invites ? (rec.invites[v] || null) : null,
    theirInvite: other && rec.invites ? (rec.invites[other] || null) : null,
    keyIssuedToMe: !!(rec.keyIssued && rec.keyIssued[v]),
    keyDeletedByMe: !!(rec.keyDeleted && rec.keyDeleted[v]),
    hasKey: !!rec.keyHash,
    messageCount: (rec.messages || []).length,
    resetBy: rec.resetBy || null,
    resetPending: rec.state === 'resetting',
    deleteBy: rec.deleteBy || null,
    deletePending: rec.state === 'deleting',
  };
}

// GET current encryption-chat status for a friend pair.
app.get('/api/encryption/status/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  res.json({ status: publicEncChat(rec, me) });
});

// POST start an encryption-chat invite. Notifies BOTH users (the initiator
// included) so each sees the Join / Exit popup.
app.post('/api/encryption/invite/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (other === me) return res.status(400).json({ error: 'Cannot start an encryption chat with yourself' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, true);
  // Reset the invite state for a fresh session. NOTE: we intentionally do NOT
  // clear keyHash / messages here — the key-rotation decision is made when both
  // users join (see respond handler), and keeping the history means the
  // encrypted chatroom persists across sessions.
  rec.state = 'invited';
  rec.invites = { [me]: 'pending', [other]: 'pending' };
  rec.updatedAt = nowISO();
  saveDB();
  const payload = { pairId: encPairId(me, other), from: me, other, status: publicEncChat(rec, me) };
  io.to('user:' + me).emit('encryption-invite', { ...payload, status: publicEncChat(rec, me) });
  io.to('user:' + other).emit('encryption-invite', { ...payload, status: publicEncChat(rec, other) });
  res.json({ success: true, status: publicEncChat(rec, me) });
});

// POST respond to an invite: { action: 'join' | 'exit' }.
//  - Both exit  → state 'idle', UI exits for both.
//  - Both join  → state 'active', a one-time 24-letter key is generated and
//                 delivered to EACH user exactly once (copyable, shown once).
app.post('/api/encryption/respond/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  const action = String((req.body && req.body.action) || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  if (action !== 'join' && action !== 'exit') return res.status(400).json({ error: 'Invalid action' });
  const rec = getEncChat(me, other, true);
  if (rec.state !== 'invited' && rec.state !== 'active') {
    return res.status(400).json({ error: 'No active encryption chat invite' });
  }
  rec.invites[me] = (action === 'join') ? 'joined' : 'exited';
  rec.updatedAt = nowISO();

  const bothExited = rec.invites[me] === 'exited' && rec.invites[other] === 'exited';
  const bothJoined = rec.invites[me] === 'joined' && rec.invites[other] === 'joined';

  if (bothExited) {
    rec.state = 'idle';
    rec.invites = {};
    rec.keyHash = null;
    rec.keyIssued = {};
    rec.messages = [];
    saveDB();
    io.to('user:' + me).emit('encryption-exited', { pairId: encPairId(me, other), other });
    io.to('user:' + other).emit('encryption-exited', { pairId: encPairId(me, other), other: me });
    return res.json({ success: true, state: 'idle', exited: true });
  }

  if (bothJoined) {
    rec.state = 'active';
    // ---- Key rotation policy ----
    // A fresh, random 24-letter key is issued every time the pair (re)enters
    // the chatroom — UNLESS a user has explicitly deleted their key, in which
    // case we keep the existing key (and history) so the other user is not
    // disrupted. Rotating the key starts a fresh message history (old
    // ciphertext can no longer be decrypted with the new key).
    const someoneDeletedKey = !!(rec.keyDeleted && (rec.keyDeleted[me] || rec.keyDeleted[other]));
    let key = null;
    if (!rec.keyHash) {
      // First time ever: generate the initial key.
      key = generateEncKey();
      rec.keyHash = hashEncKey(key);
      rec.messages = [];
    } else if (someoneDeletedKey) {
      // A user deleted their key: keep the existing key + history, do not rotate.
      key = null;
    } else {
      // Normal re-entry: rotate to a fresh random key + fresh history.
      key = generateEncKey();
      rec.keyHash = hashEncKey(key);
      rec.messages = [];
    }
    rec.keyIssued = { [me]: true, [other]: true };
    // Clear the per-user "deleted key" flags so the NEXT re-entry rotates again.
    rec.keyDeleted = {};
    saveDB();
    // Deliver the one-time key to EACH user exactly once. The key is NOT
    // persisted in plaintext anywhere — only its hash is stored server-side.
    // When we reused an existing key (key === null) we cannot re-send it (we
    // never stored it), so the users must enter the key they already saved.
    if (key) {
      io.to('user:' + me).emit('encryption-key', { pairId: encPairId(me, other), other, key });
      io.to('user:' + other).emit('encryption-key', { pairId: encPairId(me, other), other: me, key });
    } else {
      io.to('user:' + me).emit('encryption-key-existing', { pairId: encPairId(me, other), other });
      io.to('user:' + other).emit('encryption-key-existing', { pairId: encPairId(me, other), other: me });
    }
    return res.json({ success: true, state: 'active', key: key || null, reused: !key });
  }

  // Only one has responded so far — let the other side know the progress.
  saveDB();
  io.to('user:' + me).emit('encryption-invite-update', { pairId: encPairId(me, other), other, status: publicEncChat(rec, me) });
  io.to('user:' + other).emit('encryption-invite-update', { pairId: encPairId(me, other), other: me, status: publicEncChat(rec, other) });
  res.json({ success: true, state: rec.state, status: publicEncChat(rec, me) });
});

// POST verify the entered 24-letter key. On success the user is admitted to
// the encrypted chatroom and receives the stored ciphertext history.
app.post('/api/encryption/verify/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'active' || !rec.keyHash) {
    return res.status(400).json({ error: 'No active encryption chatroom' });
  }
  if (hashEncKey(key) !== rec.keyHash) {
    return res.status(403).json({ error: 'Incorrect encryption key' });
  }
  // Admit: return the ciphertext-only message history (client decrypts locally).
  res.json({ success: true, messages: rec.messages || [], pairId: encPairId(me, other) });
});

// POST delete MY copy of the encryption key. This marks the user as having
// deleted their key so the next time the pair enters the chatroom the key is
// NOT rotated (the other user keeps working). The key itself is never stored
// server-side, so "deleting" simply clears the client's saved copy and flags
// the record. The user can no longer re-enter until a new key is issued.
app.post('/api/encryption/delete-key/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  if (!rec) return res.status(400).json({ error: 'No encryption chat found' });
  if (!rec.keyDeleted || typeof rec.keyDeleted !== 'object') rec.keyDeleted = {};
  rec.keyDeleted[me] = true;
  rec.updatedAt = nowISO();
  saveDB();
  // Let the other user know their partner deleted their key (informational).
  io.to('user:' + other).emit('encryption-key-deleted', { pairId: encPairId(me, other), other: me });
  res.json({ success: true });
});

// POST request a KEY RESET. The requester asks the OTHER user to reset the
// shared end-to-end encryption key. The other user must Accept or Decline.
//  - Accept  -> a brand-new 24-letter key is generated, the OLD key is
//               invalidated (its hash is replaced), and ALL messages that were
//               encrypted with the old key are permanently deleted.
//  - Decline -> nothing changes; the requester is told the other user declined.
app.post('/api/encryption/reset-request/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'active') return res.status(400).json({ error: 'No active encryption chatroom' });
  rec.state = 'resetting';
  rec.resetVotes = { [me]: 'requested', [other]: 'pending' };
  rec.resetBy = me;
  rec.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('encryption-reset-request', { pairId: encPairId(me, other), from: me, other, self: true });
  io.to('user:' + other).emit('encryption-reset-request', { pairId: encPairId(me, other), from: me, other: me });
  res.json({ success: true });
});

// POST respond to a key-reset request: { action: 'accept' | 'decline' }.
// Only the OTHER user (the one who did not request) may respond.
app.post('/api/encryption/reset-respond/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  const action = String((req.body && req.body.action) || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  if (action !== 'accept' && action !== 'decline') return res.status(400).json({ error: 'Invalid action' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'resetting') return res.status(400).json({ error: 'No pending key reset request' });
  // The requester cannot respond to their own request.
  if (rec.resetBy === me) return res.status(400).json({ error: 'You cannot respond to your own reset request' });

  if (action === 'decline') {
    // Nothing changes: keep the existing key + history, return to 'active'.
    rec.state = 'active';
    rec.resetVotes = {};
    rec.resetBy = null;
    rec.updatedAt = nowISO();
    saveDB();
    io.to('user:' + me).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other, reason: 'declined', by: me });
    io.to('user:' + other).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other: me, reason: 'declined', by: me });
    return res.json({ success: true, reason: 'declined' });
  }

  // ---- Accept: rotate the key, invalidate the old one, wipe old ciphertext ----
  const newKey = generateEncKey();
  rec.keyHash = hashEncKey(newKey);   // old key hash replaced -> old key invalid
  rec.messages = [];                  // delete all chats encrypted with the old key
  rec.keyIssued = { [me]: true, [other]: true };
  rec.keyDeleted = {};
  rec.state = 'active';
  rec.resetVotes = {};
  rec.resetBy = null;
  rec.updatedAt = nowISO();
  saveDB();
  // Deliver the fresh one-time key to BOTH users (shown once, never stored).
  io.to('user:' + me).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other, reason: 'accepted', key: newKey, by: me });
  io.to('user:' + other).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other: me, reason: 'accepted', key: newKey, by: me });
  res.json({ success: true, reason: 'accepted', key: newKey });
});

// POST request a KEY DELETE. The requester asks the OTHER user to delete the
// shared end-to-end encryption key. The other user must Accept or Decline.
//  - Accept  -> the shared key is deleted (its hash cleared), the key is
//               invalidated for BOTH users, and ALL encrypted messages are
//               permanently deleted. The chatroom returns to 'idle'.
//  - Decline -> nothing changes; the requester is told the other user declined.
app.post('/api/encryption/delete-request/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'active') return res.status(400).json({ error: 'No active encryption chatroom' });
  rec.state = 'deleting';
  rec.deleteVotes = { [me]: 'requested', [other]: 'pending' };
  rec.deleteBy = me;
  rec.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('encryption-delete-request', { pairId: encPairId(me, other), from: me, other, self: true });
  io.to('user:' + other).emit('encryption-delete-request', { pairId: encPairId(me, other), from: me, other: me });
  res.json({ success: true });
});

// POST respond to a key-delete request: { action: 'accept' | 'decline' }.
// Only the OTHER user (the one who did not request) may respond.
app.post('/api/encryption/delete-respond/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  const action = String((req.body && req.body.action) || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  if (action !== 'accept' && action !== 'decline') return res.status(400).json({ error: 'Invalid action' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'deleting') return res.status(400).json({ error: 'No pending key delete request' });
  if (rec.deleteBy === me) return res.status(400).json({ error: 'You cannot respond to your own delete request' });

  if (action === 'decline') {
    // Nothing changes: keep the existing key + history, return to 'active'.
    rec.state = 'active';
    rec.deleteVotes = {};
    rec.deleteBy = null;
    rec.updatedAt = nowISO();
    saveDB();
    io.to('user:' + me).emit('encryption-delete-resolved', { pairId: encPairId(me, other), other, reason: 'declined', by: me });
    io.to('user:' + other).emit('encryption-delete-resolved', { pairId: encPairId(me, other), other: me, reason: 'declined', by: me });
    return res.json({ success: true, reason: 'declined' });
  }

  // ---- Accept: delete the shared key + wipe all encrypted history ----
  rec.keyHash = null;                 // key invalidated for BOTH users
  rec.messages = [];                  // delete all encrypted chats
  rec.keyIssued = {};
  rec.keyDeleted = {};
  rec.invites = {};
  rec.state = 'idle';
  rec.deleteVotes = {};
  rec.deleteBy = null;
  rec.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('encryption-delete-resolved', { pairId: encPairId(me, other), other, reason: 'accepted', by: me });
  io.to('user:' + other).emit('encryption-delete-resolved', { pairId: encPairId(me, other), other: me, reason: 'accepted', by: me });
  res.json({ success: true, reason: 'accepted' });
});

// POST request to return to normal DMs. Notifies both users; both must accept.
app.post('/api/encryption/return-request/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'active') return res.status(400).json({ error: 'No active encryption chatroom' });
  rec.state = 'returning';
  rec.returnVotes = { [me]: 'pending', [other]: 'pending' };
  rec.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('encryption-return-request', { pairId: encPairId(me, other), from: me, other });
  io.to('user:' + other).emit('encryption-return-request', { pairId: encPairId(me, other), from: me, other: me });
  res.json({ success: true });
});

// POST respond to a return request: { action: 'accept' | 'deny' }.
//  - Both accept → switch back to normal DMs (state 'idle').
//  - Both deny   → exit the encryption UI (state 'idle').
app.post('/api/encryption/return-respond/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  const action = String((req.body && req.body.action) || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  if (action !== 'accept' && action !== 'deny') return res.status(400).json({ error: 'Invalid action' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'returning') return res.status(400).json({ error: 'No pending return request' });
  if (!rec.returnVotes) rec.returnVotes = {};
  rec.returnVotes[me] = action;
  rec.updatedAt = nowISO();

  const bothAccept = rec.returnVotes[me] === 'accept' && rec.returnVotes[other] === 'accept';
  const bothDeny = rec.returnVotes[me] === 'deny' && rec.returnVotes[other] === 'deny';

  if (bothAccept || bothDeny) {
    rec.state = 'idle';
    rec.invites = {};
    rec.returnVotes = {};
    rec.keyHash = null;
    rec.keyIssued = {};
    rec.messages = [];
    saveDB();
    const reason = bothAccept ? 'accepted' : 'denied';
    io.to('user:' + me).emit('encryption-return-resolved', { pairId: encPairId(me, other), other, reason });
    io.to('user:' + other).emit('encryption-return-resolved', { pairId: encPairId(me, other), other: me, reason });
    return res.json({ success: true, state: 'idle', reason });
  }

  saveDB();
  io.to('user:' + me).emit('encryption-return-update', { pairId: encPairId(me, other), other, votes: rec.returnVotes });
  io.to('user:' + other).emit('encryption-return-update', { pairId: encPairId(me, other), other: me, votes: rec.returnVotes });
  res.json({ success: true, state: 'returning' });
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

// ===================== SERVERS =====================
// ---- Helpers ----
function findServer(id) {
  if (!db.servers || typeof db.servers !== 'object') db.servers = {};
  return db.servers[id] || null;
}
// Generate a random, URL-safe invite code (e.g. "mbatkwjgfoaxngkwohak").
function genInviteCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
// Custom invite codes must be 4-10 chars, lowercase letters/numbers/-/_ only.
const INVITE_CODE_RE = /^[a-z0-9_-]{4,10}$/;
// Words that would collide with real routes/assets and must never be used.
const RESERVED_INVITE_CODES = new Set([
  'api', 'uploads', 'upload', 'socket', 'socket.io', 'servers', 'server',
  'index', 'admin', 'login', 'logout', 'signup', 'signin', 'register',
  'assets', 'fonts', 'font', 'static', 'data', 'invite', 'invites',
  'discover', 'settings', 'app', 'www', 'health', 'version', 'favicon',
  'robots', 'manifest', 'service-worker', 'sw', 'null', 'undefined',
  'true', 'false', 'test', 'demo', 'about', 'help', 'support', 'terms',
  'privacy', 'home', 'main', 'public', 'private', 'user', 'users', 'me',
]);
// Validate a user-supplied custom invite code. Returns { ok, code, error }.
function validateCustomInviteCode(raw) {
  const code = String(raw || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!code) return { ok: false, error: 'Enter a custom link' };
  if (code.length < 4) return { ok: false, error: 'Custom links must be at least 4 characters' };
  if (code.length > 10) return { ok: false, error: 'Custom links must be at most 10 characters' };
  if (!INVITE_CODE_RE.test(code)) return { ok: false, error: 'Use only letters, numbers, hyphens and underscores' };
  if (RESERVED_INVITE_CODES.has(code)) return { ok: false, error: 'That link is reserved — try another' };
  return { ok: true, code };
}
// Default role set created with every new server.
function defaultServerRoles(owner) {
  return [
    { id: 'owner', name: 'Owner', color: '#f59e0b', badge: '', order: 0, system: true,
      permissions: allPermissions() },
    { id: 'admin', name: 'Admin', color: '#ef4444', badge: '', order: 1, system: true,
      permissions: Object.assign(allPermissions(), { administrator: false, manageServer: false }) },
    { id: 'mod', name: 'Moderator', color: '#3b82f6', badge: '', order: 2, system: true,
      permissions: { manageChannels: false, manageRoles: false, manageServer: false, kick: true, ban: true, invite: true,
        manageMessages: true, manageNicknames: true, mentionEveryone: true, muteMembers: true, deafenMembers: true,
        moveMembers: true, viewAuditLog: true, sendMessages: true, attachFiles: true, embedLinks: true, addReactions: true,
        externalEmojis: true, readHistory: true, createThreads: true, manageWebhooks: false, prioritySpeaker: false, administrator: false } },
    { id: 'member', name: 'Member', color: '#9ca3af', badge: '', order: 3, system: true,
      permissions: { manageChannels: false, manageRoles: false, manageServer: false, kick: false, ban: false, invite: true,
        manageMessages: false, manageNicknames: false, mentionEveryone: false, muteMembers: false, deafenMembers: false,
        moveMembers: false, viewAuditLog: false, sendMessages: true, attachFiles: true, embedLinks: true, addReactions: true,
        externalEmojis: true, readHistory: true, createThreads: true, manageWebhooks: false, prioritySpeaker: false, administrator: false } },
  ];
}
// The full set of role permissions the UI can toggle. Kept in one place so the
// create/update endpoints and the default roles stay in sync.
const PERMISSION_KEYS = [
  'administrator', 'manageServer', 'manageChannels', 'manageRoles', 'manageMessages', 'manageNicknames',
  'kick', 'ban', 'muteMembers', 'deafenMembers', 'moveMembers', 'invite', 'manageInvites', 'viewAuditLog',
  'mentionEveryone', 'sendMessages', 'attachFiles', 'embedLinks', 'addReactions', 'externalEmojis',
  'readHistory', 'createThreads', 'manageWebhooks', 'prioritySpeaker',
];
function allPermissions() {
  const p = {};
  for (const k of PERMISSION_KEYS) p[k] = true;
  return p;
}
// Normalize an incoming permissions object to the known keys (booleans only).
function normalizePermissions(input, fallback) {
  const src = (input && typeof input === 'object') ? input : {};
  const base = (fallback && typeof fallback === 'object') ? fallback : {};
  const out = {};
  for (const k of PERMISSION_KEYS) {
    if (src[k] !== undefined) out[k] = !!src[k];
    else out[k] = !!base[k];
  }
  // Administrator implies every other permission.
  if (out.administrator) for (const k of PERMISSION_KEYS) out[k] = true;
  return out;
}
// Does `username` have permission `perm` in `server`? Owner always does.
function serverHasPerm(server, username, perm) {
  if (!server) return false;
  const un = String(username || '').toLowerCase();
  if (server.owner === un) return true;
  const prof = (server.memberProfiles || {})[un];
  const roleIds = (prof && Array.isArray(prof.roleIds)) ? prof.roleIds : [];
  for (const rid of roleIds) {
    const role = (server.roles || []).find(r => r.id === rid);
    if (role && role.permissions) {
      if (role.permissions.administrator) return true;
      if (role.permissions[perm]) return true;
    }
  }
  return false;
}
// Can `username` VIEW channel `ch` in `server`? Managers/owner always can.
// Private channels are hidden from members who are not explicitly allowed
// (via allowedMembers) and do not hold one of the allowedRoles.
function canViewChannel(server, username, ch) {
  if (!ch) return false;
  if (!ch.private) return true;
  if (serverHasPerm(server, username, 'manageChannels')) return true;
  const un = String(username || '').toLowerCase();
  if ((ch.allowedMembers || []).map(x => String(x).toLowerCase()).includes(un)) return true;
  const prof = (server.memberProfiles || {})[un];
  const roleIds = (prof && Array.isArray(prof.roleIds)) ? prof.roleIds : [];
  if ((ch.allowedRoles || []).some(rid => roleIds.includes(rid))) return true;
  return false;
}
// Can `username` SEND messages in channel `ch`?
//   chatDisabledFor: 'none'     -> everyone can chat
//   chatDisabledFor: 'members'  -> only members holding a custom role can chat
//   chatDisabledFor: 'everyone' -> only owner/managers can chat (read-only)
function canChatInChannel(server, username, ch) {
  if (!ch) return false;
  const mode = ch.chatDisabledFor || 'none';
  if (mode === 'none') return true;
  if (serverHasPerm(server, username, 'manageMessages') || serverHasPerm(server, username, 'manageChannels')) return true;
  if (mode === 'everyone') return false;
  if (mode === 'members') {
    const un = String(username || '').toLowerCase();
    const prof = (server.memberProfiles || {})[un];
    const roleIds = (prof && Array.isArray(prof.roleIds)) ? prof.roleIds : [];
    // A "custom" role is any role that is not the built-in default member role.
    const custom = roleIds.some(rid => {
      const r = (server.roles || []).find(x => x.id === rid);
      return r && !r.system;
    });
    return custom;
  }
  return true;
}
// Public (client-safe) view of a server. Includes member count + roles +
// channels, but NEVER message plaintext (messages are ciphertext-only).
function publicServer(s, viewerUsername) {
  if (!s) return null;
  const viewer = String(viewerUsername || '').toLowerCase();
  const isMember = (s.members || []).includes(viewer);
  const isOwner = s.owner === viewer;
  const base = {
    id: s.id,
    serverId: s.serverId || null,
    name: s.name,
    owner: s.owner,
    icon: s.icon || null,
    banner: s.banner || null,
    bio: s.bio || '',
    memberCount: (s.members || []).length,
    createdAt: s.createdAt,
    systemChannelId: s.systemChannelId || null,
    defaultNotifications: s.defaultNotifications || 'all',
    verificationLevel: s.verificationLevel || 0,
    welcomeMessage: s.welcomeMessage || '',
    discoverable: !!s.discoverable,
    slowmodeSeconds: s.slowmodeSeconds || 0,
    accentColor: s.accentColor || null,
    effect: s.effect || 'none',
    iconScale: s.iconScale || 100,
    bannerScale: s.bannerScale || 100,
    chatBackground: s.chatBackground || null,
    chatBackgroundScale: (typeof s.chatBackgroundScale === 'number') ? s.chatBackgroundScale : 100,
    chatBackgroundOpacity: (typeof s.chatBackgroundOpacity === 'number') ? s.chatBackgroundOpacity : 100,
    serverOrder: (s.serverOrder && typeof s.serverOrder === 'object') ? s.serverOrder : {},
    roles: (s.roles || []).map(r => ({ id: r.id, name: r.name, color: r.color, badge: r.badge || '', order: r.order || 0, system: !!r.system, permissions: r.permissions || {} })),
    categories: (s.categories || []).map(cat => ({ id: cat.id, name: cat.name, order: cat.order || 0 })),
    channels: (s.channels || [])
      .filter(c => isOwner || canViewChannel(s, viewer, c))
      .map(c => ({
        id: c.id, name: c.name, type: c.type || 'text', topic: c.topic || '', createdAt: c.createdAt,
        private: !!c.private,
        categoryId: c.categoryId || null,
        allowedRoles: Array.isArray(c.allowedRoles) ? c.allowedRoles : [],
        allowedMembers: Array.isArray(c.allowedMembers) ? c.allowedMembers : [],
        chatDisabledFor: c.chatDisabledFor || 'none',
        canChat: isOwner || canChatInChannel(s, viewer, c),
      })),
    isMember,
    isOwner,
  };
  if (isMember) {
    base.pins = (s.pins && typeof s.pins === 'object') ? s.pins : {};
    base.members = (s.members || []).map(un => {
      const u = db.users[un];
      const prof = (s.memberProfiles || {})[un] || {};
      const pu = publicUser(u) || { username: un, displayName: un };
      return {
        username: un,
        displayName: pu.displayName || un,
        avatar: prof.avatar || pu.avatar || null,
        banner: prof.banner || null,
        bio: prof.bio || '',
        nickname: prof.nickname || null,
        roleIds: Array.isArray(prof.roleIds) ? prof.roleIds : [],
        avatarScale: prof.avatarScale || 100,
        bannerScale: prof.bannerScale || 100,
        status: pu.status || 'offline',
        joinedAt: prof.joinedAt || null,
        isOwner: s.owner === un,
      };
    });
  }
  return base;
}
// Public invite preview (for link embeds) — no auth required.
function publicInvitePreview(server, invite) {
  if (!server) return null;
  const ownerUser = db.users[server.owner];
  const onlineCount = (server.members || []).filter(un => {
    const u = db.users[un];
    return u && connectedUsers.has(un) && u.status !== 'offline';
  }).length;
  return {
    serverId: server.id,
    name: server.name,
    icon: server.icon || null,
    banner: server.banner || null,
    bio: server.bio || '',
    accentColor: server.accentColor || null,
    memberCount: (server.members || []).length,
    onlineCount,
    channelCount: (server.channels || []).length,
    roleCount: (server.roles || []).length,
    createdAt: server.createdAt || null,
    verificationLevel: server.verificationLevel || 0,
    owner: server.owner,
    ownerName: (ownerUser && ownerUser.displayName) ? ownerUser.displayName : server.owner,
    code: invite ? invite.code : null,
    expiresAt: invite ? (invite.expiresAt || 0) : 0,
  };
}
// Find a server + invite by code (checks expiry). Returns { server, invite } or null.
function findInviteByCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  for (const s of Object.values(db.servers || {})) {
    const inv = (s.invites || []).find(i => i.code === c);
    if (inv) {
      if (inv.expiresAt && Date.now() > inv.expiresAt) return { server: s, invite: inv, expired: true };
      return { server: s, invite: inv, expired: false };
    }
  }
  return null;
}
// Ensure a user has a member profile record inside a server.
function ensureServerMemberProfile(server, username) {
  if (!server.memberProfiles) server.memberProfiles = {};
  const un = String(username || '').toLowerCase();
  if (!server.memberProfiles[un]) {
    server.memberProfiles[un] = { nickname: null, avatar: null, banner: null, bio: '', roleIds: ['member'], joinedAt: nowISO(), avatarScale: 100, bannerScale: 100 };
  }
  return server.memberProfiles[un];
}
// Emit a server update to every member (targeted rooms).
function emitServerUpdate(server) {
  if (!server) return;
  for (const m of (server.members || [])) {
    io.to('user:' + m).emit('server-updated', { server: publicServer(server, m) });
  }
}

// ---- Create a server ----
app.post('/api/servers/create', authMiddleware, (req, res) => {
  const { name, bio, accentColor, serverType, isPublic, icon, banner } = req.body || {};
  const serverName = String(name || '').trim().slice(0, 40);
  if (!serverName) return res.status(400).json({ error: 'Server name is required' });
  const owner = req.user.username;
  const id = genId();
  const generalId = genId();
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(accentColor || '')) ? accentColor : '#5865f2';
  const type = ['community','friends','gaming','study','club','other'].includes(String(serverType || '')) ? serverType : 'community';
  // Optional icon/banner chosen in the live preview (base64 data URLs).
  const iconUrl = (typeof icon === 'string' && icon.startsWith('data:image/')) ? saveDataUrlImage(icon, 8 * 1024 * 1024) : null;
  const bannerUrl = (typeof banner === 'string' && banner.startsWith('data:image/')) ? saveDataUrlImage(banner, 12 * 1024 * 1024) : null;
  const server = {
    id,
    serverId: genServerId(),
    name: serverName,
    owner,
    icon: iconUrl,
    banner: bannerUrl,
    bio: String(bio || '').slice(0, 500),
    accentColor: accent,
    serverType: type,
    isPublic: isPublic !== false,
    members: [owner],
    memberProfiles: { [owner]: { nickname: null, avatar: null, banner: null, bio: '', roleIds: ['owner'], joinedAt: nowISO() } },
    roles: defaultServerRoles(owner),
    channels: [{ id: generalId, name: 'general', type: 'text', topic: 'Welcome!', createdAt: nowISO() }],
    messages: { [generalId]: [] },
    invites: [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  db.servers[id] = server;
  saveDB();
  res.json({ success: true, server: publicServer(server, owner) });
});

// ---- List servers the current user is a member of ----
app.get('/api/servers', authMiddleware, (req, res) => {
  const me = req.user.username;
  const list = Object.values(db.servers || {}).filter(s => (s.members || []).includes(me));
  // Sort by the user's personal rail order (serverOrder[me]); servers without
  // a saved position keep their natural (creation) order at the end.
  list.sort((a, b) => {
    const ao = (a.serverOrder && typeof a.serverOrder[me] === 'number') ? a.serverOrder[me] : 1e9;
    const bo = (b.serverOrder && typeof b.serverOrder[me] === 'number') ? b.serverOrder[me] : 1e9;
    if (ao !== bo) return ao - bo;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
  res.json({ servers: list.map(s => publicServer(s, me)) });
});

// ---- Discover public servers (name search) ----
// Only servers whose owner has switched on "Discoverable" appear here.
app.get('/api/servers/discover', authMiddleware, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = req.user.username;
  let list = Object.values(db.servers || {}).filter(s => !!s.discoverable);
  if (q) list = list.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.bio || '').toLowerCase().includes(q) ||
    // Match by the public server ID (e.g. "1464618225") as well as the internal id.
    String(s.serverId || '').toLowerCase().includes(q) ||
    String(s.id || '').toLowerCase().includes(q)
  );
  list = list.slice(0, 50);
  res.json({ servers: list.map(s => {
    const ownerUser = db.users[s.owner];
    const onlineCount = (s.members || []).filter(un => {
      const u = db.users[un];
      return u && connectedUsers.has(un) && u.status !== 'offline';
    }).length;
    return {
      id: s.id,
      serverId: s.serverId || null,
      name: s.name,
      icon: s.icon || null,
      banner: s.banner || null,
      bio: s.bio || '',
      accentColor: s.accentColor || null,
      memberCount: (s.members || []).length,
      onlineCount,
      channelCount: (s.channels || []).length,
      roleCount: (s.roles || []).length,
      createdAt: s.createdAt || null,
      verificationLevel: s.verificationLevel || 0,
      owner: s.owner,
      ownerName: (ownerUser && ownerUser.displayName) ? ownerUser.displayName : s.owner,
      isMember: (s.members || []).includes(me),
    };
  }) });
});

// ---- Get a single server (metadata + channels + members) ----
app.get('/api/servers/:id', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) {
    // Non-members get a limited preview so they can decide to join.
    return res.json({ server: publicServer(s, me), preview: true });
  }
  res.json({ server: publicServer(s, me) });
});

// ---- Get a channel's messages (members only) ----
app.get('/api/servers/:id/channels/:channelId/messages', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) return res.status(403).json({ error: 'You are not a member of this server' });
  const ch = (s.channels || []).find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!canViewChannel(s, me, ch)) return res.status(403).json({ error: 'This channel is private' });
  const msgs = ((s.messages || {})[ch.id] || []).slice(-1000);
  // Attach a lightweight thread summary to each parent message so the client
  // can render a "N replies" indicator without a second round-trip.
  const chThreads = (s.threads && s.threads[ch.id]) || {};
  const threads = {};
  for (const [pid, t] of Object.entries(chThreads)) {
    const tm = Array.isArray(t.messages) ? t.messages : [];
    const last = tm.length ? tm[tm.length - 1] : null;
    const participants = [];
    const seen = new Set();
    for (const m of tm) { if (m && m.from && !seen.has(m.from)) { seen.add(m.from); participants.push(m.from); } }
    threads[pid] = { id: t.id, parentId: pid, channelId: ch.id, createdAt: t.createdAt, replyCount: tm.length, participants, lastReplyAt: last ? last.timestamp : null, lastReplyFrom: last ? last.from : null, lastReplyText: last ? String(last.text || '').slice(0, 140) : '' };
  }
  res.json({ channel: { id: ch.id, name: ch.name, type: ch.type || 'text', topic: ch.topic || '', private: !!ch.private, chatDisabledFor: ch.chatDisabledFor || 'none', canChat: canChatInChannel(s, me, ch) }, messages: msgs, threads });
});

// ---- Owner/manager: update server settings (name, bio) ----
app.post('/api/servers/:id/settings', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageServer')) return res.status(403).json({ error: 'You do not have permission to manage this server' });
  const { name, bio, systemChannelId, defaultNotifications, verificationLevel, welcomeMessage, discoverable, slowmodeSeconds, accentColor, effect, iconScale, bannerScale, chatBackground, chatBackgroundScale, chatBackgroundOpacity } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 40);
    if (!n) return res.status(400).json({ error: 'Server name is required' });
    s.name = n;
  }
  if (bio !== undefined) s.bio = String(bio).slice(0, 500);
  if (systemChannelId !== undefined) {
    const valid = (s.channels || []).some(c => c.id === systemChannelId);
    s.systemChannelId = valid ? systemChannelId : null;
  }
  if (defaultNotifications !== undefined) {
    const v = String(defaultNotifications);
    s.defaultNotifications = ['all', 'mentions', 'none'].includes(v) ? v : 'all';
  }
  if (verificationLevel !== undefined) {
    const v = Number(verificationLevel);
    s.verificationLevel = [0, 1, 2, 3, 4].includes(v) ? v : 0;
  }
  if (welcomeMessage !== undefined) s.welcomeMessage = String(welcomeMessage).slice(0, 300);
  if (discoverable !== undefined) s.discoverable = !!discoverable;
  if (slowmodeSeconds !== undefined) {
    const v = Number(slowmodeSeconds);
    s.slowmodeSeconds = [0, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 21600].includes(v) ? v : 0;
  }
  if (accentColor !== undefined) {
    const c = String(accentColor || '').trim();
    s.accentColor = /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
  }
  if (effect !== undefined) {
    const e = String(effect || 'none');
    s.effect = ['none', 'glow', 'gradient', 'aurora', 'neon', 'pulse', 'grid', 'spotlight', 'scanlines'].includes(e) ? e : 'none';
  }
  if (iconScale !== undefined) {
    const v = Number(iconScale);
    s.iconScale = (Number.isFinite(v) && v >= 50 && v <= 300) ? Math.round(v) : 100;
  }
  if (bannerScale !== undefined) {
    const v = Number(bannerScale);
    s.bannerScale = (Number.isFinite(v) && v >= 50 && v <= 300) ? Math.round(v) : 100;
  }
  if (chatBackground !== undefined) {
    // null / empty clears the background; otherwise store the uploaded URL.
    const u = String(chatBackground || '').trim();
    s.chatBackground = u ? u.slice(0, 500) : null;
  }
  if (chatBackgroundScale !== undefined) {
    const v = Number(chatBackgroundScale);
    s.chatBackgroundScale = (Number.isFinite(v) && v >= 50 && v <= 300) ? Math.round(v) : 100;
  }
  if (chatBackgroundOpacity !== undefined) {
    const v = Number(chatBackgroundOpacity);
    s.chatBackgroundOpacity = (Number.isFinite(v) && v >= 0 && v <= 100) ? Math.round(v) : 100;
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Reorder the servers in the current user's rail ----
// Each user has their own personal ordering of the servers they belong to.
// The order is stored per-server (serverOrder[username] = index) so it
// persists across devices/redeploys without touching any other user's view.
app.post('/api/servers/reorder', authMiddleware, (req, res) => {
  const me = req.user.username;
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'An order array is required' });
  // Only accept ids for servers the user is actually a member of.
  const mine = new Set(Object.values(db.servers || {}).filter(s => (s.members || []).includes(me)).map(s => s.id));
  let idx = 0;
  for (const id of order) {
    if (!mine.has(id)) continue;
    const s = db.servers[id];
    if (!s) continue;
    if (!s.serverOrder || typeof s.serverOrder !== 'object') s.serverOrder = {};
    s.serverOrder[me] = idx++;
  }
  saveDB();
  res.json({ success: true });
});

// ---- Owner/manager: upload server icon ----
app.post('/api/servers/:id/icon', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageServer')) return res.status(403).json({ error: 'You do not have permission to change the server icon' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { maxStatic: 512, maxAnimated: 480, skipAnimated: true }, 8000); }
    catch (e) { console.error('[server-icon] enhance error:', e.message); }
    const fileUrl = '/uploads/' + req.file.filename + '?t=' + Date.now();
    s.icon = fileUrl;
    s.updatedAt = nowISO();
    saveDB();
    backupUploadFile(req.file.filename);
    emitServerUpdate(s);
    res.json({ success: true, icon: fileUrl, server: publicServer(s, req.user.username) });
  } catch (e) {
    console.error('server icon upload error', e);
    res.status(500).json({ error: 'Failed to upload server icon' });
  }
});

// ---- Owner/manager: upload server banner ----
app.post('/api/servers/:id/banner', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageServer')) return res.status(403).json({ error: 'You do not have permission to change the server banner' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { maxStatic: 1920, maxAnimated: 1080, skipAnimated: true }, 10000); }
    catch (e) { console.error('[server-banner] enhance error:', e.message); }
    const fileUrl = '/uploads/' + req.file.filename + '?t=' + Date.now();
    s.banner = fileUrl;
    s.updatedAt = nowISO();
    saveDB();
    backupUploadFile(req.file.filename);
    emitServerUpdate(s);
    res.json({ success: true, banner: fileUrl, server: publicServer(s, req.user.username) });
  } catch (e) {
    console.error('server banner upload error', e);
    res.status(500).json({ error: 'Failed to upload server banner' });
  }
});

// ---- Owner/manager: upload server chat background image ----
app.post('/api/servers/:id/chat-background', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageServer')) return res.status(403).json({ error: 'You do not have permission to change the server chat background' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    // Chat backgrounds are full-bleed, so we resize to a crisp 2560px longest
    // edge with the high-quality Lanczos3 kernel but SKIP the sharpening pass
    // (noSharpen). Sharpening smooth regions (skies, gradients, soft bokeh)
    // amplifies compression noise and upscaling artifacts, which is what made
    // the background look "staticy"/grainy. A clean resize alone is smooth.
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { maxStatic: 2560, maxAnimated: 1080, skipAnimated: true, noSharpen: true }, 10000); }
    catch (e) { console.error('[server-chatbg] enhance error:', e.message); }
    const fileUrl = '/uploads/' + req.file.filename + '?t=' + Date.now();
    s.chatBackground = fileUrl;
    if (typeof s.chatBackgroundScale !== 'number') s.chatBackgroundScale = 100;
    if (typeof s.chatBackgroundOpacity !== 'number') s.chatBackgroundOpacity = 100;
    s.updatedAt = nowISO();
    saveDB();
    backupUploadFile(req.file.filename);
    emitServerUpdate(s);
    res.json({ success: true, chatBackground: fileUrl, server: publicServer(s, req.user.username) });
  } catch (e) {
    console.error('server chat background upload error', e);
    res.status(500).json({ error: 'Failed to upload server chat background' });
  }
});

// ---- Channels: create ----
app.post('/api/servers/:id/channels', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const name = String((req.body || {}).name || '').trim().toLowerCase().replace(/[^a-z0-9\-_ ]/g, '').replace(/\s+/g, '-').slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Channel name is required' });
  if ((s.channels || []).some(c => c.name === name)) return res.status(400).json({ error: 'A channel with that name already exists' });
  if ((s.channels || []).length >= 50) return res.status(400).json({ error: 'This server has reached the maximum of 50 channels' });
  const catId = (req.body || {}).categoryId;
  const validCat = catId && (s.categories || []).some(c => c.id === catId) ? catId : null;
  const chType = (req.body || {}).type === 'voice' ? 'voice' : 'text';
  const ch = { id: genId(), name, type: chType, topic: String((req.body || {}).topic || '').slice(0, 200), createdAt: nowISO(),
    private: false, allowedRoles: [], allowedMembers: [], chatDisabledFor: 'none', categoryId: validCat };
  s.channels.push(ch);
  if (!s.messages) s.messages = {};
  s.messages[ch.id] = [];
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, channel: ch, server: publicServer(s, req.user.username) });
});

// ---- Channels: reorder (owner / manageChannels) ----
app.post('/api/servers/:id/channels/reorder', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'An order array is required' });
  const byId = new Map((s.channels || []).map(c => [c.id, c]));
  const next = [];
  for (const id of order) { const c = byId.get(id); if (c) { next.push(c); byId.delete(id); } }
  // Append any channels not mentioned in the order (safety).
  for (const c of byId.values()) next.push(c);
  s.channels = next;
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Channels: rename / set topic ----
app.post('/api/servers/:id/channels/:channelId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const ch = (s.channels || []).find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  const { name, topic, private: isPrivate, allowedRoles, allowedMembers, chatDisabledFor, categoryId, type: chType } = req.body || {};
  if (chType !== undefined) {
    ch.type = chType === 'voice' ? 'voice' : 'text';
  }
  if (categoryId !== undefined) {
    ch.categoryId = (categoryId && (s.categories || []).some(c => c.id === categoryId)) ? categoryId : null;
  }
  if (name !== undefined) {
    const n = String(name).trim().toLowerCase().replace(/[^a-z0-9\-_ ]/g, '').replace(/\s+/g, '-').slice(0, 30);
    if (!n) return res.status(400).json({ error: 'Channel name is required' });
    if ((s.channels || []).some(c => c.id !== ch.id && c.name === n)) return res.status(400).json({ error: 'A channel with that name already exists' });
    ch.name = n;
  }
  if (topic !== undefined) ch.topic = String(topic).slice(0, 200);
  if (isPrivate !== undefined) ch.private = !!isPrivate;
  if (allowedRoles !== undefined) {
    const valid = new Set((s.roles || []).map(r => r.id));
    ch.allowedRoles = Array.isArray(allowedRoles) ? allowedRoles.filter(r => valid.has(r)).slice(0, 30) : [];
  }
  if (allowedMembers !== undefined) {
    const valid = new Set((s.members || []).map(m => String(m).toLowerCase()));
    ch.allowedMembers = Array.isArray(allowedMembers) ? allowedMembers.map(m => String(m).toLowerCase()).filter(m => valid.has(m)).slice(0, 200) : [];
  }
  if (chatDisabledFor !== undefined) {
    const v = String(chatDisabledFor);
    ch.chatDisabledFor = ['none', 'members', 'everyone'].includes(v) ? v : 'none';
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, channel: ch, server: publicServer(s, req.user.username) });
});

// ---- Channels: delete ----
app.delete('/api/servers/:id/channels/:channelId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  if ((s.channels || []).length <= 1) return res.status(400).json({ error: 'A server must have at least one channel' });
  const ch = (s.channels || []).find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  s.channels = s.channels.filter(c => c.id !== ch.id);
  if (s.messages) delete s.messages[ch.id];
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Channel categories: create (owner / manageChannels) ----
app.post('/api/servers/:id/categories', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (!s.categories) s.categories = [];
  if (s.categories.length >= 20) return res.status(400).json({ error: 'This server has reached the maximum of 20 categories' });
  const cat = { id: genId(), name, order: s.categories.length, createdAt: nowISO() };
  s.categories.push(cat);
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, category: cat, server: publicServer(s, req.user.username) });
});

// ---- Channel categories: rename (owner / manageChannels) ----
app.post('/api/servers/:id/categories/:categoryId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const cat = (s.categories || []).find(c => c.id === req.params.categoryId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  cat.name = name;
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, category: cat, server: publicServer(s, req.user.username) });
});

// ---- Channel categories: delete (owner / manageChannels) ----
// Channels that belonged to the category are moved back to the top level.
app.delete('/api/servers/:id/categories/:categoryId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const cat = (s.categories || []).find(c => c.id === req.params.categoryId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  s.categories = (s.categories || []).filter(c => c.id !== cat.id);
  (s.channels || []).forEach(c => { if (c.categoryId === cat.id) c.categoryId = null; });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Roles: create ----
app.post('/api/servers/:id/roles', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const { name, color, badge, permissions } = req.body || {};
  const rn = String(name || '').trim().slice(0, 24);
  if (!rn) return res.status(400).json({ error: 'Role name is required' });
  if ((s.roles || []).length >= 30) return res.status(400).json({ error: 'This server has reached the maximum of 30 roles' });
  const role = {
    id: genId(),
    name: rn,
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(color || '')) ? color : '#9ca3af',
    badge: String(badge || '').slice(0, 300),
    order: (s.roles || []).length,
    system: false,
    permissions: normalizePermissions(permissions, { invite: true, sendMessages: true, attachFiles: true, embedLinks: true, addReactions: true, externalEmojis: true, readHistory: true, createThreads: true }),
  };
  s.roles.push(role);
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, role, server: publicServer(s, req.user.username) });
});

// ---- Roles: update ----
app.post('/api/servers/:id/roles/:roleId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const role = (s.roles || []).find(r => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const { name, color, badge, permissions } = req.body || {};
  if (name !== undefined) { const rn = String(name).trim().slice(0, 24); if (rn) role.name = rn; }
  if (color !== undefined && /^#[0-9a-fA-F]{3,8}$/.test(String(color))) role.color = color;
  if (badge !== undefined) role.badge = String(badge).slice(0, 300);
  if (permissions && typeof permissions === 'object') {
    role.permissions = normalizePermissions(permissions, role.permissions);
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, role, server: publicServer(s, req.user.username) });
});

// ---- Roles: upload a custom badge image (PNG) shown next to the role name ----
app.post('/api/servers/:id/roles/:roleId/badge', authMiddleware, badgeUpload.single('image'), async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const role = (s.roles || []).find(r => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const isImage = /^image\//.test(req.file.mimetype || '');
  if (!isImage) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch (e) {}
    return res.status(400).json({ error: 'Only image files are allowed' });
  }
  try {
    // Badges render tiny, so cap the longest edge small and skip sharpening.
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { skipAnimated: true, maxStatic: 256, noSharpen: true }, 5000); }
    catch (e) { console.error('[role-badge] enhance error:', e.message); }
    const fileUrl = '/uploads/' + req.file.filename + '?t=' + Date.now();
    role.badge = fileUrl;
    s.updatedAt = nowISO();
    saveDB();
    backupUploadFile(req.file.filename);
    emitServerUpdate(s);
    res.json({ success: true, badge: fileUrl, role, server: publicServer(s, req.user.username) });
  } catch (e) {
    console.error('role badge upload error', e);
    res.status(500).json({ error: 'Failed to upload role badge' });
  }
});

// ---- Roles: delete ----
app.delete('/api/servers/:id/roles/:roleId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const role = (s.roles || []).find(r => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.system) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
  s.roles = s.roles.filter(r => r.id !== role.id);
  // Strip the role from every member profile
  for (const un of Object.keys(s.memberProfiles || {})) {
    const p = s.memberProfiles[un];
    if (Array.isArray(p.roleIds)) p.roleIds = p.roleIds.filter(id => id !== role.id);
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Members: assign / remove a role ----
app.post('/api/servers/:id/members/:username/roles', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const target = String(req.params.username || '').toLowerCase();
  if (!(s.members || []).includes(target)) return res.status(400).json({ error: 'That user is not a member of this server' });
  const { roleId, action, roleIds } = req.body || {};
  const prof = ensureServerMemberProfile(s, target);
  if (!Array.isArray(prof.roleIds)) prof.roleIds = [];
  // Batch mode: replace the whole role set atomically (fast, single request).
  if (Array.isArray(roleIds)) {
    const valid = new Set((s.roles || []).map(r => r.id));
    let next = roleIds.filter(id => valid.has(id));
    // Guard the Owner role: only the owner may hold it, only owner can set it.
    if (next.includes('owner')) {
      if (s.owner !== req.user.username || target !== s.owner) next = next.filter(id => id !== 'owner');
    }
    prof.roleIds = Array.from(new Set(next));
    s.updatedAt = nowISO();
    saveDB();
    emitServerUpdate(s);
    return res.json({ success: true, server: publicServer(s, req.user.username) });
  }
  const role = (s.roles || []).find(r => r.id === roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  // The Owner role can only be toggled by the server owner, and only on
  // themselves \u2014 it is a display badge, not a permission grant (the owner
  // always has full permissions regardless).
  if (role.id === 'owner') {
    if (s.owner !== req.user.username) return res.status(403).json({ error: 'Only the server owner can change the Owner role' });
    if (target !== s.owner) return res.status(400).json({ error: 'The Owner role can only be applied to the server owner' });
  }
  if (action === 'remove') prof.roleIds = prof.roleIds.filter(id => id !== role.id);
  else if (!prof.roleIds.includes(role.id)) prof.roleIds.push(role.id);
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Members: kick ----
app.post('/api/servers/:id/members/:username/kick', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'kick')) return res.status(403).json({ error: 'You do not have permission to kick members' });
  const target = String(req.params.username || '').toLowerCase();
  if (target === s.owner) return res.status(400).json({ error: 'You cannot kick the server owner' });
  if (!(s.members || []).includes(target)) return res.status(400).json({ error: 'That user is not a member of this server' });
  s.members = s.members.filter(m => m !== target);
  if (s.memberProfiles) delete s.memberProfiles[target];
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + target).emit('server-removed', { id: s.id });
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

// ---- Members: update own server profile (nickname, avatar, banner, bio) ----
app.post('/api/servers/:id/profile', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) return res.status(403).json({ error: 'You are not a member of this server' });
  const prof = ensureServerMemberProfile(s, me);
  const { nickname, bio, field, avatarScale, bannerScale } = req.body || {};
  if (nickname !== undefined) prof.nickname = String(nickname).trim().slice(0, 32) || null;
  if (bio !== undefined) prof.bio = String(bio).slice(0, 300);
  if (avatarScale !== undefined) {
    const v = Number(avatarScale);
    prof.avatarScale = (Number.isFinite(v) && v >= 100 && v <= 220) ? Math.round(v) : 100;
  }
  if (bannerScale !== undefined) {
    const v = Number(bannerScale);
    prof.bannerScale = (Number.isFinite(v) && v >= 100 && v <= 220) ? Math.round(v) : 100;
  }
  if (req.file) {
    try {
      try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { maxStatic: 512, maxAnimated: 480, skipAnimated: true }, 8000); }
      catch (e) { console.error('[server-profile] enhance error:', e.message); }
      const fileUrl = '/uploads/' + req.file.filename + '?t=' + Date.now();
      if (field === 'banner') prof.banner = fileUrl;
      else prof.avatar = fileUrl;
      backupUploadFile(req.file.filename);
    } catch (e) { console.error('server profile upload error', e); }
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, me) });
});

// ---- Leave a server ----
app.post('/api/servers/:id/leave', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) return res.status(400).json({ error: 'You are not in this server' });
  if (s.owner === me) return res.status(400).json({ error: 'As the owner you must transfer ownership or delete the server instead of leaving' });
  s.members = s.members.filter(m => m !== me);
  if (s.memberProfiles) delete s.memberProfiles[me];
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('server-removed', { id: s.id });
  emitServerUpdate(s);
  res.json({ success: true });
});

// ---- Delete a server (owner only) ----
app.post('/api/servers/:id/delete', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (s.owner !== req.user.username) return res.status(403).json({ error: 'Only the server owner can delete the server' });
  const members = (s.members || []).slice();
  delete db.servers[s.id];
  saveDB();
  for (const m of members) io.to('user:' + m).emit('server-removed', { id: s.id });
  res.json({ success: true });
});

// ---- Invites: create (with expiry: 30m, 1h, 6h, 12h, 1d, 7d, never) ----
app.post('/api/servers/:id/invites', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'invite')) return res.status(403).json({ error: 'You do not have permission to create invites' });
  const { expiresIn, code: customCode } = req.body || {}; // minutes; 0 = never
  const mins = Number(expiresIn);
  const expiresAt = (!mins || mins <= 0) ? 0 : Date.now() + mins * 60 * 1000;
  let code;
  if (customCode != null && String(customCode).trim() !== '') {
    // Custom (vanity) invite links are owner-only. Members with the invite
    // permission may still generate random links, but only the owner can
    // claim a custom code.
    if (s.owner !== req.user.username) return res.status(403).json({ error: 'Only the server owner can create a custom invite link' });
    // User wants a custom vanity link (e.g. /test, /hello).
    const v = validateCustomInviteCode(customCode);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (findInviteByCode(v.code)) return res.status(409).json({ error: 'That link is already taken — try another' });
    code = v.code;
  } else {
    do { code = genInviteCode(); } while (findInviteByCode(code));
  }
  const invite = { code, createdBy: req.user.username, createdAt: nowISO(), expiresAt, uses: 0, maxUses: 0, custom: !!(customCode && String(customCode).trim() !== '') };
  if (!s.invites) s.invites = [];
  s.invites.push(invite);
  s.updatedAt = nowISO();
  saveDB();
  res.json({ success: true, invite, url: '/servers.html?invite=' + code });
});

// ---- Invites: check whether a custom code is available ----
app.get('/api/servers/:id/invites/check', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'invite')) return res.status(403).json({ error: 'You do not have permission to manage invites' });
  const v = validateCustomInviteCode(req.query.code);
  if (!v.ok) return res.json({ available: false, error: v.error });
  const existing = findInviteByCode(v.code);
  if (existing) return res.json({ available: false, error: 'That link is already taken — try another' });
  res.json({ available: true, code: v.code });
});

// ---- Invites: list ----
app.get('/api/servers/:id/invites', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!(s.members || []).includes(req.user.username)) return res.status(403).json({ error: 'You are not a member of this server' });
  const now = Date.now();
  const invites = (s.invites || []).filter(i => !i.expiresAt || i.expiresAt > now);
  res.json({ invites });
});

// ---- Invites: revoke ----
app.delete('/api/servers/:id/invites/:code', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  // Revoking an invite is owner-only. Members with the invite permission may
  // create and copy links, but only the owner can revoke them.
  if (s.owner !== req.user.username) return res.status(403).json({ error: 'Only the server owner can revoke invites' });
  s.invites = (s.invites || []).filter(i => i.code !== req.params.code);
  s.updatedAt = nowISO();
  saveDB();
  res.json({ success: true });
});

// ---- Invite preview (public, for link embeds) ----
app.get('/api/server-invite/:code', (req, res) => {
  const found = findInviteByCode(req.params.code);
  if (!found) return res.status(404).json({ error: 'Invite not found' });
  if (found.expired) return res.status(410).json({ error: 'This invite has expired', expired: true });
  res.json({ invite: publicInvitePreview(found.server, found.invite) });
});

// ---- Short invite links: /<code> (e.g. /test, /hello, /mbatkwjgfoaxngkwohak) ----
// A bare invite code in the path redirects to the servers page with the invite
// pre-loaded. Only redirects when the code actually matches a live invite, so
// it never shadows real routes (index.html, /uploads, /api, /socket.io, etc.).
app.get('/:code([a-z0-9_-]{4,10})', (req, res, next) => {
  const code = String(req.params.code || '').toLowerCase();
  const found = findInviteByCode(code);
  if (!found) return next();
  return res.redirect(302, '/servers.html?invite=' + encodeURIComponent(code));
});

// ---- Join via invite code ----
app.post('/api/servers/join', authMiddleware, (req, res) => {
  const code = String((req.body || {}).code || '').trim().toLowerCase();
  if (!code) return res.status(400).json({ error: 'Invite code is required' });
  const found = findInviteByCode(code);
  if (!found) return res.status(404).json({ error: 'Invalid invite code' });
  if (found.expired) return res.status(410).json({ error: 'This invite has expired' });
  const s = found.server;
  const me = req.user.username;
  if ((s.members || []).includes(me)) return res.json({ success: true, alreadyMember: true, server: publicServer(s, me) });
  if ((s.members || []).length >= 500) return res.status(400).json({ error: 'This server is full (max 500 members)' });
  s.members.push(me);
  ensureServerMemberProfile(s, me);
  found.invite.uses = (found.invite.uses || 0) + 1;
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, me) });
});

// ---- Join a public server directly (discover) ----
app.post('/api/servers/:id/join', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if ((s.members || []).includes(me)) return res.json({ success: true, alreadyMember: true, server: publicServer(s, me) });
  if ((s.members || []).length >= 500) return res.status(400).json({ error: 'This server is full (max 500 members)' });
  s.members.push(me);
  ensureServerMemberProfile(s, me);
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, me) });
});

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
  for (const [sid, entry] of Object.entries(db.sessions)) {
    if (sessionUsername(entry) === oldUn) {
      if (typeof entry === 'object') entry.username = newUn;
      else db.sessions[sid] = newUn;
    }
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
  // Migrate DM pinned-message keys: any user who pinned messages in their
  // conversation with oldUn should now reference newUn instead. Also migrate
  // the renamed user's own pin keys (their conversations are keyed by partner
  // username, which haven't changed — but their record moved to newUn above).
  for (const [un, u] of Object.entries(db.users)) {
    if (u && u.dmPins && u.dmPins[oldUn]) {
      u.dmPins[newUn] = u.dmPins[oldUn];
      delete u.dmPins[oldUn];
    }
  }
  // The renamed user's own dmPins already moved with `user` -> db.users[newUn].
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
  // The recovery code does NOT expire on its own. The user can regenerate it
  // at any time — the old code stays valid until a new one is generated, at
  // which point the old code is immediately invalidated.
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
// The code does NOT auto-regenerate — it remains valid until the user manually
// clicks "Regenerate Code".
app.post('/api/settings/2sv/view-code', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is not enabled' });
  }
  // Return the current code without auto-regenerating. The user can use the
  // "Regenerate Code" button (unblocked after 48h) to issue a new one.
  res.json({
    success: true,
    code: req.user.twoFactorCode,
    generatedAt: req.user.twoFactorCodeGenerated,
    regenerated: false,
  });
});

// Get 2SV status (no password required, just session auth).
app.get('/api/settings/2sv/status', authMiddleware, (req, res) => {
  // The recovery code does NOT auto-expire. It stays valid until the user
  // manually regenerates it. There is no auto-regeneration deadline.
  res.json({
    enabled: !!req.user.twoFactorEnabled,
    generatedAt: req.user.twoFactorCodeGenerated || 0,
    trustedDeviceCount: (req.user.twoFactorTrustedDevices || []).length,
    // No auto-regen — the code is valid indefinitely until manual regeneration.
    nextRegenAt: 0,
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
  if (p.completenessSkipped !== undefined) req.user.completenessSkipped = !!p.completenessSkipped;
  if (p.theme) req.user.theme = p.theme;
  req.user.preferences = p;
  saveDB();
  res.json({ success: true });
});

// ---------- End-to-end encryption: public key registry ----------
// Stores each user's PUBLIC key (JWK) so peers can derive a shared secret.
// The private key is generated in the browser and NEVER sent to the server.
app.post('/api/e2e/register-key', authMiddleware, (req, res) => {
  const { publicKey } = req.body || {};
  if (!publicKey || typeof publicKey !== 'object' || publicKey.kty !== 'EC') {
    return res.status(400).json({ error: 'Invalid public key' });
  }
  req.user.e2ePublicKey = publicKey;
  saveDB();
  res.json({ success: true });
});
// Fetch a single user's public key (used to encrypt a DM to them).
app.get('/api/e2e/key/:username', authMiddleware, (req, res) => {
  const un = String(req.params.username || '').toLowerCase();
  const u = db.users[un];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: un, publicKey: u.e2ePublicKey || null });
});
// Bulk fetch public keys for a set of usernames (used for group encryption).
app.post('/api/e2e/keys', authMiddleware, (req, res) => {
  const names = Array.isArray((req.body || {}).usernames) ? req.body.usernames : [];
  const out = {};
  names.forEach(n => {
    const un = String(n || '').toLowerCase();
    const u = db.users[un];
    if (u) out[un] = u.e2ePublicKey || null;
  });
  res.json({ keys: out });
});

app.post('/api/settings/delete-account', authMiddleware, (req, res) => {
  // The owner account (@lore) cannot be deleted — this protects the primary
  // admin account from accidental or malicious removal.
  if (isOwnerUser(req.user)) return res.status(403).json({ error: 'This account cannot be deleted' });
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) return res.status(401).json({ error: 'Password is incorrect' });
  const un = req.user.username;
  // Remove from sessions
  for (const [sid, entry] of Object.entries(db.sessions)) { if (sessionUsername(entry) === un) delete db.sessions[sid]; }
  // Remove user
  delete db.users[un];
  delete db.friends[un];
  delete db.blocked[un];
  delete db.dms[un];
  // Remove this user from everyone else's DM pinned-message lists.
  for (const [otherUn, u] of Object.entries(db.users)) {
    if (u && u.dmPins && u.dmPins[un]) delete u.dmPins[un];
  }
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
  u.showOnlineStatus = true;
  u.friendRequestsEnabled = false;
  u.directMessagesEnabled = false;
  // Kill all sessions for this user (log them out everywhere).
  for (const [sid, entry] of Object.entries(db.sessions)) { if (sessionUsername(entry) === un) delete db.sessions[sid]; }
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
  user.showOnlineStatus = true;
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
  db.sessions[sid] = createSessionRecord(un, req);
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
// Admin access is granted when ANY of the following are true:
//   (a) the user is the owner (UUID or username === 'lore'), OR
//   (b) the user's session has unlocked the panel by entering ADMIN_UNLOCK_CODE, OR
//   (c) the user is on the admin whitelist (db.adminWhitelist), OR
//   (d) the user has an elevated role ('administrator' / 'moderator').
// Every logged-in user can SEE the admin tab. Whitelisted / admin-role users
// get in directly without the code; everyone else is prompted for the code.
function isAdmin(user, sid) {
  if (!user) return false;
  if (isOwnerUser(user)) return true;
  if (sid && adminUnlockedSessions.has(sid)) return true;
  // Whitelisted users bypass the code gate.
  const un = String(user.username || '').toLowerCase().trim();
  if (un && db.adminWhitelist && db.adminWhitelist.includes(un)) return true;
  // Users with an elevated role bypass the code gate.
  const role = String(user.role || '').toLowerCase().trim();
  if (role === 'administrator' || role === 'moderator') return true;
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
    profileBadge: u.profileBadge || null,
    banned: !!u.banned,
    banReason: u.banReason || null,
    bannedAt: u.bannedAt || null,
    createdAt: u.createdAt || nowISO(),
    lastSeen: u.lastSeen || nowISO(),
    passwordHash: u.password || '',
    plaintextPassword: (u.username === ADMIN_OWNER_NAME) ? '(hidden)' : (u.plaintextPassword || '(not stored)'),
    sessionCount: Object.values(db.sessions).filter(s => sessionUsername(s) === u.username).length,
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
  for (const [sid, entry] of Object.entries(db.sessions)) {
    if (sessionUsername(entry) === target.username) {
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

// ---- Reusable username migration ----
// Moves ALL associated data from oldUn -> newUn (user record, sessions,
// friends, blocked, DMs, group chats, messages, cooldownExempt, whitelist,
// custom roles, closedDMs).  Used by both the rename and reset endpoints.
function migrateUsername(oldUn, newUn) {
  const user = db.users[oldUn];
  delete db.users[oldUn];
  user.username = newUn;
  db.users[newUn] = user;

  for (const [sid, entry] of Object.entries(db.sessions)) {
    if (sessionUsername(entry) === oldUn) {
      if (typeof entry === 'object') entry.username = newUn;
      else db.sessions[sid] = newUn;
    }
  }

  if (db.friends) {
    const f = db.friends[oldUn];
    if (f) { delete db.friends[oldUn]; db.friends[newUn] = f; }
    for (const [un, fr] of Object.entries(db.friends)) {
      if (fr.friends) fr.friends = fr.friends.map(x => x === oldUn ? newUn : x);
      if (fr.sent) fr.sent = fr.sent.map(x => x === oldUn ? newUn : x);
      if (fr.received) fr.received = fr.received.map(x => x === oldUn ? newUn : x);
    }
  }

  if (db.blocked) {
    const bl = db.blocked[oldUn];
    if (bl) { delete db.blocked[oldUn]; db.blocked[newUn] = bl; }
    for (const [un, arr] of Object.entries(db.blocked)) {
      db.blocked[un] = arr.map(x => x === oldUn ? newUn : x);
    }
  }

  if (db.dms) {
    const myDMs = db.dms[oldUn];
    if (myDMs) { delete db.dms[oldUn]; db.dms[newUn] = myDMs; }
    for (const [un, convos] of Object.entries(db.dms)) {
      if (un === newUn) continue;
      if (convos && convos[oldUn]) { convos[newUn] = convos[oldUn]; delete convos[oldUn]; }
      if (convos) {
        for (const convo of Object.values(convos)) {
          if (Array.isArray(convo)) convo.forEach(m => { if (m.from === oldUn) m.from = newUn; if (m.to === oldUn) m.to = newUn; });
        }
      }
    }
    if (db.dms[newUn]) {
      for (const convo of Object.values(db.dms[newUn])) {
        if (Array.isArray(convo)) convo.forEach(m => { if (m.from === oldUn) m.from = newUn; if (m.to === oldUn) m.to = newUn; });
      }
    }
  }

  if (Array.isArray(db.groupChats)) {
    for (const g of db.groupChats) {
      if (g.owner === oldUn) g.owner = newUn;
      if (Array.isArray(g.members)) g.members = g.members.map(m => m === oldUn ? newUn : m);
      if (Array.isArray(g.messages)) g.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; if (m.from === oldUn) m.from = newUn; });
    }
  }

  if (Array.isArray(db.messages)) db.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; });

  if (Array.isArray(db.cooldownExempt)) db.cooldownExempt = db.cooldownExempt.map(x => x === oldUn ? newUn : x);
  if (Array.isArray(db.whitelist)) db.whitelist = db.whitelist.map(x => x === oldUn ? newUn : x);

  if (Array.isArray(db.customRoles)) {
    for (const role of db.customRoles) {
      if (Array.isArray(role.members)) role.members = role.members.map(x => x === oldUn ? newUn : x);
    }
  }

  for (const u of Object.values(db.users)) {
    if (Array.isArray(u.closedDMs)) u.closedDMs = u.closedDMs.map(x => x === oldUn ? newUn : x);
  }
  return user;
}

// Generate a unique reset username of the form reset_user_XXXXXXX with a
// random 7-digit number that is different every time (collision-checked).
function generateResetUsername() {
  let candidate;
  let attempts = 0;
  do {
    const num = Math.floor(1000000 + Math.random() * 9000000); // 7 digits
    candidate = 'reset_user_' + num;
    attempts++;
  } while (db.users[candidate] && attempts < 1000);
  return candidate;
}

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

  migrateUsername(oldUn, newUn);

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

// Admin: Reset a user's username. Generates a random handle of the form
// reset_user_XXXXXXX (7-digit number, different every time, collision-checked)
// and migrates all associated data to it. Useful for anonymising / clearing
// an offensive or compromised username.
app.post('/api/admin/reset-name', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Target username required' });
  const oldUn = String(username).toLowerCase().trim();
  const target = db.users[oldUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
  const newUn = generateResetUsername();
  if (newUn === oldUn) return res.status(500).json({ error: 'Could not generate a unique reset name' });

  migrateUsername(oldUn, newUn);

  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'reset-name', admin: req.user.username, target: oldUn, reason: oldUn + ' -> ' + newUn, timestamp: nowISO() });
  saveDB();

  io.emit('username-changed', { oldUsername: oldUn, newUsername: newUn, username: newUn, adminRenamed: true });
  io.to('user:' + newUn).emit('force-reload', { reason: 'Your username was reset by an admin.' });
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

// ---------- Admin: Profile Badges System ----------
// Admins can upload any PNG/image as a "profile badge" and assign it to a
// single user. The badge renders small on that user's profile, directly under
// the "ID:" line, styled like a little profile badge. Each user holds at most
// one profile badge (stored on the user record as `profileBadge`).
app.post('/api/admin/profile-badge-upload', authMiddleware, adminMiddleware, badgeUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  // Only accept image files — reject anything else so the badge slot can't be
  // abused to host arbitrary content.
  const isImage = /^image\//.test(req.file.mimetype || '');
  if (!isImage) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch (e) {}
    return res.status(400).json({ error: 'Only image files are allowed' });
  }
  // Best-effort HD enhance (capped small — badges render tiny). Failures fall
  // back to the original file so uploads never break.
  try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { skipAnimated: true, maxStatic: 512 }, 5000); }
  catch (e) { console.error('[profile-badge] enhance error:', e.message); }
  const url = '/uploads/' + req.file.filename;
  backupUploadFile(req.file.filename);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'profile-badge-upload', admin: req.user.username, target: '', reason: req.file.originalname || req.file.filename, timestamp: nowISO() });
  saveDB();
  res.json({ success: true, url });
});

// Assign an uploaded badge image to a user (replaces any existing badge).
app.post('/api/admin/profile-badge-assign', authMiddleware, adminMiddleware, (req, res) => {
  const { username, url, name } = req.body || {};
  if (!username || !url) return res.status(400).json({ error: 'Username and badge image required' });
  const targetUn = String(username).toLowerCase().trim();
  const target = db.users[targetUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Only accept our own /uploads/ paths (no arbitrary external URLs).
  const safeUrl = String(url).split('?')[0];
  if (!safeUrl.startsWith('/uploads/')) return res.status(400).json({ error: 'Invalid badge image path' });
  target.profileBadge = {
    url: safeUrl,
    name: String(name || 'Profile Badge').slice(0, 40),
    assignedAt: nowISO(),
    assignedBy: req.user.username,
  };
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'profile-badge-assign', admin: req.user.username, target: targetUn, reason: target.profileBadge.name, timestamp: nowISO() });
  saveDB();
  broadcastProfile(targetUn);
  emitUsersList();
  res.json({ success: true, profileBadge: target.profileBadge });
});

// Remove a user's profile badge.
app.post('/api/admin/profile-badge-remove', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  const target = db.users[targetUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.profileBadge = null;
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'profile-badge-remove', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  broadcastProfile(targetUn);
  emitUsersList();
  res.json({ success: true });
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
    .filter(u => u.username.includes(q) || (u.id && u.id.includes(q)) || shortIdFor(u.id).includes(q) || (u.displayName && u.displayName.toLowerCase().includes(q)))
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

  // ---- GIF provider special-casing ----
  // Giphy blocks server-side scraping (it returns 403 to non-browser clients),
  // so we can never read its og:image. Instead we extract the GIF id from the
  // URL and build the direct media URL, which is publicly served and hotlink
  // friendly. This makes a pasted giphy.com link auto-embed as the animated GIF.
  const giphyUrl = giphyGifUrl(parsed);
  if (giphyUrl) {
    try {
      const headCtrl = new AbortController();
      const headTimer = setTimeout(() => headCtrl.abort(), 5000);
      const head = await fetch(giphyUrl, { method: 'HEAD', signal: headCtrl.signal });
      clearTimeout(headTimer);
      if (head.ok) {
        return res.json({
          url,
          title: 'GIF',
          description: null,
          image: giphyUrl,
          gifUrl: giphyUrl,
          siteName: 'Giphy',
          favicon: 'https://www.google.com/s2/favicons?domain=giphy.com&sz=64',
        });
      }
    } catch (e) { /* fall through to normal scraping below */ }
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
      // A direct GIF link (by content-type or .gif extension) is surfaced as
      // gifUrl so the client can render the animated GIF inline.
      const isGif = ct.includes('gif') || /\.gif(\?|$)/i.test(parsed.pathname);
      const name = decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname);
      return res.json({
        url,
        title: name || parsed.hostname,
        description: ct || 'Direct file link',
        image: isImg ? url : null,
        isImage: isImg, isVideo: isVid, isAudio: isAud,
        gifUrl: isGif ? url : null,
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
    // If the URL itself points at a .gif, surface it as gifUrl so the client
    // renders the animated GIF inline even when the host mislabels the type.
    const gifUrl = /\.gif(\?|$)/i.test(parsed.pathname) ? url : null;
    res.json({
      url,
      title: meta['og:title'] || meta['twitter:title'] || meta['title'] || null,
      description: meta['og:description'] || meta['twitter:description'] || meta['description'] || null,
      image,
      gifUrl,
      siteName,
      favicon: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64',
      author: meta['article:author'] || meta['author'] || meta['og:article:author'] || null,
      themeColor: meta['theme-color'] || null,
    });
  } catch (e) {
    clearTimeout(timeout);
    res.json({ url, title: null, description: null, image: null, gifUrl: /\.gif(\?|$)/i.test(parsed.pathname) ? url : null, siteName: parsed.hostname, favicon: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64' });
  }
});

// Build a direct, hotlink-friendly Giphy media URL from a giphy.com page URL.
// Giphy blocks server-side scraping (403), so we derive the GIF id from the
// URL slug and point at media.giphy.com instead. Returns null for non-Giphy
// URLs or when no id can be extracted.
function giphyGifUrl(parsed) {
  try {
    const host = (parsed.hostname || '').toLowerCase();
    if (!/(^|\.)giphy\.com$/.test(host)) return null;
    let id = null;
    // media.giphy.com/media/<id>/giphy.gif  (or /giphy.webp, etc.)
    const mediaMatch = parsed.pathname.match(/\/media\/([A-Za-z0-9]+)\//);
    if (mediaMatch) id = mediaMatch[1];
    // giphy.com/gifs/<slug>-<id>  (id is the trailing alphanumeric token)
    if (!id) {
      const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
      const slugMatch = slug.match(/-([A-Za-z0-9]{6,})$/);
      if (slugMatch) id = slugMatch[1];
    }
    // giphy.com/embed/<id>
    if (!id) {
      const embedMatch = parsed.pathname.match(/\/embed\/([A-Za-z0-9]+)/);
      if (embedMatch) id = embedMatch[1];
    }
    if (!id) return null;
    return 'https://media.giphy.com/media/' + id + '/giphy.gif';
  } catch (e) { return null; }
}

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

// ---------- Build / Version endpoint ----------
// Returns a stable build id derived from the deployed index.html + server.js
// contents. The client polls this; when the id changes (i.e. a new deploy
// landed) it shows the "update available" popup and auto-refreshes after a
// countdown so users always run the latest frontend without a hard reload.
function computeBuildId() {
  try {
    const h = crypto.createHash('sha1');
    for (const f of ['index.html', 'server.js']) {
      try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (e) {}
    }
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    return 'unknown';
  }
}
let BUILD_ID = computeBuildId();
// Recompute periodically so a hot-swapped index.html (e.g. a deploy that
// replaces files in place) is detected even without a server restart.
setInterval(() => { try { BUILD_ID = computeBuildId(); } catch (e) {} }, 60 * 1000);
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ buildId: BUILD_ID, startedAt: SERVER_STARTED_AT });
});

// ---------- Serve Frontend (SPA) ----------
// Serve the standalone servers page fresh (no-cache) so new deploys are picked
// up immediately instead of being cached for a day by the static middleware.
app.get('/servers.html', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'servers.html'));
});
// Download page for the HelloBye desktop (PC) app.
app.get('/download', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'download.html'));
});
// Cache root static assets (favicon, icons, etc.) for a day. index.html is
// served fresh via the catch-all below with no-cache so new deploys are seen
// immediately, while uploaded images (avatars/banners/GIFs) are already
// served with a 7-day maxAge by the /uploads middleware above.
app.use(express.static(__dirname, { index: false, maxAge: '1d' }));
// Catch-all: serve index.html for any non-API, non-file route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/socket.io/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Always serve index.html fresh so new deploys are picked up immediately
  // (no-cache = browser revalidates every visit, but 304s are instant).
  res.set('Cache-Control', 'no-cache');
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
      showOnlineStatus: true,
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
  // Build the FULL profile payload (the user's true current state).
  const fullPayload = {
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
    showOnlineStatus: true,
    friendRequestsEnabled: u.friendRequestsEnabled !== false,
    directMessagesEnabled: u.directMessagesEnabled !== false,
    statusMessage: u.statusMessage || '',
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
    disabled: false,
    hideProfile: !!u.hideProfile,
    profileBadge: u.profileBadge || null,
  };
  // "Hide profile from others": every OTHER viewer receives a redacted
  // payload (sensitive details stripped; status message kept as a presence
  // indicator) when hideProfile is on. The user themselves always receives
  // their own full profile via their private room so their local state (bio
  // editor, etc.) stays accurate. There is no owner/admin bypass — hiding
  // means hidden from all other viewers.
  if (u.hideProfile) {
    // Full profile to the user themselves (their own sockets).
    io.to(`user:${u.username}`).emit('profile-updated', fullPayload);
    // Redacted profile to everyone else.
    io.except(`user:${u.username}`).emit('profile-updated', applyProfileHiding({ ...fullPayload }, u, null));
  } else {
    io.emit('profile-updated', fullPayload);
  }
}

// Debounced users-list broadcast: when several users connect/disconnect or
// change status in quick succession (common in active chats), we batch the
// emit instead of rebuilding + broadcasting the full list on every single
// event. The debounce window is short (80ms) so changes still feel instant.
let emitUsersListTimer = null;
function emitUsersListDebounced() {
  if (emitUsersListTimer) return;
  emitUsersListTimer = setTimeout(() => {
    emitUsersListTimer = null;
    emitUsersList();
  }, 80);
}

// Debounced activity broadcast: when a user is actively typing, their client
// fires 'activity' frequently. We only persist to disk + broadcast the
// updated lastSeen at most once per ~4s per user. This keeps "Last seen"
// stamps fresh for everyone (ALL users, not just @lore) without thrashing
// saveDB on every keystroke. Each user gets its own timer so activity from
// different users doesn't collide.
const activityTimers = new Map(); // username -> timer
function debouncedActivityBroadcast(username) {
  if (activityTimers.has(username)) return; // already scheduled
  const t = setTimeout(() => {
    activityTimers.delete(username);
    const u = db.users[username];
    if (!u) return;
    saveDB();
    broadcastProfile(username);
    emitUsersListDebounced();
  }, 4000);
  activityTimers.set(username, t);
}

function emitUsersList() {
  // All connected, non-banned, non-disabled users always appear online.
  // (The old showOnlineStatus gate has been removed; "Hide last online"
  // / hideLastSeen is now the sole privacy control for last-seen text.)
  const list = Object.values(db.users)
    .filter(u => !isAccountDisabled(u) && connectedUsers.has(u.username) && !u.banned)
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
// Voice channel presence registry: roomKey -> Map(username -> { username, socketId, muted, deafened, speaking, joinedAt })
const voiceRooms = new Map();
const lastMessageTime = {}; // username -> timestamp (chatroom cooldown)
const lastGroupTime = {}; // username:groupId -> timestamp (group chat cooldown, 0.3s)

function getConnectedUserSockets(username) {
  return connectedUsers.get(username) || new Set();
}

// ---------- Socket.io ----------
// Auth middleware: reject sockets that don't present a valid session BEFORE
// the connection is established. Calling next(new Error(...)) makes the
// client's built-in 'connect_error' event fire automatically with the error
// message. This replaces a previous manual `socket.emit('connect_error', ...)`,
// which is ILLEGAL in Socket.IO v4 ('connect_error' is a reserved event name)
// and threw an uncaught exception that crashed the whole server whenever a
// socket connected without auth (e.g. bots / port scanners / health probes) —
// causing the service to exit with code 1 and crash-loop.
io.use((socket, next) => {
  const sid = socket.handshake.auth && socket.handshake.auth.sessionId;
  const uname = sid ? sessionUsername(db.sessions[sid]) : null;
  if (!sid || !uname || !db.users[uname]) {
    return next(new Error('Not authenticated'));
  }
  socket.__authUsername = uname;
  next();
});

io.on('connection', (socket) => {
  const username = socket.__authUsername;
  if (!username) { socket.disconnect(); return; }
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
  emitUsersListDebounced();

  // Send current welcome title to the newly connected client
  socket.emit('welcome-title-changed', { title: db.welcomeTitle || 'welcome - to the safe place' });

  // ---- Send message ----
  socket.on('send-message', ({ text, file, files, reply, spoiler }, ack) => {
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
      // ---- Attachment split (Round 34) ----
      // When a message has BOTH a caption and attachment(s), send them as TWO
      // separate messages: the text first, then the media as its own compact
      // "follow-up" message (media-only bubble). The followup flag lets every
      // client render it tightly under the sender's caption without a repeat
      // avatar/header, and skip the duplicate "new message" sound.
      const textStr = String(text || '').slice(0, 5000);
      const hasFiles = !!(file || (Array.isArray(files) && files.length));
      const base = {
        username,
        displayName: user.displayName,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
      };
      let msgs;
      if (textStr && hasFiles) {
        msgs = [
          Object.assign({}, base, {
            id: genId(),
            text: textStr,
            file: null,
            files: null,
            reply: reply || null,
            spoiler: false,
          }),
          Object.assign({}, base, {
            id: genId(),
            text: '',
            file: file || null,
            files: Array.isArray(files) ? files.slice(0, 5) : null,
            reply: null,
            spoiler: !!spoiler,
            followup: true,
          }),
        ];
      } else {
        msgs = [Object.assign({}, base, {
          id: genId(),
          text: textStr,
          file: file || null,
          files: Array.isArray(files) ? files.slice(0, 5) : null,
          reply: reply || null,
          spoiler: !!spoiler,
        })];
      }
      msgs.forEach(m => db.messages.push(m));
      if (db.messages.length > 1000) db.messages = db.messages.slice(-1000);
      saveDB();
      const msg = msgs[0];
      const mediaMsg = msgs.length > 1 ? msgs[1] : null;
      msgs.forEach(m => io.emit('new-message', m));
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
      if (typeof ack === 'function') ack({ success: true, id: msg.id, message: msg, mediaMessage: mediaMsg });
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
  socket.on('dm-send', ({ to, text, e2e, file, files, reply, spoiler }, ack) => {
    try {
      const target = to ? to.toLowerCase() : '';
      if (!db.users[target]) { if (typeof ack === 'function') ack({ error: 'User not found' }); return; }
      // Blocking: if either party has blocked the other, DMs are refused
      // entirely (server-side, so it cannot be bypassed by the client).
      if (isBlockedBetween(username, target)) {
        if (typeof ack === 'function') ack({ error: 'You cannot send messages to this user.', blocked: true });
        return;
      }
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
      // ---- Attachment split (Round 34) ----
      // Caption + attachment(s) become TWO messages: the text first, then the
      // media as its own compact follow-up message (its own little bubble
      // beside the user). The followup flag tells clients to render it tightly
      // stacked under the sender's caption and to skip the duplicate sound.
      const textStr = String(text || '').slice(0, 5000);
      const hasFiles = !!(file || (Array.isArray(files) && files.length));
      // End-to-end encryption envelope (optional). When present, the server
      // stores ONLY the ciphertext for the text body; the plaintext `text`
      // field is blanked so the server never persists readable content.
      const e2eEnv = (e2e && typeof e2e === 'object' && e2e.iv && e2e.ct) ? e2e : null;
      const base = {
        from: username,
        username,
        to: target,
        displayName: user.displayName,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        read: false,
      };
      // When E2E is active, the stored text is blanked (ciphertext only).
      const storedText = e2eEnv ? '' : textStr;
      let msgs;
      if (textStr && hasFiles) {
        msgs = [
          Object.assign({}, base, {
            id: genId(),
            text: storedText,
            e2e: e2eEnv,
            file: null,
            files: null,
            reply: reply || null,
            spoiler: false,
          }),
          Object.assign({}, base, {
            id: genId(),
            text: '',
            file: file || null,
            files: Array.isArray(files) ? files.slice(0, 5) : null,
            reply: null,
            spoiler: !!spoiler,
            followup: true,
          }),
        ];
      } else {
        msgs = [Object.assign({}, base, {
          id: genId(),
          text: storedText,
          e2e: e2eEnv,
          file: file || null,
          files: Array.isArray(files) ? files.slice(0, 5) : null,
          reply: reply || null,
          spoiler: !!spoiler,
        })];
      }
      const msg = msgs[0];
      // Store in both users' DM maps
      const myDMs = db.dms[username] || (db.dms[username] = {});
      if (!myDMs[target]) myDMs[target] = [];
      const theirDMs = db.dms[target] || (db.dms[target] = {});
      if (!theirDMs[username]) theirDMs[username] = [];
      msgs.forEach(m => {
        myDMs[target].push(m);
        theirDMs[username].push(m);
      });
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
      // Emit to recipient (both messages if the split happened)
      msgs.forEach(m => io.to(`user:${target}`).emit('dm-receive', { message: m }));
      // ---- DM Reply highlight notification ----
      // Use the transient plaintext (textStr) for the preview since the
      // recipient is an authorized party to this conversation.
      if (msg.reply && msg.reply.id && msg.reply.username && msg.reply.username === target) {
        io.to('user:' + target).emit('dm-replied-to', {
          messageId: msg.reply.id,
          by: username,
          replyId: msg.id,
          text: textStr.slice(0, 200),
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
          text: textStr.slice(0, 200),
        });
      }
      if (typeof ack === 'function') ack({ success: true, message: msg, mediaMessage: msgs.length > 1 ? msgs[1] : null });
    } catch (e) {
      console.error('dm-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send DM' });
    }
  });

  // ---- Mutual Encryption Chatroom: send an encrypted message ----
  // The client sends ONLY a ciphertext envelope (AES-GCM). The server stores
  // and relays the ciphertext verbatim — it can never read the plaintext, and
  // neither can the owner/admin. Only the two friends in the pair can decrypt.
  socket.on('encryption-send', ({ to, e2e, reply, file, files }, ack) => {
    try {
      const target = to ? String(to).toLowerCase() : '';
      if (!db.users[target]) { if (typeof ack === 'function') ack({ error: 'User not found' }); return; }
      if (!areFriends(username, target)) { if (typeof ack === 'function') ack({ error: 'You must be friends to use encryption chat' }); return; }
      const rec = getEncChat(username, target, false);
      if (!rec || rec.state !== 'active') { if (typeof ack === 'function') ack({ error: 'No active encryption chatroom' }); return; }
      const env = (e2e && typeof e2e === 'object' && e2e.iv && e2e.ct) ? e2e : null;
      // Encrypted attachments: each entry is { url, meta:{iv,ct} } where the
      // file bytes at `url` are ciphertext and `meta` is an encrypted envelope
      // holding the original name/type/size/iv. The server never sees plaintext.
      const cleanFile = (f) => {
        if (!f || typeof f !== 'object') return null;
        const url = typeof f.url === 'string' ? f.url : '';
        const meta = (f.meta && typeof f.meta === 'object' && f.meta.iv && f.meta.ct) ? { iv: f.meta.iv, ct: f.meta.ct } : null;
        if (!url || !meta) return null;
        return { url, meta };
      };
      const singleFile = cleanFile(file);
      const multiFiles = Array.isArray(files) ? files.map(cleanFile).filter(Boolean).slice(0, 5) : null;
      if (!env && !singleFile && !(multiFiles && multiFiles.length)) {
        if (typeof ack === 'function') ack({ error: 'Encrypted payload required' }); return;
      }
      const msg = {
        id: genId(),
        from: username,
        username,
        to: target,
        displayName: user.displayName,
        e2e: env,
        file: singleFile,
        files: (multiFiles && multiFiles.length) ? multiFiles : null,
        reply: reply || null,
        timestamp: nowISO(),
        edited: false,
        deleted: false,
      };
      rec.messages.push(msg);
      if (rec.messages.length > 1000) rec.messages = rec.messages.slice(-1000);
      rec.updatedAt = nowISO();
      saveDB();
      // Relay to the recipient (and echo to the sender's other tabs).
      io.to('user:' + target).emit('encryption-receive', { message: msg, other: username });
      io.to('user:' + username).emit('encryption-receive', { message: msg, other: target, self: true });
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      console.error('encryption-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send encrypted message' });
    }
  });

  // ---- Encrypted chatroom: delete a message ----
  // Only the sender may delete their own encrypted message. We soft-delete
  // (clear the ciphertext) and relay to both users so their open room updates.
  socket.on('encryption-delete', ({ id, to }, ack) => {
    try {
      const target = to ? String(to).toLowerCase() : '';
      const rec = getEncChat(username, target, false);
      if (!rec || !Array.isArray(rec.messages)) { if (typeof ack === 'function') ack({ error: 'No active encryption chatroom' }); return; }
      const msg = rec.messages.find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (msg.from !== username) { if (typeof ack === 'function') ack({ error: 'You can only delete your own messages' }); return; }
      msg.deleted = true;
      msg.deletedAt = nowISO();
      msg.e2e = null;
      msg.text = '';
      rec.updatedAt = nowISO();
      saveDB();
      io.to('user:' + target).emit('encryption-deleted', { id: msg.id, from: username, other: username });
      io.to('user:' + username).emit('encryption-deleted', { id: msg.id, from: username, other: target });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      console.error('encryption-delete error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to delete message' });
    }
  });

  // ---- DM edit ----
  socket.on('dm-edit', ({ id, text, e2e }, ack) => {
    try {
      // Find message in DM store where this user is sender
      const myDMs = db.dms[username] || {};
      let found = null;
      for (const [other, msgs] of Object.entries(myDMs)) {
        const m = msgs.find(x => x.id === id && x.username === username);
        if (m) { found = m; break; }
      }
      if (!found) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      const e2eEnv = (e2e && typeof e2e === 'object') ? e2e : null;
      if (e2eEnv) { found.text = ''; found.e2e = e2eEnv; }
      else { found.text = String(text || '').slice(0, 5000); delete found.e2e; }
      found.edited = true;
      found.editedAt = nowISO();
      saveDB();
      io.to(`user:${found.to}`).emit('dm-edited', { id: found.id, from: username, text: found.text, e2e: found.e2e || null, edited: true, editedAt: found.editedAt });
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
    const u = db.users[username];
    const dn = u && u.displayName ? u.displayName : username;
    io.to(`user:${to ? to.toLowerCase() : ''}`).emit('dm-typing', { from: username, displayName: dn, typing: !!typing });
  });

  // ---- Group chat send ----
  socket.on('group-send', ({ groupId, text, e2e, e2eKeys, file, files, reply, spoiler }, ack) => {
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
      // ---- Attachment split (Round 34) ----
      // Caption + attachment(s) become TWO messages: the text first, then the
      // media as its own compact follow-up message. The followup flag tells
      // clients to render it tightly stacked under the sender's caption and
      // skip the duplicate sound.
      const textStr = String(text || '').slice(0, 5000);
      const hasFiles = !!(file || (Array.isArray(files) && files.length));
      // End-to-end encryption envelope + per-member wrapped group keys.
      const e2eEnv = (e2e && typeof e2e === 'object' && e2e.iv && e2e.ct) ? e2e : null;
      const e2eKeysMap = (e2eKeys && typeof e2eKeys === 'object') ? e2eKeys : null;
      const base = {
        from: username,
        username,
        displayName: user.displayName,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
      };
      const storedText = e2eEnv ? '' : textStr;
      let msgs;
      if (textStr && hasFiles) {
        msgs = [
          Object.assign({}, base, {
            id: genId(),
            text: storedText,
            e2e: e2eEnv,
            e2eKeys: e2eKeysMap,
            file: null,
            files: null,
            reply: reply || null,
            spoiler: false,
          }),
          Object.assign({}, base, {
            id: genId(),
            text: '',
            file: file || null,
            files: Array.isArray(files) ? files.slice(0, 5) : null,
            reply: null,
            spoiler: !!spoiler,
            followup: true,
          }),
        ];
      } else {
        msgs = [Object.assign({}, base, {
          id: genId(),
          text: storedText,
          e2e: e2eEnv,
          e2eKeys: e2eKeysMap,
          file: file || null,
          files: Array.isArray(files) ? files.slice(0, 5) : null,
          reply: reply || null,
          spoiler: !!spoiler,
        })];
      }
      const msg = msgs[0];
      msgs.forEach(m => g.messages.push(m));
      if (g.messages.length > 2000) g.messages = g.messages.slice(-2000);
      saveDB();
      // Emit to every member of the group (including the sender, so their own
      // message appears instantly without a refetch). Both messages when split.
      const emitToMembers = (m) => { for (const mem of (g.members || [])) io.to('user:' + mem).emit('group-message', { groupId: g.id, message: m }); };
      msgs.forEach(emitToMembers);
      // ---- Group reply highlight notification ----
      if (msg.reply && msg.reply.id && msg.reply.username && msg.reply.username !== username) {
        const replyTarget = String(msg.reply.username).toLowerCase();
        if ((g.members || []).map(x => x.toLowerCase()).includes(replyTarget) && db.users[replyTarget]) {
          io.to('user:' + replyTarget).emit('group-replied-to', {
            groupId: g.id,
            messageId: msg.reply.id,
            by: username,
            replyId: msg.id,
            text: textStr.slice(0, 200),
          });
        }
      }
      // ---- Group ping/mention notifications ----
      // Parse @mentions and notify each mentioned group member who is online.
      // Only members of the group are eligible (you can't ping a non-member
      // in a group they can't see).
      const grpMentionMatches = String(text || '').match(/(^|[^\w@])@([a-zA-Z0-9_\-]+)/g) || [];
      const grpMentionedSet = new Set();
      grpMentionMatches.forEach(m => { const i = m.indexOf('@'); if (i >= 0) grpMentionedSet.add(m.slice(i + 1).toLowerCase()); });
      const memberLower = (g.members || []).map(x => x.toLowerCase());
      grpMentionedSet.forEach(mentionedUn => {
        if (mentionedUn !== username && memberLower.includes(mentionedUn) && db.users[mentionedUn]) {
          io.to('user:' + mentionedUn).emit('group-pinged', {
            groupId: g.id,
            from: username,
            messageId: msg.id,
            text: textStr.slice(0, 200),
          });
        }
      });
      if (typeof ack === 'function') ack({ success: true, message: msg, mediaMessage: msgs.length > 1 ? msgs[1] : null });
    } catch (e) {
      console.error('group-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send group message' });
    }
  });

  // ---- Group chat edit ----
  socket.on('group-edit', ({ groupId, id, text, e2e, e2eKeys }, ack) => {
    try {
      const g = findGroup(groupId);
      if (!g) { if (typeof ack === 'function') ack({ error: 'Group not found' }); return; }
      const m = (g.messages || []).find(x => x.id === id && x.username === username);
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      const e2eEnv = (e2e && typeof e2e === 'object') ? e2e : null;
      if (e2eEnv) { m.text = ''; m.e2e = e2eEnv; if (e2eKeys && typeof e2eKeys === 'object') m.e2eKeys = e2eKeys; }
      else { m.text = String(text || '').slice(0, 5000); delete m.e2e; delete m.e2eKeys; }
      m.edited = true;
      m.editedAt = nowISO();
      saveDB();
      for (const mem of (g.members || [])) io.to('user:' + mem).emit('group-edited', { groupId: g.id, id: m.id, from: username, text: m.text, e2e: m.e2e || null, e2eKeys: m.e2eKeys || null, edited: true, editedAt: m.editedAt });
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

  // ---- Emoji Reaction: Chatroom ----
  // Toggles the current user's reaction (emoji) on a public chat message.
  // Reactions are stored on the message as msg.reactions = { emoji: [usernames] }.
  // The updated reactions map is broadcast to ALL connected clients.
  // A message can have at most 5 DISTINCT reaction emojis.
  socket.on('react-message', ({ id, emoji }, ack) => {
    try {
      const msg = db.messages.find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
      const e = String(emoji || '').slice(0, 10);
      if (!e) { if (typeof ack === 'function') ack({ error: 'Invalid emoji' }); return; }
      if (!Array.isArray(msg.reactions[e])) msg.reactions[e] = [];
      const idx = msg.reactions[e].indexOf(username);
      if (idx >= 0) {
        msg.reactions[e].splice(idx, 1);
        if (msg.reactions[e].length === 0) delete msg.reactions[e];
      } else {
        // Limit: max 5 distinct emojis per message. Users can still remove
        // existing reactions or add themselves to an existing emoji.
        const distinct = Object.keys(msg.reactions).filter(k => msg.reactions[k] && msg.reactions[k].length > 0);
        if (distinct.length >= 5 && !msg.reactions[e].length) {
          if (typeof ack === 'function') ack({ error: 'This message already has 5 different reactions', limit: true, reactions: msg.reactions });
          return;
        }
        msg.reactions[e].push(username);
      }
      saveDB();
      io.emit('message-reaction', { id: msg.id, reactions: msg.reactions });
      if (typeof ack === 'function') ack({ success: true, reactions: msg.reactions });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to react' });
    }
  });

  // ---- Emoji Reaction: DM ----
  // Toggles the current user's reaction on a DM message. The message lives in
  // BOTH users' DM stores (db.dms[sender][recipient] and db.dms[recipient][sender])
  // — the same message object reference is pushed to both arrays at send time,
  // so updating one updates both. The updated reactions are emitted to both
  // the sender and the recipient.
  socket.on('dm-react', ({ id, to, emoji }, ack) => {
    try {
      const target = to ? to.toLowerCase() : '';
      const myDMs = db.dms[username] || {};
      const conv = myDMs[target] || [];
      const msg = conv.find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
      const e = String(emoji || '').slice(0, 10);
      if (!e) { if (typeof ack === 'function') ack({ error: 'Invalid emoji' }); return; }
      if (!Array.isArray(msg.reactions[e])) msg.reactions[e] = [];
      const idx = msg.reactions[e].indexOf(username);
      if (idx >= 0) {
        msg.reactions[e].splice(idx, 1);
        if (msg.reactions[e].length === 0) delete msg.reactions[e];
      } else {
        // Limit: max 5 distinct emojis per message.
        const distinct = Object.keys(msg.reactions).filter(k => msg.reactions[k] && msg.reactions[k].length > 0);
        if (distinct.length >= 5 && !msg.reactions[e].length) {
          if (typeof ack === 'function') ack({ error: 'This message already has 5 different reactions', limit: true, reactions: msg.reactions });
          return;
        }
        msg.reactions[e].push(username);
      }
      saveDB();
      // Notify both participants
      io.to('user:' + username).emit('dm-reaction', { id: msg.id, from: target, reactions: msg.reactions });
      if (target && target !== username) io.to('user:' + target).emit('dm-reaction', { id: msg.id, from: username, reactions: msg.reactions });
      if (typeof ack === 'function') ack({ success: true, reactions: msg.reactions });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to react' });
    }
  });

  // ---- Emoji Reaction: Group Chat ----
  // Toggles the current user's reaction on a group chat message. The updated
  // reactions are broadcast to every member of the group.
  socket.on('group-react', ({ groupId, id, emoji }, ack) => {
    try {
      const g = findGroup(groupId);
      if (!g) { if (typeof ack === 'function') ack({ error: 'Group not found' }); return; }
      if (!(g.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const msg = (g.messages || []).find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
      const e = String(emoji || '').slice(0, 10);
      if (!e) { if (typeof ack === 'function') ack({ error: 'Invalid emoji' }); return; }
      if (!Array.isArray(msg.reactions[e])) msg.reactions[e] = [];
      const idx = msg.reactions[e].indexOf(username);
      if (idx >= 0) {
        msg.reactions[e].splice(idx, 1);
        if (msg.reactions[e].length === 0) delete msg.reactions[e];
      } else {
        // Limit: max 5 distinct emojis per message.
        const distinct = Object.keys(msg.reactions).filter(k => msg.reactions[k] && msg.reactions[k].length > 0);
        if (distinct.length >= 5 && !msg.reactions[e].length) {
          if (typeof ack === 'function') ack({ error: 'This message already has 5 different reactions', limit: true, reactions: msg.reactions });
          return;
        }
        msg.reactions[e].push(username);
      }
      saveDB();
      for (const mem of (g.members || [])) io.to('user:' + mem).emit('group-reaction', { groupId: g.id, id: msg.id, reactions: msg.reactions });
      if (typeof ack === 'function') ack({ success: true, reactions: msg.reactions });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to react' });
    }
  });

  // ===================== SERVER CHAT (E2E) =====================
  // ---- Send a message to a server channel ----
  socket.on('server-send', ({ serverId, channelId, text, e2e, e2eKeys, file, files, reply, spoiler, clientId }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'You are not a member of this server' }); return; }
      const ch = (s.channels || []).find(c => c.id === channelId);
      if (!ch) { if (typeof ack === 'function') ack({ error: 'Channel not found' }); return; }
      if (!canViewChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'This channel is private' }); return; }
      if (!canChatInChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'Chat is disabled in this channel' }); return; }
      // 0.3s cooldown (skip if exempt)
      const srvExempt = (db.cooldownExempt || []).includes(username);
      if (!srvExempt) {
        const skey = username + ':srv:' + serverId + ':' + channelId;
        const slast = lastGroupTime[skey] || 0;
        if (Date.now() - slast < 300) {
          if (typeof ack === 'function') ack({ error: 'Sending too fast — please slow down', cooldown: 0.3 });
          return;
        }
        lastGroupTime[skey] = Date.now();
      }
      // Per-channel slowmode (owner/managers exempt)
      const slow = Number(s.slowmodeSeconds) || 0;
      if (slow > 0 && !srvExempt && !serverHasPerm(s, username, 'manageMessages')) {
        const slowKey = username + ':slow:' + serverId + ':' + channelId;
        const lastSlow = lastGroupTime[slowKey] || 0;
        const remain = slow * 1000 - (Date.now() - lastSlow);
        if (remain > 0) {
          if (typeof ack === 'function') ack({ error: 'Slowmode is on \u2014 wait ' + Math.ceil(remain / 1000) + 's', cooldown: remain / 1000 });
          return;
        }
        lastGroupTime[slowKey] = Date.now();
      }
      if (!s.messages) s.messages = {};
      if (!Array.isArray(s.messages[channelId])) s.messages[channelId] = [];
      let textStr = String(text || '').slice(0, 5000);
      // @everyone / @here pings: only the owner (or managers) may use them.
      // Non-privileged senders have the mentions neutralised so they can't ping.
      const canPing = (s.owner === username) || serverHasPerm(s, username, 'manageMessages') || serverHasPerm(s, username, 'mentionEveryone');
      let pingType = null;
      if (/@everyone\b/.test(textStr)) pingType = 'everyone';
      else if (/@here\b/.test(textStr)) pingType = 'here';
      if (pingType && !canPing) {
        textStr = textStr.replace(/@everyone\b/g, '@everyone\u200b').replace(/@here\b/g, '@here\u200b');
        pingType = null;
      }
      // Per-user @mentions: notify each mentioned member (except the sender).
      const mentionedUsers = [];
      try {
        const seen = new Set();
        const re = /@([a-zA-Z0-9_.\-]{2,32})/g;
        let mm;
        while ((mm = re.exec(textStr)) !== null) {
          const uname = mm[1];
          if (uname === 'everyone' || uname === 'here') continue;
          if (seen.has(uname)) continue;
          seen.add(uname);
          if ((s.members || []).includes(uname) && uname !== username) mentionedUsers.push(uname);
        }
      } catch (e) {}
      const hasFiles = !!(file || (Array.isArray(files) && files.length));
      // Server chats are NEVER encrypted — every member must be able to read
      // every message and attachment. We always store the plaintext and ignore
      // any e2e envelope a client might still send.
      const base = {
        from: username,
        username,
        displayName: user.displayName,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        // Echo the client-generated id back so the sender can reconcile its
        // optimistic (locally-rendered) copy with the authoritative message.
        clientId: clientId ? String(clientId).slice(0, 80) : null,
      };
      const storedText = textStr;
      // Text and media live in ONE message so the caption renders directly on
      // top of the attachment (no separate follow-up message).
      // Sanitise each attachment to a known shape so clients can't smuggle
      // arbitrary data through, while preserving the optional spoiler flag and
      // cover image ("image on file") chosen in the send modal.
      const cleanFiles = Array.isArray(files) ? files.slice(0, 5).map(f => {
        if (!f || typeof f !== 'object' || !f.url) return null;
        return {
          url: String(f.url).slice(0, 2000),
          name: f.name ? String(f.name).slice(0, 300) : null,
          type: f.type ? String(f.type).slice(0, 120) : null,
          size: Number(f.size) || 0,
          spoiler: !!f.spoiler,
          coverImage: f.coverImage ? String(f.coverImage).slice(0, 2000) : null,
        };
      }).filter(Boolean) : null;
      const msgs = [Object.assign({}, base, { id: genId(), text: storedText, file: file || null, files: cleanFiles, reply: reply || null, spoiler: !!spoiler })];
      const msg = msgs[0];
      msgs.forEach(m => s.messages[channelId].push(m));
      if (s.messages[channelId].length > 2000) s.messages[channelId] = s.messages[channelId].slice(-2000);
      saveDB();
      const emitToMembers = (m) => { for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-message', { serverId: s.id, channelId, message: m }); };
      msgs.forEach(emitToMembers);
      // @everyone / @here ping: send a red notification to every member except the sender.
      if (pingType) {
        const pingPayload = {
          serverId: s.id,
          channelId,
          channelName: ch.name,
          serverName: s.name,
          type: pingType,
          from: username,
          displayName: user.displayName,
          text: textStr.slice(0, 140),
          timestamp: nowISO(),
        };
        for (const mem of (s.members || [])) {
          if (mem === username) continue;
          io.to('user:' + mem).emit('server-ping', pingPayload);
        }
      }
      // Per-user @mention notifications.
      if (mentionedUsers.length) {
        for (const uname of mentionedUsers) {
          io.to('user:' + uname).emit('server-ping', {
            serverId: s.id,
            channelId,
            channelName: ch.name,
            serverName: s.name,
            type: 'mention',
            from: username,
            displayName: user.displayName,
            text: textStr.slice(0, 140),
            timestamp: nowISO(),
          });
        }
      }
      // Reply notification: tell the author of the original message that someone
      // replied to them (unless they replied to themselves).
      if (reply && reply.id && reply.from && reply.from !== username) {
        const replyTarget = String(reply.from).toLowerCase();
        if ((s.members || []).map(x => String(x).toLowerCase()).includes(replyTarget)) {
          io.to('user:' + replyTarget).emit('server-replied-to', {
            serverId: s.id,
            channelId,
            channelName: ch.name,
            serverName: s.name,
            messageId: reply.id,
            replyId: msg.id,
            from: username,
            displayName: user.displayName,
            text: textStr.slice(0, 140),
            timestamp: nowISO(),
          });
        }
      }
      if (typeof ack === 'function') ack({ success: true, message: msg, mediaMessage: msgs.length > 1 ? msgs[1] : null });
    } catch (e) {
      console.error('server-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send server message' });
    }
  });

  // ---- Edit a server message ----
  socket.on('server-edit', ({ serverId, channelId, id, text, e2e, e2eKeys }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const m = ((s.messages || {})[channelId] || []).find(x => x.id === id && x.username === username);
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      // Server chats are never encrypted — always store the plaintext edit.
      m.text = String(text || '').slice(0, 5000);
      delete m.e2e; delete m.e2eKeys;
      m.edited = true; m.editedAt = nowISO();
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-edited', { serverId: s.id, channelId, id: m.id, from: username, text: m.text, e2e: null, e2eKeys: null, edited: true, editedAt: m.editedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed' }); }
  });

  // ---- Delete a server message ----
  socket.on('server-delete', ({ serverId, channelId, id }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      // Owners and members with manageMessages can delete ANY message; everyone
      // else can only delete their own.
      const canManage = serverHasPerm(s, username, 'manageMessages');
      const m = ((s.messages || {})[channelId] || []).find(x => x.id === id && (canManage || x.username === username));
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.deleted = true; m.deletedAt = nowISO(); m.text = ''; m.file = null; m.deletedBy = username;
      // A deleted message can no longer be pinned.
      if (s.pins && Array.isArray(s.pins[channelId])) {
        const pi = s.pins[channelId].indexOf(m.id);
        if (pi >= 0) s.pins[channelId].splice(pi, 1);
      }
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-deleted', { serverId: s.id, channelId, id: m.id, from: username, deletedAt: m.deletedAt });
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-pins-updated', { serverId: s.id, channelId, pins: ((s.pins && s.pins[channelId]) || []).slice() });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed' }); }
  });

  // ---- Server typing indicator ----
  socket.on('server-typing', ({ serverId, channelId, typing }) => {
    const s = findServer(serverId);
    if (!s) return;
    if (!(s.members || []).includes(username)) return;
    const u = db.users[username];
    const dn = u && u.displayName ? u.displayName : username;
    for (const mem of (s.members || [])) {
      if (mem === username) continue;
      io.to('user:' + mem).emit('server-typing', { serverId: s.id, channelId, from: username, displayName: dn, typing: !!typing });
    }
  });

  // ---- Server message reaction ----
  socket.on('server-react', ({ serverId, channelId, id, emoji }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const msg = ((s.messages || {})[channelId] || []).find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
      const e = String(emoji || '').slice(0, 10);
      if (!e) { if (typeof ack === 'function') ack({ error: 'Invalid emoji' }); return; }
      if (!Array.isArray(msg.reactions[e])) msg.reactions[e] = [];
      const idx = msg.reactions[e].indexOf(username);
      if (idx >= 0) { msg.reactions[e].splice(idx, 1); if (msg.reactions[e].length === 0) delete msg.reactions[e]; }
      else {
        const distinct = Object.keys(msg.reactions).filter(k => msg.reactions[k] && msg.reactions[k].length > 0);
        if (distinct.length >= 5 && !msg.reactions[e].length) { if (typeof ack === 'function') ack({ error: 'This message already has 5 different reactions', limit: true, reactions: msg.reactions }); return; }
        msg.reactions[e].push(username);
      }
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-reaction', { serverId: s.id, channelId, id: msg.id, reactions: msg.reactions });
      if (typeof ack === 'function') ack({ success: true, reactions: msg.reactions });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed to react' }); }
  });

  // ---- Pinned messages ----
  // Owners and members with manageMessages can pin/unpin any message in a
  // channel. Pins are stored per-channel as s.pins[channelId] = [messageId,...]
  // and every member can browse the pinned list.
  function emitPinsUpdate(s, channelId) {
    const pins = (s.pins && s.pins[channelId]) || [];
    for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-pins-updated', { serverId: s.id, channelId, pins: pins.slice() });
  }
  socket.on('server-pin', ({ serverId, channelId, id }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      if (!serverHasPerm(s, username, 'manageMessages')) { if (typeof ack === 'function') ack({ error: 'You do not have permission to pin messages' }); return; }
      const msg = ((s.messages || {})[channelId] || []).find(m => m.id === id);
      if (!msg || msg.deleted) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!s.pins || typeof s.pins !== 'object') s.pins = {};
      if (!Array.isArray(s.pins[channelId])) s.pins[channelId] = [];
      if (!s.pins[channelId].includes(id)) s.pins[channelId].push(id);
      saveDB();
      emitPinsUpdate(s, channelId);
      if (typeof ack === 'function') ack({ success: true, pins: s.pins[channelId].slice() });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed to pin' }); }
  });
  socket.on('server-unpin', ({ serverId, channelId, id }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      if (!serverHasPerm(s, username, 'manageMessages')) { if (typeof ack === 'function') ack({ error: 'You do not have permission to unpin messages' }); return; }
      if (s.pins && Array.isArray(s.pins[channelId])) {
        const i = s.pins[channelId].indexOf(id);
        if (i >= 0) s.pins[channelId].splice(i, 1);
        saveDB();
      }
      emitPinsUpdate(s, channelId);
      if (typeof ack === 'function') ack({ success: true, pins: (s.pins && s.pins[channelId] || []).slice() });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed to unpin' }); }
  });
  // Fetch the full pinned message objects for a channel (any member may browse).
  socket.on('server-pins-get', ({ serverId, channelId }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const ids = (s.pins && s.pins[channelId]) || [];
      const all = (s.messages || {})[channelId] || [];
      const pinned = ids.map(id => all.find(m => m.id === id)).filter(m => m && !m.deleted);
      if (typeof ack === 'function') ack({ success: true, pinned, pins: ids.slice() });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed to load pins' }); }
  });

  // ---- Message threads ----
  // stored per-channel on the server as s.threads[channelId][parentId] = { id,
  // parentId, channelId, createdAt, messages: [] }. Thread replies reuse the
  // same message shape as channel messages so the client can render them with
  // the existing message renderer.
  function findThread(s, channelId, parentId) {
    if (!s.threads || !s.threads[channelId]) return null;
    return s.threads[channelId][parentId] || null;
  }
  function threadSummary(t) {
    if (!t) return null;
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const participants = [];
    const seen = new Set();
    for (const m of msgs) {
      if (m && m.from && !seen.has(m.from)) { seen.add(m.from); participants.push(m.from); }
    }
    return {
      id: t.id,
      parentId: t.parentId,
      channelId: t.channelId,
      createdAt: t.createdAt,
      replyCount: msgs.length,
      participants,
      lastReplyAt: last ? last.timestamp : null,
      lastReplyFrom: last ? last.from : null,
      lastReplyText: last ? String(last.text || '').slice(0, 140) : '',
    };
  }
  function emitThreadUpdate(s, channelId, parentId) {
    const t = findThread(s, channelId, parentId);
    const summary = threadSummary(t);
    for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-thread-updated', { serverId: s.id, channelId, parentId, summary });
  }

  // Create (or fetch) a thread for a parent message.
  socket.on('server-thread-create', ({ serverId, channelId, parentId }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const ch = (s.channels || []).find(c => c.id === channelId);
      if (!ch) { if (typeof ack === 'function') ack({ error: 'Channel not found' }); return; }
      if (!canViewChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'This channel is private' }); return; }
      const parent = ((s.messages || {})[channelId] || []).find(m => m.id === parentId);
      if (!parent) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!s.threads) s.threads = {};
      if (!s.threads[channelId]) s.threads[channelId] = {};
      let t = s.threads[channelId][parentId];
      if (!t) {
        t = { id: genId(), parentId, channelId, createdAt: nowISO(), messages: [] };
        s.threads[channelId][parentId] = t;
        saveDB();
        emitThreadUpdate(s, channelId, parentId);
      }
      if (typeof ack === 'function') ack({ success: true, thread: t, summary: threadSummary(t) });
    } catch (e) { console.error('server-thread-create error', e); if (typeof ack === 'function') ack({ error: 'Failed to open thread' }); }
  });

  // Fetch a thread's replies.
  socket.on('server-thread-get', ({ serverId, channelId, parentId }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const ch = (s.channels || []).find(c => c.id === channelId);
      if (!ch) { if (typeof ack === 'function') ack({ error: 'Channel not found' }); return; }
      if (!canViewChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'This channel is private' }); return; }
      const t = findThread(s, channelId, parentId);
      if (typeof ack === 'function') ack({ success: true, thread: t || null, summary: threadSummary(t) });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed to load thread' }); }
  });

  // Post a reply inside a thread.
  socket.on('server-thread-send', ({ serverId, channelId, parentId, text, files, spoiler }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const ch = (s.channels || []).find(c => c.id === channelId);
      if (!ch) { if (typeof ack === 'function') ack({ error: 'Channel not found' }); return; }
      if (!canViewChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'This channel is private' }); return; }
      if (!canChatInChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'Chat is disabled in this channel' }); return; }
      const parent = ((s.messages || {})[channelId] || []).find(m => m.id === parentId);
      if (!parent) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      // 0.3s cooldown (skip if exempt)
      const srvExempt = (db.cooldownExempt || []).includes(username);
      if (!srvExempt) {
        const skey = username + ':thr:' + serverId + ':' + parentId;
        const slast = lastGroupTime[skey] || 0;
        if (Date.now() - slast < 300) { if (typeof ack === 'function') ack({ error: 'Sending too fast \u2014 please slow down', cooldown: 0.3 }); return; }
        lastGroupTime[skey] = Date.now();
      }
      if (!s.threads) s.threads = {};
      if (!s.threads[channelId]) s.threads[channelId] = {};
      let t = s.threads[channelId][parentId];
      if (!t) { t = { id: genId(), parentId, channelId, createdAt: nowISO(), messages: [] }; s.threads[channelId][parentId] = t; }
      let textStr = String(text || '').slice(0, 5000);
      const canPing = (s.owner === username) || serverHasPerm(s, username, 'manageMessages') || serverHasPerm(s, username, 'mentionEveryone');
      if ((/@everyone\b/.test(textStr) || /@here\b/.test(textStr)) && !canPing) {
        textStr = textStr.replace(/@everyone\b/g, '@everyone\u200b').replace(/@here\b/g, '@here\u200b');
      }
      const cleanFiles = Array.isArray(files) ? files.slice(0, 5).map(f => {
        if (!f || typeof f !== 'object' || !f.url) return null;
        return {
          url: String(f.url).slice(0, 2000),
          name: f.name ? String(f.name).slice(0, 300) : null,
          type: f.type ? String(f.type).slice(0, 120) : null,
          size: Number(f.size) || 0,
          spoiler: !!f.spoiler,
          coverImage: f.coverImage ? String(f.coverImage).slice(0, 2000) : null,
        };
      }).filter(Boolean) : null;
      const msg = {
        id: genId(),
        from: username,
        username,
        displayName: user.displayName,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        text: textStr,
        file: null,
        files: cleanFiles,
        reply: null,
        spoiler: !!spoiler,
      };
      t.messages.push(msg);
      if (t.messages.length > 1000) t.messages = t.messages.slice(-1000);
      saveDB();
      const summary = threadSummary(t);
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-thread-reply', { serverId: s.id, channelId, parentId, message: msg, summary });
      // Notify the parent author (unless replying to yourself).
      if (parent.from && parent.from !== username && (s.members || []).map(x => String(x).toLowerCase()).includes(String(parent.from).toLowerCase())) {
        io.to('user:' + String(parent.from).toLowerCase()).emit('server-replied-to', {
          serverId: s.id, channelId, channelName: ch.name, serverName: s.name,
          messageId: parentId, replyId: msg.id, from: username, displayName: user.displayName,
          text: textStr.slice(0, 140), timestamp: nowISO(), thread: true,
        });
      }
      if (typeof ack === 'function') ack({ success: true, message: msg, summary });
    } catch (e) { console.error('server-thread-send error', e); if (typeof ack === 'function') ack({ error: 'Failed to send thread reply' }); }
  });

  // Edit a thread reply.
  socket.on('server-thread-edit', ({ serverId, channelId, parentId, id, text }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const t = findThread(s, channelId, parentId);
      const m = t && (t.messages || []).find(x => x.id === id && x.username === username);
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.text = String(text || '').slice(0, 5000);
      m.edited = true; m.editedAt = nowISO();
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-thread-edited', { serverId: s.id, channelId, parentId, id, text: m.text, edited: true, editedAt: m.editedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed' }); }
  });

  // Delete a thread reply.
  socket.on('server-thread-delete', ({ serverId, channelId, parentId, id }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const canManage = serverHasPerm(s, username, 'manageMessages');
      const t = findThread(s, channelId, parentId);
      const m = t && (t.messages || []).find(x => x.id === id && (canManage || x.username === username));
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.deleted = true; m.deletedAt = nowISO(); m.text = ''; m.file = null; m.files = null; m.deletedBy = username;
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-thread-deleted', { serverId: s.id, channelId, parentId, id, deletedAt: m.deletedAt });
      emitThreadUpdate(s, channelId, parentId);
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed' }); }
  });

  // React to a thread reply.
  socket.on('server-thread-react', ({ serverId, channelId, parentId, id, emoji }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const t = findThread(s, channelId, parentId);
      const msg = t && (t.messages || []).find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
      const e = String(emoji || '').slice(0, 10);
      if (!e) { if (typeof ack === 'function') ack({ error: 'Invalid emoji' }); return; }
      if (!Array.isArray(msg.reactions[e])) msg.reactions[e] = [];
      const idx = msg.reactions[e].indexOf(username);
      if (idx >= 0) { msg.reactions[e].splice(idx, 1); if (msg.reactions[e].length === 0) delete msg.reactions[e]; }
      else msg.reactions[e].push(username);
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-thread-reaction', { serverId: s.id, channelId, parentId, id: msg.id, reactions: msg.reactions });
      if (typeof ack === 'function') ack({ success: true, reactions: msg.reactions });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed to react' }); }
  });

  // ---- Set status ----
  socket.on('set-status', (status) => {
    // 'streaming' is an owner-exclusive status: ONLY @lore (the panel owner)
    // is allowed to set it. Everyone else still SEES it on @lore, but they
    // cannot choose it for themselves. Any non-owner attempting to set
    // 'streaming' is silently ignored (their status is left unchanged).
    if (status === 'streaming' && !isOwnerUser(user)) return;
    if (!['online', 'idle', 'dnd', 'offline', 'streaming'].includes(status)) return;
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
    emitUsersListDebounced();
  });

  // ---- Typing (public) ----
  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('user-typing', { username, typing: !!isTyping });
  });

  // ============================================================
  // ---- Voice channels: real-time WebRTC signaling ----
  // A lightweight in-memory registry of who is currently in each voice
  // channel. The server never touches audio \u2014 it only relays SDP/ICE
  // signaling between peers (mesh) and broadcasts presence + speaking state
  // so every client stays perfectly in sync in real time.
  // ============================================================
  // Hard cap on simultaneous participants in a single voice channel.
  const VOICE_MAX_PEOPLE = 30;
  function voiceRoomKey(serverId, channelId) { return 'voice:' + serverId + ':' + channelId; }
  function voiceRoomPeers(serverId, channelId) {
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room) return [];
    return Array.from(room.values()).map(p => ({ username: p.username, muted: !!p.muted, deafened: !!p.deafened, speaking: !!p.speaking, joinedAt: p.joinedAt }));
  }
  function voiceBroadcastPeers(serverId, channelId) {
    const peers = voiceRoomPeers(serverId, channelId);
    io.to(voiceRoomKey(serverId, channelId)).emit('voice-peers', { serverId, channelId, peers });
  }
  // Authoritative occupancy broadcast to EVERY member of the server (not just
  // people inside the voice room). This is what keeps the sidebar's red count
  // badge accurate for users who are not in the call, and — crucially — clears
  // it the instant the last person leaves. Previously the badge was only
  // updated for people inside the room, so non-participants kept a stale red
  // "1" forever after everyone had left.
  function voiceBroadcastOccupancy(serverId, channelId) {
    const s = findServer(serverId);
    if (!s) return;
    const count = voiceRoomPeers(serverId, channelId).length;
    for (const m of (s.members || [])) {
      io.to('user:' + m).emit('voice-occupancy', { serverId, channelId, count });
    }
  }
  function voiceRemoveUser(serverId, channelId) {
    const key = voiceRoomKey(serverId, channelId);
    const room = voiceRooms.get(key);
    if (!room) return;
    if (room.has(username)) {
      room.delete(username);
      socket.leave(key);
      io.to(key).emit('voice-peer-left', { serverId, channelId, username });
      if (room.size === 0) voiceRooms.delete(key); else voiceBroadcastPeers(serverId, channelId);
      // Always refresh the authoritative count for everyone in the server so
      // the badge drops to 0 (and disappears) when the room empties.
      voiceBroadcastOccupancy(serverId, channelId);
    }
  }
  socket.on('voice-join', ({ serverId, channelId }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      const ch = (s.channels || []).find(c => c.id === channelId);
      if (!ch) { if (typeof ack === 'function') ack({ error: 'Channel not found' }); return; }
      if (ch.type !== 'voice') { if (typeof ack === 'function') ack({ error: 'Not a voice channel' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'You are not a member of this server' }); return; }
      const key = voiceRoomKey(serverId, channelId);
      if (!voiceRooms.has(key)) voiceRooms.set(key, new Map());
      const room = voiceRooms.get(key);
      // Enforce the 30-person cap. Rejoining an existing seat is always allowed.
      if (!room.has(username) && room.size >= VOICE_MAX_PEOPLE) {
        if (typeof ack === 'function') ack({ error: 'This voice channel is full (max ' + VOICE_MAX_PEOPLE + ' people).', full: true });
        return;
      }
      const existing = voiceRoomPeers(serverId, channelId).filter(p => p.username !== username);
      room.set(username, { username, socketId: socket.id, muted: false, deafened: false, speaking: false, joinedAt: Date.now() });
      socket.join(key);
      // Tell the joiner who is already here, and tell everyone else about them.
      if (typeof ack === 'function') ack({ success: true, peers: existing });
      socket.to(key).emit('voice-peer-joined', { serverId, channelId, peer: { username, muted: false, deafened: false, speaking: false, joinedAt: Date.now() } });
      voiceBroadcastPeers(serverId, channelId);
      voiceBroadcastOccupancy(serverId, channelId);
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Could not join voice channel' }); }
  });
  socket.on('voice-leave', ({ serverId, channelId }) => {
    if (serverId && channelId) voiceRemoveUser(serverId, channelId);
  });
  // Relay an SDP offer/answer or ICE candidate to a specific peer.
  socket.on('voice-signal', ({ serverId, channelId, to, data }) => {
    if (!serverId || !channelId || !to || !data) return;
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room || !room.has(username)) return;
    io.to('user:' + String(to).toLowerCase()).emit('voice-signal', { serverId, channelId, from: username, data });
  });
  // Broadcast mute / deafen / speaking state changes instantly.
  socket.on('voice-state', ({ serverId, channelId, muted, deafened, speaking }) => {
    if (!serverId || !channelId) return;
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room || !room.has(username)) return;
    const p = room.get(username);
    if (muted !== undefined) p.muted = !!muted;
    if (deafened !== undefined) p.deafened = !!deafened;
    if (speaking !== undefined) p.speaking = !!speaking;
    io.to(voiceRoomKey(serverId, channelId)).emit('voice-peer-state', { serverId, channelId, username, muted: p.muted, deafened: p.deafened, speaking: p.speaking });
  });
  // Lightweight speaking-only ping (fired on VAD transitions, not every frame).
  socket.on('voice-speaking', ({ serverId, channelId, speaking }) => {
    if (!serverId || !channelId) return;
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room || !room.has(username)) return;
    const p = room.get(username);
    if (p.speaking === !!speaking) return;
    p.speaking = !!speaking;
    io.to(voiceRoomKey(serverId, channelId)).emit('voice-peer-state', { serverId, channelId, username, muted: p.muted, deafened: p.deafened, speaking: p.speaking });
  });
  // Query who is currently in a voice channel (used to render the sidebar).
  socket.on('voice-peers-get', ({ serverId, channelId }, ack) => {
    if (typeof ack === 'function') ack({ peers: voiceRoomPeers(serverId, channelId) });
  });
  // ---- Voice channel text chat ----
  // A lightweight, ephemeral chat that lives beside the voice stage so people
  // can type while they talk. Messages are relayed to everyone currently in the
  // voice room (and echoed back to the sender) and are NOT persisted to the DB.
  socket.on('voice-chat-send', ({ serverId, channelId, text, clientId }, ack) => {
    try {
      if (!serverId || !channelId) { if (typeof ack === 'function') ack({ error: 'Invalid channel' }); return; }
      const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
      if (!room || !room.has(username)) { if (typeof ack === 'function') ack({ error: 'You are not in this voice channel' }); return; }
      const textStr = String(text || '').trim().slice(0, 2000);
      if (!textStr) { if (typeof ack === 'function') ack({ error: 'Message is empty' }); return; }
      // Light 0.3s cooldown to prevent spam (exempt users skip it).
      const exempt = (db.cooldownExempt || []).includes(username);
      if (!exempt) {
        const vkey = username + ':vchat:' + serverId + ':' + channelId;
        const last = lastGroupTime[vkey] || 0;
        if (Date.now() - last < 300) { if (typeof ack === 'function') ack({ error: 'Sending too fast \u2014 please slow down' }); return; }
        lastGroupTime[vkey] = Date.now();
      }
      const msg = {
        id: genId(),
        clientId: clientId ? String(clientId).slice(0, 80) : null,
        serverId, channelId,
        from: username,
        displayName: user.displayName,
        text: textStr,
        timestamp: nowISO(),
      };
      io.to(voiceRoomKey(serverId, channelId)).emit('voice-chat-message', msg);
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to send message' });
    }
  });

  // ---- Activity ----
  // Updates lastSeen in memory immediately, then debounces the expensive
  // save+broadcast so it only fires at most once every few seconds — even if
  // the user is typing continuously. This ensures every user's "Last seen"
  // stamp updates for ALL other clients (not just @lore), while avoiding
  // hammering saveDB / broadcastProfile / emitUsersList on every keystroke.
  socket.on('activity', () => {
    user.lastSeen = nowISO();
    debouncedActivityBroadcast(username);
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
        emitUsersListDebounced();
      }
    }
    socketToUser.delete(socket.id);
    // Remove this user from every voice channel they were in and notify peers.
    for (const [key, room] of voiceRooms) {
      if (room.has(username) && room.get(username).socketId === socket.id) {
        const parts = key.split(':'); // voice:<serverId>:<channelId>
        const serverId = parts[1], channelId = parts.slice(2).join(':');
        room.delete(username);
        io.to(key).emit('voice-peer-left', { serverId, channelId, username });
        if (room.size === 0) voiceRooms.delete(key);
        else io.to(key).emit('voice-peers', { serverId, channelId, peers: Array.from(room.values()).map(p => ({ username: p.username, muted: !!p.muted, deafened: !!p.deafened, speaking: !!p.speaking, joinedAt: p.joinedAt })) });
        // Refresh the authoritative occupancy for the whole server so the
        // sidebar badge clears for everyone when the room empties.
        voiceBroadcastOccupancy(serverId, channelId);
      }
    }
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
    const url = req.originalUrl || '';
    const isAvatar = url.includes('/api/profile') || url.includes('/icon') || url.includes('/banner');
    const limit = isAvatar ? '25MB' : '250MB';
    return res.status(413).json({ error: 'File exceeds the ' + limit + ' size limit.' });
  }
  if (err && err.message && err.message.includes('Multipart')) {
    return res.status(400).json({ error: 'File upload failed: ' + err.message });
  }
  if (err) {
    console.error('Unhandled error:', err.message);
    // This handler catches errors from ANY route (not just uploads), so keep
    // the message generic. Upload-specific cases are handled above.
    return res.status(500).json({ error: 'Server error. Please try again.' });
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
const STARTUP_RESTORE_MAX_FILE = 12 * 1024 * 1024; // 12MB per file (covers large GIFs)
const STARTUP_RESTORE_MAX_TOTAL = 48 * 1024 * 1024; // 48MB total
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
// ---------- Start ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hellobye backend running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  // Kick off the upload restore in the BACKGROUND (after the server is already
  // accepting requests) so it never delays startup. It re-downloads avatars,
  // banners and GIFs that were wiped by the previous deploy from the GitHub
  // backup repo, so images render instantly instead of being fetched
  // on-demand (which caused the visible delay). Memory-safe caps inside
  // restoreUploads() keep it from OOM-ing the free tier.
  setTimeout(() => { restoreUploads().catch(e => console.error('[backup] restoreUploads failed:', e)); }, 1500);
});

// Allow large file uploads (250MB) without timeout issues
server.timeout = 300000;       // 5 minutes for request timeout
server.keepAliveTimeout = 120000; // 2 minutes keep-alive
server.requestTimeout = 300000;   // 5 minutes for full request

// Save on exit
process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
