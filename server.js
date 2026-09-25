
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
let enhanceUpload = null;
try {
  ({ enhanceUpload } = require('./enhance'));
} catch (err) {
  console.error('[server] WARNING: enhancement module failed to load \u2014 uploads will be served unenhanced. Error:', err.message);
}

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
  maxHttpBufferSize: 1e8,
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

const DB_FILE = path.join(DATA_DIR, 'db.json');

const BACKUP_TOKEN = process.env.GITHUB_BACKUP_TOKEN || '';
const BACKUP_REPO = process.env.GITHUB_BACKUP_REPO || '';
const BACKUP_PATH = process.env.GITHUB_BACKUP_PATH || 'data/db.json';
const BACKUP_BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'main';
const BACKUP_ENABLED = !!(BACKUP_TOKEN && BACKUP_REPO);
const UPLOAD_BACKUP_DIR = 'uploads';

const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

const CAPTCHA_SECRET = process.env.CAPTCHA_SECRET || crypto.randomBytes(32).toString('hex');
const captchaUsedNonces = new Map();
const CAPTCHA_NONCE_TTL = 5 * 60 * 1000;
const CAPTCHA_MIN_SOLVE_TIME = 600;

function createCaptchaChallenge() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issued = Date.now();
  const expires = issued + CAPTCHA_NONCE_TTL;
  const payload = JSON.stringify({ nonce, issued, expires });
  const sig = crypto.createHmac('sha256', CAPTCHA_SECRET).update(payload).digest('hex');
  const token = Buffer.from(payload).toString('base64url') + '.' + sig;
  return { challenge: token };
}

function verifyCaptchaToken(token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()); }
  catch (e) { return false; }
  if (!payload || !payload.nonce || !payload.issued || !payload.expires) return false;
  if (Date.now() > payload.expires) return false;
  cleanupCaptchaNonces();
  if (captchaUsedNonces.has(payload.nonce)) return false;
  const expectedSig = crypto.createHmac('sha256', CAPTCHA_SECRET)
    .update(Buffer.from(payloadB64, 'base64url').toString()).digest('hex');
  if (sig !== expectedSig) return false;
  if (Date.now() - payload.issued < CAPTCHA_MIN_SOLVE_TIME) return false;
  captchaUsedNonces.set(payload.nonce, Date.now() + CAPTCHA_NONCE_TTL);
  return true;
}

function cleanupCaptchaNonces() {
  const now = Date.now();
  for (const [nonce, expiry] of captchaUsedNonces) {
    if (now > expiry) captchaUsedNonces.delete(nonce);
  }
}

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

function downloadFileBuffer(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const proto = u.protocol === 'https:' ? require('https') : require('http');
      const req = proto.get(u, { headers: { 'User-Agent': 'hellobye-chat-backup', 'Accept': '*/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadFileBuffer(res.headers.location).then(resolve);
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(60000, () => { req.destroy(); resolve(null); });
    } catch (e) { resolve(null); }
  });
}

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
  } catch (e) {  }
  return null;
}
async function fetchBackupFile(filename) {
  const get = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
  if (get.status !== 200 || !get.data) return null;
  if (get.data.content) {
    const b64 = (get.data.content || '').replace(/\s/g, '');
    return Buffer.from(b64, 'base64');
  }
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
    parsed.__backupSha = r.data.sha;
    return parsed;
  } catch (e) {
    console.error('[backup] Remote restore error:', e);
    return null;
  }
}

let remoteSha = null;

let backupTimer = null;
function scheduleRemoteBackup() {
  if (!BACKUP_ENABLED) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(pushRemoteBackup, 5000);
}

async function pushRemoteBackup() {
  if (!BACKUP_ENABLED) return;
  try {
    let payload = JSON.stringify(db);
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

let db = loadDBLocal();
if (db && db.__backupSha) { remoteSha = db.__backupSha; delete db.__backupSha; }

const displayNameCooldowns = new Map();
const DISPLAY_NAME_COOLDOWN_MS = 5000;
if (!db.welcomeTitle) db.welcomeTitle = 'welcome - to the safe place';
if (!db.welcomeTitleLastChanged) db.welcomeTitleLastChanged = 0;
if (!db.customRoles) db.customRoles = [];
if (!db.roleColors || typeof db.roleColors !== 'object') db.roleColors = {};
if (!db.cooldownExempt) db.cooldownExempt = [];
if (!db.groupChats) db.groupChats = [];
if (!db.encryptionChats || typeof db.encryptionChats !== 'object') db.encryptionChats = {};

if (!db.servers || typeof db.servers !== 'object') db.servers = {};
if (!db.serverInvites || typeof db.serverInvites !== 'object') db.serverInvites = {};

function encPairId(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return [x, y].sort().join('::');
}
function getEncChat(a, b, create) {
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
function areFriends(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  const fx = db.friends[x];
  return !!(fx && Array.isArray(fx.friends) && fx.friends.includes(y));
}
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

(async () => {
  const remote = await loadDBRemote();
  if (remote) {
    const remoteUsers = Object.keys(remote.users || {}).length;
    const localUsers = Object.keys(db.users || {}).length;
    if (remoteUsers > 0) {
      remoteSha = remote.__backupSha || null;
      db = remote;
      delete db.__backupSha;
      if (!db.welcomeTitle) db.welcomeTitle = 'welcome - to the safe place';
      if (!db.welcomeTitleLastChanged) db.welcomeTitleLastChanged = 0;
      if (!db.customRoles) db.customRoles = [];
      if (!db.roleColors || typeof db.roleColors !== 'object') db.roleColors = {};
      if (!db.cooldownExempt) db.cooldownExempt = [];
      if (!db.groupChats) db.groupChats = [];
      if (!db.encryptionChats || typeof db.encryptionChats !== 'object') db.encryptionChats = {};
      if (!db.servers || typeof db.servers !== 'object') db.servers = {};
      if (!db.serverInvites || typeof db.serverInvites !== 'object') db.serverInvites = {};
      try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
      console.log(`[backup] Adopted remote DB as live db (${remoteUsers} users, sha ${remoteSha ? remoteSha.slice(0,7) : '?'}).`);
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
      ensureServerNumericIds();
      ensureAdminManageServer();
      scheduleRemoteBackup();
    } else {
      console.log(`[backup] Remote DB is empty — keeping local db (${localUsers} users).`);
      remoteSha = remote.__backupSha || null;
      if (remoteSha) delete remote.__backupSha;
      scheduleRemoteBackup();
    }
  } else {
    if (Object.keys(db.users || {}).length > 0) {
      console.log('[backup] No remote DB; pushing current local DB to GitHub.');
      scheduleRemoteBackup();
    }
  }
})();

let dbDirty = false;
let dbSaveTimer = null;
const DB_SAVE_DEBOUNCE_MS = 500;

function flushDBSync() {
  dbDirty = false;
  if (dbSaveTimer) { clearTimeout(dbSaveTimer); dbSaveTimer = null; }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('DB save error', e); }
  scheduleRemoteBackup();
}

function saveDB() {
  dbDirty = true;
  if (dbSaveTimer) clearTimeout(dbSaveTimer);
  dbSaveTimer = setTimeout(flushDBSync, DB_SAVE_DEBOUNCE_MS);
}

function saveDBNow() { flushDBSync(); }

setInterval(() => { if (dbDirty) flushDBSync(); }, 15000);

process.on('SIGTERM', () => { if (dbDirty) flushDBSync(); process.exit(0); });
process.on('SIGINT', () => { if (dbDirty) flushDBSync(); process.exit(0); });

purgeExpiredDisabledAccounts();
setInterval(purgeExpiredDisabledAccounts, 60 * 60 * 1000);

const DELETE_WINDOW_MS = 2 * 60 * 1000;
function purgeExpiredDeletedMessages(emitRemovals) {
  let purged = 0;
  const removedIds = [];
  if (Array.isArray(db.messages)) {
    const now = Date.now();
    const kept = [];
    for (const m of db.messages) {
      if (m.deleted) {
        const age = m.deletedAt ? (now - new Date(m.deletedAt).getTime()) : Infinity;
        if (age >= DELETE_WINDOW_MS) { purged++; removedIds.push({ kind: 'message', id: m.id }); continue; }
      }
      kept.push(m);
    }
    db.messages = kept;
  }
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

purgeExpiredDeletedMessages(false);

function genId() { return crypto.randomUUID(); }
function genServerId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = '';
    const bytes = crypto.randomBytes(10);
    for (let i = 0; i < 10; i++) out += String(bytes[i] % 10);
    if (out[0] === '0') out = String((bytes[0] % 9) + 1) + out.slice(1);
    if (!db.servers || !db.servers[out]) return out;
  }
  return String(Date.now()).slice(-10);
}
function hashPass(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function nowISO() { return new Date().toISOString(); }

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

function parseUserAgent(ua) {
  ua = String(ua || '');
  let browser = 'Unknown';
  let os = 'Unknown';
  let deviceType = 'Desktop';
  let deviceModel = '';

  if (/Edg\//.test(ua)) browser = 'Microsoft Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Chromium/.test(ua)) browser = 'Chromium';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/.test(ua)) browser = 'Internet Explorer';

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

  if (deviceType === 'Desktop' && /Mobi|Mobile|iPhone|Android.*Mobile/.test(ua)) deviceType = 'Mobile';
  if (deviceType === 'Desktop' && /iPad|Tablet|Android(?!.*Mobile)/.test(ua)) deviceType = 'Tablet';

  return { browser, os, deviceType, deviceModel };
}

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

function sessionUsername(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  return entry.username || null;
}

function sessionView(sid, entry, currentSid) {
  if (typeof entry === 'string') {
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

function isPrivateOrBlockedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  const v6 = h.split(':');
  if (v6.length >= 2 && !v4) {
    const first = v6[0].toLowerCase();
    if (first === '::1' || h === '::1') return true;
    if (first === 'fe80') return true;
    if (first === 'fc' || first === 'fd' || /^(fc|fd)[0-9a-f]{0,2}$/.test(first)) return true;
    if (first === '') return true;
  }
  return false;
}

function gen2SVCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < 24; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}
function genTrustedDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}
const TWO_SV_REGEN_INTERVAL = 48 * 60 * 60 * 1000;
const TRUSTED_DEVICE_DURATION = 30 * 24 * 60 * 60 * 1000;

function refresh2SVCode(user) {
  if (!user.twoFactorEnabled) return null;
  return user.twoFactorCode || null;
}

function validateTrustedDevice(user, token) {
  if (!token || !user.twoFactorTrustedDevices) return false;
  const hashed = hashPass(token);
  const now = Date.now();
  let valid = false;
  user.twoFactorTrustedDevices = user.twoFactorTrustedDevices.filter(d => {
    if (now >= d.expires) return false;
    if (d.tokenHash === hashed) { valid = true; return true; }
    return true;
  });
  return valid;
}

function addTrustedDevice(user, token) {
  if (!user.twoFactorTrustedDevices) user.twoFactorTrustedDevices = [];
  user.twoFactorTrustedDevices.push({
    tokenHash: hashPass(token),
    expires: Date.now() + TRUSTED_DEVICE_DURATION,
    addedAt: Date.now(),
  });
  if (user.twoFactorTrustedDevices.length > 10) {
    user.twoFactorTrustedDevices = user.twoFactorTrustedDevices.slice(-10);
  }
}
const ADMIN_OWNER_ID = 'ff1db773-9f98-4141-8449-90aeaa68a965';
const ADMIN_OWNER_NAME = 'lore';
const ADMIN_UNLOCK_CODE = 'Xk8vL2pQ9mR4wZ7bY1fH3dCs';
function isOwnerUser(u) {
  if (!u) return false;
  if (u.id && u.id === ADMIN_OWNER_ID) return true;
  if (u.username && String(u.username).toLowerCase().trim() === ADMIN_OWNER_NAME) return true;
  return false;
}
const VALID_ROLES = ['user', 'developer', 'administrator', 'moderator', 'beta_tester'];
const VALID_BADGES = ['moderator', 'developer', 'staff'];
// Default tag colours for the built-in roles (owner/admins can change these
// from the admin panel's "Assign Role" section).
const DEFAULT_ROLE_COLORS = { developer: '#818cf8', administrator: '#eab308', moderator: '#22c55e', beta_tester: '#0ea5e9' };
function roleColorsPublic() {
  if (!db.roleColors || typeof db.roleColors !== 'object') db.roleColors = {};
  const out = {};
  for (const k of Object.keys(DEFAULT_ROLE_COLORS)) {
    out[k] = db.roleColors[k] || DEFAULT_ROLE_COLORS[k];
  }
  return out;
}
const adminUnlockedSessions = new Set();
const WELCOME_TITLE_COOLDOWN = 20000;

const DISABLE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const DISABLED_DISPLAY_NAME = 'deleted user';
const DEFAULT_AVATAR_URL = '/uploads/favicon.jpg';

function isAccountDisabled(u) {
  return !!(u && u.disabled);
}

function purgeExpiredDisabledAccounts() {
  if (!db || !db.users) return 0;
  const now = Date.now();
  let purged = 0;
  for (const un of Object.keys(db.users)) {
    const u = db.users[un];
    if (u && u.disabled && u.scheduledDeletionAt && now >= u.scheduledDeletionAt) {
      delete db.users[un];
      if (db.friends) { delete db.friends[un]; }
      if (db.blocked) { delete db.blocked[un]; }
      if (db.dms) { delete db.dms[un]; }
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
ensureServerNumericIds();

function ensureAdminManageServer() {
  let changed = false;
  for (const s of Object.values(db.servers || {})) {
    if (!s || !Array.isArray(s.roles)) continue;
    for (const r of s.roles) {
      if (!r || !r.permissions) continue;
      const isAdminRole = r.id === 'admin' || (r.system && String(r.name || '').toLowerCase() === 'admin');
      if (isAdminRole && r.permissions.manageServer !== true) {
        r.permissions.manageServer = true;
        changed = true;
      }
    }
  }
  if (changed) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
    scheduleRemoteBackup();
    console.log('[startup] Granted manageServer to built-in Admin roles.');
  }
  return changed;
}
ensureAdminManageServer();

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

function applyProfileHiding(pub, u, viewerUsername) {
  if (!pub || !u || !u.hideProfile) return pub;
  if (viewerUsername && String(viewerUsername).toLowerCase() === String(u.username).toLowerCase()) {
    return pub;
  }
  pub.bio = '';
  pub.pronouns = '';
  pub.location = '';
  pub.website = '';
  pub.hideLastSeen = true;
  pub.profileHidden = true;
  return pub;
}

function publicUser(u, viewerUsername) {
  if (!u) return null;
  if (isAccountDisabled(u)) {
    return {
      username: u.username,
      displayName: DISABLED_DISPLAY_NAME,
      avatar: DEFAULT_AVATAR_URL,
      banner: null,
      avatarDecoration: null,
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
    avatarDecoration: u.avatarDecoration || null,
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
    profileBadge: u.profileBadge || null,
    e2ePublicKey: u.e2ePublicKey || null,
  };
  return applyProfileHiding(pub, u, viewerUsername);
}
function fullUser(u) {
  const pub = publicUser(u, u && u.username);
  pub.email = u.email || '';
  pub.compactMode = !!u.compactMode;
  pub.notificationsEnabled = u.notificationsEnabled !== false;
  pub.messageSounds = u.messageSounds !== false;
  pub.allowGroupAdd = u.allowGroupAdd !== false;
  pub.theme = u.theme || 'dark';
  pub.preferences = u.preferences || {};
  pub.completenessSkipped = !!u.completenessSkipped;
  pub.musicLink = u.musicLink || '';
  pub.isAdmin = isOwnerUser(u);
  pub.cooldownExempt = (db.cooldownExempt || []).includes(u.username);
  if (u.mutedUntil && Date.now() < u.mutedUntil) {
    pub.mutedUntil = u.mutedUntil;
    pub.muteReason = u.muteReason || '';
    pub.mutedBy = u.mutedBy || '';
  } else {
    pub.mutedUntil = 0;
    pub.muteReason = '';
    pub.mutedBy = '';
  }
  pub.twoFactorEnabled = !!u.twoFactorEnabled;
  pub.twoFactorCodeGenerated = u.twoFactorCodeGenerated || 0;
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
  if (typeof entry === 'string') {
    const rec = createSessionRecord(username, req);
    rec.createdAt = rec.createdAt;
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
    if (!entry.lastActive || (now - entry.lastActive) > 30000) {
      entry.lastActive = now;
      saveDB();
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

app.use(express.json({ limit: '260mb' }));
app.use(express.urlencoded({ extended: true, limit: '260mb' }));
app.use((req, res, next) => {
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
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const uploadFallbackLocks = new Set();

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
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}
app.use('/uploads', async (req, res, next) => {
  const filename = decodeURIComponent(req.path.split('/').pop());
  if (!filename || filename === '/') return res.status(404).end();
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).end();
  }
  const localPath = path.join(UPLOAD_DIR, filename);
  if (!localPath.startsWith(UPLOAD_DIR + path.sep) && localPath !== UPLOAD_DIR) {
    return res.status(400).end();
  }
  if (fs.existsSync(localPath)) {
    return express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: uploadSetHeaders })(req, res, next);
  }
  if (!BACKUP_ENABLED) return res.status(404).end();
  const listing = await getBackupListing();
  if (listing && !listing.has(filename)) return res.status(404).end();
  if (uploadFallbackLocks.has(filename)) {
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
      try { fs.writeFileSync(localPath, buf); } catch (e) {  }
      console.log(`[backup] On-demand restored upload ${filename} (${buf.length} bytes).`);
      return express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: uploadSetHeaders })(req, res, next);
    }
    return res.status(404).end();
  } catch (e) {
    console.error(`[backup] On-demand restore error for ${filename}:`, e);
    return res.status(404).end();
  } finally {
    uploadFallbackLocks.delete(filename);
  }
});

const DECORATION_DIR = path.join(__dirname, 'decorations');
app.use('/decorations', express.static(DECORATION_DIR, {
  maxAge: '7d',
  setHeaders: (res) => { res.setHeader('Cache-Control', 'public, max-age=604800'); },
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
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
const upload = multer({ storage, limits: { fileSize: 251 * 1024 * 1024 } });
const avatarUpload = multer({ storage, limits: { fileSize: 26 * 1024 * 1024 } });

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
const badgeUpload = multer({ storage, limits: { fileSize: 11 * 1024 * 1024 } });

app.get('/api/captcha-challenge', (req, res) => {
  const { challenge } = createCaptchaChallenge();
  res.json({ challenge });
});

app.post('/api/register', async (req, res) => {
  const { username, password, displayName, captchaToken } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const captchaOk = verifyCaptchaToken(captchaToken);
  if (!captchaOk) return res.status(403).json({ error: 'Security check failed. Please complete the CAPTCHA and try again.' });
  const un = String(username).toLowerCase().trim();
  if (!/^[a-z0-9_]+$/.test(un)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (un.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (db.users[un]) return res.status(409).json({ error: 'Username already taken' });

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
    plaintextPassword: String(password),
    displayName: (displayName || un).trim(),
    avatar: null,
    banner: null,
    avatarDecoration: null,
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
  db.dms[un] = {};
  const sid = genId();
  db.sessions[sid] = createSessionRecord(un, req);
  saveDBNow();
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
  if (isAccountDisabled(user)) {
    return res.status(200).json({
      accountDisabled: true,
      username: un,
      scheduledDeletionAt: user.scheduledDeletionAt || 0,
      message: 'This account is disabled. Would you like to reinstate it?',
    });
  }
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

  if (user.twoFactorEnabled) {

    let trustedToken = null;
    if (req.headers.cookie) {
      const m = /hellobye_2sv_trust=([^;]+)/.exec(req.headers.cookie);
      if (m) trustedToken = m[1];
    }
    if (trustedToken && validateTrustedDevice(user, trustedToken)) {
      saveDB();
    } else {
      const pendingToken = genId();
      db.pending2SV = db.pending2SV || {};
      db.pending2SV[pendingToken] = {
        username: un,
        expires: Date.now() + 5 * 60 * 1000,
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
  if (user.explicitStatus && user.status === 'offline' && !user.savedStatus) {
    user.status = 'offline';
  } else if (user.explicitStatus && user.savedStatus && user.savedStatus !== 'offline') {
    user.status = user.savedStatus;
  } else if (!user.explicitStatus) {
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  saveDB();
  res.json({ sessionId: sid, user: fullUser(user) });
});

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
  const submittedCode = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const storedCode = (user.twoFactorCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!storedCode || submittedCode !== storedCode) {
    return res.status(401).json({ error: 'Incorrect verification code. Please try again.' });
  }
  delete db.pending2SV[pendingToken];
  const sid = genId();
  db.sessions[sid] = createSessionRecord(pending.username, req);
  if (user.explicitStatus && user.status === 'offline' && !user.savedStatus) {
    user.status = 'offline';
  } else if (user.explicitStatus && user.savedStatus && user.savedStatus !== 'offline') {
    user.status = user.savedStatus;
  } else if (!user.explicitStatus) {
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  let trustToken = null;
  if (trustDevice) {
    trustToken = genTrustedDeviceToken();
    addTrustedDevice(user, trustToken);
  }
  saveDB();
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

app.get('/api/sessions', authMiddleware, (req, res) => {
  const myUsername = req.session.username;
  const currentSid = req.session.sid;
  const sessions = [];
  for (const [sid, entry] of Object.entries(db.sessions)) {
    if (sessionUsername(entry) === myUsername) {
      sessions.push(sessionView(sid, entry, currentSid));
    }
  }
  sessions.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return (b.lastActive || 0) - (a.lastActive || 0);
  });
  res.json({ sessions, currentSessionId: currentSid });
});

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
  try {
    if (typeof io !== 'undefined' && io) {
      io.emit('force-logout', { sessionId: targetSid, reason: 'Your session was ended from another device.' });
    }
  } catch (e) {}
  res.json({ success: true, message: 'Device has been logged out.' });
});

app.get('/api/messages', authMiddleware, (req, res) => {
  res.json({ messages: db.messages.slice(-500) });
});

app.get('/api/search-messages', authMiddleware, (req, res) => {
  try {
    const rawQ = String(req.query.q || '').trim();
    const q = rawQ.toLowerCase();
    const scope = String(req.query.scope || 'chat');
    const results = [];
    if (!q) return res.json({ results: [] });
    const idMatchUser = rawQ.length >= 8
      ? Object.values(db.users).find(u => u.id && u.id.toLowerCase() === q)
      : null;
    const usernameQuery = q.replace(/^@/, '');
    const resolvedUsername = idMatchUser ? idMatchUser.username.toLowerCase() : null;
    if (scope === 'chat' || scope === 'all') {
      db.messages.slice(-1000).forEach(m => {
        if (m.deleted) return;
        if (m.username && m.username.toLowerCase() === usernameQuery) {
          results.push({ type: 'chat', id: m.id, username: m.username, displayName: m.displayName, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null });
          return;
        }
        if (resolvedUsername && m.username && m.username.toLowerCase() === resolvedUsername) {
          results.push({ type: 'chat', id: m.id, username: m.username, displayName: m.displayName, text: m.text, timestamp: m.timestamp, file: m.file ? { name: m.file.name } : null, matchedById: true });
          return;
        }
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
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ results: results.slice(0, 50) });
  } catch (e) {
    console.error('search-messages error', e);
    res.json({ results: [] });
  }
});

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

app.get('/api/users', authMiddleware, (req, res) => {
  const viewer = req.user && req.user.username;
  const list = Object.values(db.users).map(u => publicUser(u, viewer));
  res.json({ users: list });
});

app.get('/api/user/:username', authMiddleware, (req, res) => {
  const u = db.users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (isAccountDisabled(u) && req.user.username !== u.username) {
    return res.status(404).json({ error: 'User not found' });
  }
  const me = req.user;
  const myFriends = db.friends[me.username] || { friends: [], sent: [], received: [] };
  const isMe = (me.username === u.username);
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

// Public avatar lookup — used by the "Welcome back" re-login screen to show the
// user's profile picture before they have an active session. Avatars are
// already shown publicly in member lists, so this exposes no new information.
app.get('/api/avatar/:username', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const un = String(req.params.username || '').toLowerCase();
  const u = db.users[un];
  if (!u || isAccountDisabled(u)) return res.status(404).json({ error: 'User not found' });
  res.json({
    username: u.username,
    displayName: u.displayName || u.username,
    avatar: u.avatar || DEFAULT_AVATAR_URL,
  });
});

app.post('/api/profile', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const u = req.user;
  if (req.file) {
    const type = req.body.type || 'avatar';
    const enhanceOpts = type === 'banner'
      ? { maxStatic: 1536, maxAnimated: 720, skipAnimated: true }
      : { maxStatic: 512, maxAnimated: 480, skipAnimated: true };
    try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), enhanceOpts, 8000); }
    catch (e) { console.error('[profile] enhance error:', e.message); }
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
  const { bio, hideLastSeen, pronouns, panelColor, friendRequestsEnabled, directMessagesEnabled, statusMessage, hideProfile, location, website } = req.body || {};
  if (bio !== undefined) u.bio = String(bio).slice(0, 500);
  if (hideLastSeen !== undefined) u.hideLastSeen = !!hideLastSeen;
  if (pronouns !== undefined) u.pronouns = String(pronouns).slice(0, 50);
  if (location !== undefined) u.location = String(location).slice(0, 60);
  if (website !== undefined) u.website = String(website).slice(0, 120);
  if (friendRequestsEnabled !== undefined) u.friendRequestsEnabled = friendRequestsEnabled !== false;
  if (directMessagesEnabled !== undefined) u.directMessagesEnabled = directMessagesEnabled !== false;
  if (hideProfile !== undefined) u.hideProfile = hideProfile !== false;
  if (statusMessage !== undefined) {
    u.statusMessage = String(statusMessage).trim().slice(0, 25);
  }
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

app.post('/api/profile/revert-image', authMiddleware, (req, res) => {
  const { avatar, banner } = req.body || {};
  const safePath = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const s = String(val).split('?')[0];
    if (!s.startsWith('/uploads/')) return undefined;
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

const AVATAR_DECORATIONS = ['cat-ears'];
app.post('/api/profile/decoration', authMiddleware, (req, res) => {
  const u = req.user;
  const isLore = String(u.username || '').toLowerCase().trim() === 'lore';
  if (!isLore) {
    return res.status(403).json({ error: 'Avatar decorations are exclusive to @lore.' });
  }
  const raw = (req.body || {}).decoration;
  let val = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    val = String(raw);
    if (!AVATAR_DECORATIONS.includes(val)) {
      return res.status(400).json({ error: 'Unknown decoration.' });
    }
  }
  u.avatarDecoration = val;
  saveDB();
  broadcastProfile(u.username);
  emitUsersList();
  res.json({ success: true, avatarDecoration: u.avatarDecoration });
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const absPath = path.join(UPLOAD_DIR, req.file.filename);
  let isImage = /^image\//.test(req.file.mimetype || '');
  if (isImage) {
    try { await enhanceWithTimeout(absPath, { skipAnimated: true, maxStatic: 2048 }, 4000); }
    catch (e) { console.error('[upload] enhance error:', e.message); }
  }
  let finalSize = req.file.size;
  try { finalSize = fs.statSync(absPath).size; } catch (e) {}
  const url = '/uploads/' + req.file.filename;
  let peaks = null;
  try {
    if (req.body && req.body.peaks) {
      const arr = JSON.parse(req.body.peaks);
      if (Array.isArray(arr) && arr.length) peaks = arr.slice(0, 64).map(x => Math.max(0, Math.min(1, Number(x) || 0)));
    }
  } catch (e) {}
  backupUploadFile(req.file.filename);
  res.json({
    file: {
      url,
      name: req.file.originalname,
      size: finalSize,
      type: req.file.mimetype,
      mimetype: req.file.mimetype,
      enhanced: isImage,
      peaks,
    },
  });
});

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
      const results = r.data.data.map(g => {
        const img = g.images || {};
        return {
          id: g.id,
          title: g.title || '',
          preview: (img.fixed_height_small && img.fixed_height_small.url) ||
                   (img.fixed_height && img.fixed_height.url) ||
                   (img.downsized && img.downsized.url) || '',
          previewWebp: (img.fixed_height_small && img.fixed_height_small.webp) || '',
          full: (img.original && img.original.url) ||
                (img.downsized_large && img.downsized_large.url) ||
                (img.fixed_height && img.fixed_height.url) || '',
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

app.post('/api/gif/import', authMiddleware, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid URL' });
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
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        cleanup();
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
    setTimeout(() => { if (!res.headersSent) { aborted = true; request.destroy(); fileStream.destroy(); cleanup(); res.status(504).json({ error: 'GIF fetch timed out' }); } }, 30000);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to import GIF: ' + e.message });
  }
});

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

function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  const aBlocksB = (db.blocked[a] || []).includes(b);
  const bBlocksA = (db.blocked[b] || []).includes(a);
  return aBlocksB || bBlocksA;
}
app.get('/api/blocked', authMiddleware, (req, res) => {
  const blocked = db.blocked[req.user.username] || [];
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

app.get('/api/dm-conversations', authMiddleware, (req, res) => {
  const myDMs = db.dms[req.user.username] || {};
  const closedDMs = db.users[req.user.username].closedDMs || [];
  const conversations = [];
  for (const [other, msgs] of Object.entries(myDMs)) {
    if (!msgs.length) continue;
    if (closedDMs.includes(other)) continue;
    const last = msgs[msgs.length - 1];
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

function getUserDMPins(username, other) {
  const u = db.users[username];
  if (!u) return [];
  if (!u.dmPins) u.dmPins = {};
  if (!Array.isArray(u.dmPins[other])) u.dmPins[other] = [];
  return u.dmPins[other];
}

app.get('/api/dms/:username/pins', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  const pins = getUserDMPins(req.user.username, other);
  const myDMs = db.dms[req.user.username] || {};
  const msgs = myDMs[other] || [];
  const out = [];
  pins.forEach(id => {
    const m = msgs.find(x => x.id === id);
    if (m && !m.deleted) out.push(m);
  });
  res.json({ pins: out });
});

app.post('/api/dms/:username/pin', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  const messageId = String((req.body && req.body.messageId) || '').trim();
  if (!messageId) return res.status(400).json({ error: 'Message id required' });
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  const myDMs = db.dms[req.user.username] || {};
  const msgs = myDMs[other] || [];
  const m = msgs.find(x => x.id === messageId);
  if (!m) return res.status(404).json({ error: 'Message not found' });
  const pins = getUserDMPins(req.user.username, other);
  if (!pins.includes(messageId)) pins.push(messageId);
  saveDB();
  res.json({ success: true, pinned: true });
});

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

app.get('/api/dms/:username/search', authMiddleware, (req, res) => {
  const other = req.params.username.toLowerCase();
  const rawQ = String(req.query.q || '').trim();
  const q = rawQ.toLowerCase();
  if (!q) return res.json({ results: [] });
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  const myDMs = db.dms[req.user.username] || {};
  const msgs = (myDMs[other] || []).slice(-1000);
  const results = [];
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

app.get('/api/encryption/status/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, false);
  res.json({ status: publicEncChat(rec, me) });
});

app.post('/api/encryption/invite/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (other === me) return res.status(400).json({ error: 'Cannot start an encryption chat with yourself' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  const rec = getEncChat(me, other, true);
  rec.state = 'invited';
  rec.invites = { [me]: 'pending', [other]: 'pending' };
  rec.updatedAt = nowISO();
  saveDB();
  const payload = { pairId: encPairId(me, other), from: me, other, status: publicEncChat(rec, me) };
  io.to('user:' + me).emit('encryption-invite', { ...payload, status: publicEncChat(rec, me) });
  io.to('user:' + other).emit('encryption-invite', { ...payload, status: publicEncChat(rec, other) });
  res.json({ success: true, status: publicEncChat(rec, me) });
});

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
    const someoneDeletedKey = !!(rec.keyDeleted && (rec.keyDeleted[me] || rec.keyDeleted[other]));
    let key = null;
    if (!rec.keyHash) {
      key = generateEncKey();
      rec.keyHash = hashEncKey(key);
      rec.messages = [];
    } else if (someoneDeletedKey) {
      key = null;
    } else {
      key = generateEncKey();
      rec.keyHash = hashEncKey(key);
      rec.messages = [];
    }
    rec.keyIssued = { [me]: true, [other]: true };
    rec.keyDeleted = {};
    saveDB();
    if (key) {
      io.to('user:' + me).emit('encryption-key', { pairId: encPairId(me, other), other, key });
      io.to('user:' + other).emit('encryption-key', { pairId: encPairId(me, other), other: me, key });
    } else {
      io.to('user:' + me).emit('encryption-key-existing', { pairId: encPairId(me, other), other });
      io.to('user:' + other).emit('encryption-key-existing', { pairId: encPairId(me, other), other: me });
    }
    return res.json({ success: true, state: 'active', key: key || null, reused: !key });
  }

  saveDB();
  io.to('user:' + me).emit('encryption-invite-update', { pairId: encPairId(me, other), other, status: publicEncChat(rec, me) });
  io.to('user:' + other).emit('encryption-invite-update', { pairId: encPairId(me, other), other: me, status: publicEncChat(rec, other) });
  res.json({ success: true, state: rec.state, status: publicEncChat(rec, me) });
});

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
  res.json({ success: true, messages: rec.messages || [], pairId: encPairId(me, other) });
});

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
  io.to('user:' + other).emit('encryption-key-deleted', { pairId: encPairId(me, other), other: me });
  res.json({ success: true });
});

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

app.post('/api/encryption/reset-respond/:username', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = String(req.params.username || '').toLowerCase();
  const action = String((req.body && req.body.action) || '').toLowerCase();
  if (!db.users[other]) return res.status(404).json({ error: 'User not found' });
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You must be friends to use encryption chat' });
  if (action !== 'accept' && action !== 'decline') return res.status(400).json({ error: 'Invalid action' });
  const rec = getEncChat(me, other, false);
  if (!rec || rec.state !== 'resetting') return res.status(400).json({ error: 'No pending key reset request' });
  if (rec.resetBy === me) return res.status(400).json({ error: 'You cannot respond to your own reset request' });

  if (action === 'decline') {
    rec.state = 'active';
    rec.resetVotes = {};
    rec.resetBy = null;
    rec.updatedAt = nowISO();
    saveDB();
    io.to('user:' + me).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other, reason: 'declined', by: me });
    io.to('user:' + other).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other: me, reason: 'declined', by: me });
    return res.json({ success: true, reason: 'declined' });
  }

  const newKey = generateEncKey();
  rec.keyHash = hashEncKey(newKey);
  rec.messages = [];
  rec.keyIssued = { [me]: true, [other]: true };
  rec.keyDeleted = {};
  rec.state = 'active';
  rec.resetVotes = {};
  rec.resetBy = null;
  rec.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other, reason: 'accepted', key: newKey, by: me });
  io.to('user:' + other).emit('encryption-reset-resolved', { pairId: encPairId(me, other), other: me, reason: 'accepted', key: newKey, by: me });
  res.json({ success: true, reason: 'accepted', key: newKey });
});

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
    rec.state = 'active';
    rec.deleteVotes = {};
    rec.deleteBy = null;
    rec.updatedAt = nowISO();
    saveDB();
    io.to('user:' + me).emit('encryption-delete-resolved', { pairId: encPairId(me, other), other, reason: 'declined', by: me });
    io.to('user:' + other).emit('encryption-delete-resolved', { pairId: encPairId(me, other), other: me, reason: 'declined', by: me });
    return res.json({ success: true, reason: 'declined' });
  }

  rec.keyHash = null;
  rec.messages = [];
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

function findServer(id) {
  if (!db.servers || typeof db.servers !== 'object') db.servers = {};
  return db.servers[id] || null;
}
function genInviteCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
const INVITE_CODE_RE = /^[a-z0-9]{4,10}$/;
const RESERVED_INVITE_CODES = new Set([
  'api', 'uploads', 'upload', 'socket', 'socket.io', 'servers', 'server',
  'index', 'admin', 'login', 'logout', 'signup', 'signin', 'register',
  'assets', 'fonts', 'font', 'static', 'data', 'invite', 'invites',
  'discover', 'settings', 'app', 'www', 'health', 'version', 'favicon',
  'robots', 'manifest', 'service-worker', 'sw', 'null', 'undefined',
  'true', 'false', 'test', 'demo', 'about', 'help', 'support', 'terms',
  'privacy', 'home', 'main', 'public', 'private', 'user', 'users', 'me',
]);
function validateCustomInviteCode(raw) {
  const code = String(raw || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!code) return { ok: false, error: 'Enter a custom link' };
  if (code.length < 4) return { ok: false, error: 'Custom links must be at least 4 characters' };
  if (code.length > 10) return { ok: false, error: 'Custom links must be at most 10 characters' };
  if (!INVITE_CODE_RE.test(code)) return { ok: false, error: 'Use only lowercase letters and numbers (no symbols or emojis)' };
  if (RESERVED_INVITE_CODES.has(code)) return { ok: false, error: 'That link is reserved — try another' };
  return { ok: true, code };
}
function defaultServerRoles(owner) {
  return [
    { id: 'owner', name: 'Owner', color: '#f59e0b', badge: '', order: 0, system: true,
      permissions: allPermissions() },
    { id: 'admin', name: 'Admin', color: '#ef4444', badge: '', order: 1, system: true,
      permissions: Object.assign(allPermissions(), { administrator: false, manageServer: true }) },
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
function normalizePermissions(input, fallback) {
  const src = (input && typeof input === 'object') ? input : {};
  const base = (fallback && typeof fallback === 'object') ? fallback : {};
  const out = {};
  for (const k of PERMISSION_KEYS) {
    if (src[k] !== undefined) out[k] = !!src[k];
    else out[k] = !!base[k];
  }
  if (out.administrator) for (const k of PERMISSION_KEYS) out[k] = true;
  return out;
}
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
    const custom = roleIds.some(rid => {
      const r = (server.roles || []).find(x => x.id === rid);
      return r && !r.system;
    });
    return custom;
  }
  return true;
}
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
    isPrivate: !!s.isPrivate,
    joinRequestCount: (s.joinRequests || []).length,
  };
  if (isOwner || serverHasPerm(s, viewer, 'ban') || serverHasPerm(s, viewer, 'kick') || serverHasPerm(s, viewer, 'manageServer')) {
    base.bans = (s.bans || []).map(b => ({ username: b.username, reason: b.reason || null, by: b.by || null, at: b.at || null }));
    base.joinRequests = (s.joinRequests || []).map(r => ({ username: r.username, at: r.at || null, note: r.note || null }));
  }
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
    custom: invite ? !!invite.custom : false,
    expiresAt: invite ? (invite.expiresAt || 0) : 0,
  };
}
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
function isInviteCodeTaken(code) {
  const found = findInviteByCode(code);
  return !!(found && !found.expired);
}
function pruneExpiredInvites() {
  const now = Date.now();
  let changed = false;
  for (const s of Object.values(db.servers || {})) {
    if (!Array.isArray(s.invites)) continue;
    const before = s.invites.length;
    s.invites = s.invites.filter(i => !i.expiresAt || i.expiresAt > now);
    if (s.invites.length !== before) changed = true;
  }
  return changed;
}
function ensureServerMemberProfile(server, username) {
  if (!server.memberProfiles) server.memberProfiles = {};
  const un = String(username || '').toLowerCase();
  if (!server.memberProfiles[un]) {
    server.memberProfiles[un] = { nickname: null, avatar: null, banner: null, bio: '', roleIds: ['member'], joinedAt: nowISO(), avatarScale: 100, bannerScale: 100 };
  }
  return server.memberProfiles[un];
}
function emitServerUpdate(server) {
  if (!server) return;
  for (const m of (server.members || [])) {
    io.to('user:' + m).emit('server-updated', { server: publicServer(server, m) });
  }
}
const AUDIT_LOG_MAX = 500;
function logAudit(server, entry) {
  if (!server || !entry) return;
  if (!Array.isArray(server.auditLog)) server.auditLog = [];
  const actor = String(entry.actor || '').toLowerCase();
  const actorUser = db.users[actor];
  const rec = {
    id: genId(),
    type: String(entry.type || 'other').slice(0, 40),
    actor,
    actorName: (actorUser && actorUser.displayName) ? actorUser.displayName : (entry.actorName || actor),
    target: entry.target ? String(entry.target).toLowerCase() : null,
    targetName: entry.targetName || null,
    channelId: entry.channelId || null,
    channelName: entry.channelName || null,
    detail: entry.detail ? String(entry.detail).slice(0, 300) : null,
    timestamp: nowISO(),
  };
  server.auditLog.unshift(rec);
  if (server.auditLog.length > AUDIT_LOG_MAX) server.auditLog.length = AUDIT_LOG_MAX;
}
function canViewAuditLog(server, username) {
  if (!server) return false;
  if (server.owner === String(username || '').toLowerCase()) return true;
  return serverHasPerm(server, username, 'viewAuditLog');
}
function serverBanOf(server, username) {
  if (!server || !Array.isArray(server.bans)) return null;
  const un = String(username || '').toLowerCase();
  return server.bans.find(b => b.username === un) || null;
}

app.post('/api/servers/create', authMiddleware, (req, res) => {
  const { name, bio, accentColor, serverType, isPublic, icon, banner } = req.body || {};
  const serverName = String(name || '').trim().slice(0, 40);
  if (!serverName) return res.status(400).json({ error: 'Server name is required' });
  const owner = req.user.username;
  const id = genId();
  const generalId = genId();
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(accentColor || '')) ? accentColor : '#5865f2';
  const type = ['community','friends','gaming','study','club','other'].includes(String(serverType || '')) ? serverType : 'community';
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

app.get('/api/servers', authMiddleware, (req, res) => {
  const me = req.user.username;
  const list = Object.values(db.servers || {}).filter(s => (s.members || []).includes(me));
  list.sort((a, b) => {
    const ao = (a.serverOrder && typeof a.serverOrder[me] === 'number') ? a.serverOrder[me] : 1e9;
    const bo = (b.serverOrder && typeof b.serverOrder[me] === 'number') ? b.serverOrder[me] : 1e9;
    if (ao !== bo) return ao - bo;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
  res.json({ servers: list.map(s => publicServer(s, me)) });
});

app.get('/api/servers/discover', authMiddleware, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = req.user.username;
  let list = Object.values(db.servers || {}).filter(s => !!s.discoverable);
  if (q) list = list.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.bio || '').toLowerCase().includes(q) ||
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

app.get('/api/servers/:id', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) {
    return res.json({ server: publicServer(s, me), preview: true });
  }
  res.json({ server: publicServer(s, me) });
});

app.get('/api/servers/:id/channels/:channelId/messages', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) return res.status(403).json({ error: 'You are not a member of this server' });
  const ch = (s.channels || []).find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!canViewChannel(s, me, ch)) return res.status(403).json({ error: 'This channel is private' });
  const msgs = ((s.messages || {})[ch.id] || []).slice(-1000);
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

app.post('/api/servers/:id/settings', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageServer')) return res.status(403).json({ error: 'You do not have permission to manage this server' });
  const { name, bio, systemChannelId, defaultNotifications, verificationLevel, welcomeMessage, discoverable, slowmodeSeconds, accentColor, effect, iconScale, bannerScale, chatBackground, chatBackgroundScale, chatBackgroundOpacity, isPrivate } = req.body || {};
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
  if (isPrivate !== undefined) {
    const wasPrivate = !!s.isPrivate;
    s.isPrivate = !!isPrivate;
    if (s.isPrivate) s.discoverable = false;
    if (wasPrivate !== s.isPrivate) {
      logAudit(s, { type: 'server_privacy', actor: req.user.username, detail: s.isPrivate ? 'Server set to private (join requests required)' : 'Server set to public' });
    }
  }
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
    s.effect = ['none', 'glow', 'gradient', 'aurora', 'neon', 'pulse', 'grid', 'spotlight', 'scanlines', 'halo', 'waves', 'beam', 'ripple', 'frost', 'ember'].includes(e) ? e : 'none';
  }
  if (iconScale !== undefined) {
    const v = Number(iconScale);
    s.iconScale = (Number.isFinite(v) && v >= 50 && v <= 150) ? Math.round(v) : 100;
  }
  if (bannerScale !== undefined) {
    const v = Number(bannerScale);
    s.bannerScale = (Number.isFinite(v) && v >= 50 && v <= 300) ? Math.round(v) : 100;
  }
  if (chatBackground !== undefined) {
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

app.post('/api/servers/reorder', authMiddleware, (req, res) => {
  const me = req.user.username;
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'An order array is required' });
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

app.post('/api/servers/:id/chat-background', authMiddleware, avatarUpload.single('image'), async (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageServer')) return res.status(403).json({ error: 'You do not have permission to change the server chat background' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
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
  logAudit(s, { type: 'channel_create', actor: req.user.username, channelId: ch.id, channelName: ch.name, detail: 'Created ' + chType + ' channel #' + ch.name });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, channel: ch, server: publicServer(s, req.user.username) });
});

app.post('/api/servers/:id/channels/reorder', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'An order array is required' });
  const byId = new Map((s.channels || []).map(c => [c.id, c]));
  const next = [];
  for (const id of order) { const c = byId.get(id); if (c) { next.push(c); byId.delete(id); } }
  for (const c of byId.values()) next.push(c);
  s.channels = next;
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

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

app.delete('/api/servers/:id/channels/:channelId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage channels' });
  if ((s.channels || []).length <= 1) return res.status(400).json({ error: 'A server must have at least one channel' });
  const ch = (s.channels || []).find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  s.channels = s.channels.filter(c => c.id !== ch.id);
  if (s.messages) delete s.messages[ch.id];
  logAudit(s, { type: 'channel_delete', actor: req.user.username, channelId: ch.id, channelName: ch.name, detail: 'Deleted channel #' + ch.name });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

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
  logAudit(s, { type: 'role_create', actor: req.user.username, detail: 'Created role "' + rn + '"' });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, role, server: publicServer(s, req.user.username) });
});

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

app.delete('/api/servers/:id/roles/:roleId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const role = (s.roles || []).find(r => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.system) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
  s.roles = s.roles.filter(r => r.id !== role.id);
  for (const un of Object.keys(s.memberProfiles || {})) {
    const p = s.memberProfiles[un];
    if (Array.isArray(p.roleIds)) p.roleIds = p.roleIds.filter(id => id !== role.id);
  }
  logAudit(s, { type: 'role_delete', actor: req.user.username, detail: 'Deleted role "' + role.name + '"' });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

app.post('/api/servers/:id/members/:username/roles', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageRoles')) return res.status(403).json({ error: 'You do not have permission to manage roles' });
  const target = String(req.params.username || '').toLowerCase();
  if (!(s.members || []).includes(target)) return res.status(400).json({ error: 'That user is not a member of this server' });
  const { roleId, action, roleIds } = req.body || {};
  const prof = ensureServerMemberProfile(s, target);
  if (!Array.isArray(prof.roleIds)) prof.roleIds = [];
  if (Array.isArray(roleIds)) {
    const valid = new Set((s.roles || []).map(r => r.id));
    let next = roleIds.filter(id => valid.has(id));
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

app.post('/api/servers/:id/members/:username/kick', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'kick')) return res.status(403).json({ error: 'You do not have permission to kick members' });
  const target = String(req.params.username || '').toLowerCase();
  if (target === s.owner) return res.status(400).json({ error: 'You cannot kick the server owner' });
  if (!(s.members || []).includes(target)) return res.status(400).json({ error: 'That user is not a member of this server' });
  s.members = s.members.filter(m => m !== target);
  if (s.memberProfiles) delete s.memberProfiles[target];
  logAudit(s, { type: 'member_kick', actor: req.user.username, target, targetName: (db.users[target] && db.users[target].displayName) || target, detail: 'Kicked from the server' });
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + target).emit('server-removed', { id: s.id });
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

app.post('/api/servers/:id/members/:username/ban', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'ban')) return res.status(403).json({ error: 'You do not have permission to ban members' });
  const target = String(req.params.username || '').toLowerCase();
  if (target === s.owner) return res.status(400).json({ error: 'You cannot ban the server owner' });
  if (!db.users[target]) return res.status(400).json({ error: 'That user does not exist' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 200) || null;
  if (!Array.isArray(s.bans)) s.bans = [];
  if (!s.bans.some(b => b.username === target)) {
    s.bans.push({ username: target, reason, by: req.user.username, at: nowISO() });
  }
  const wasMember = (s.members || []).includes(target);
  s.members = (s.members || []).filter(m => m !== target);
  if (s.memberProfiles) delete s.memberProfiles[target];
  s.joinRequests = (s.joinRequests || []).filter(r => r.username !== target);
  logAudit(s, { type: 'member_ban', actor: req.user.username, target, targetName: (db.users[target] && db.users[target].displayName) || target, detail: reason ? ('Banned: ' + reason) : 'Banned from the server' });
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + target).emit('server-removed', { id: s.id });
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});
app.post('/api/servers/:id/members/:username/unban', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'ban')) return res.status(403).json({ error: 'You do not have permission to manage bans' });
  const target = String(req.params.username || '').toLowerCase();
  const before = (s.bans || []).length;
  s.bans = (s.bans || []).filter(b => b.username !== target);
  if (s.bans.length !== before) {
    logAudit(s, { type: 'member_unban', actor: req.user.username, target, targetName: (db.users[target] && db.users[target].displayName) || target, detail: 'Ban lifted' });
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

app.get('/api/servers/:id/audit-log', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!canViewAuditLog(s, req.user.username)) return res.status(403).json({ error: 'You do not have permission to view the audit log' });
  const type = String(req.query.type || '').trim();
  let entries = Array.isArray(s.auditLog) ? s.auditLog.slice() : [];
  if (type && type !== 'all') entries = entries.filter(e => e.type === type);
  res.json({ entries: entries.slice(0, 300) });
});

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
    prof.avatarScale = (Number.isFinite(v) && v >= 50 && v <= 150) ? Math.round(v) : 100;
  }
  if (bannerScale !== undefined) {
    const v = Number(bannerScale);
    prof.bannerScale = (Number.isFinite(v) && v >= 50 && v <= 150) ? Math.round(v) : 100;
  }
  if (req.file) {
    try {
      try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { maxStatic: 512, maxAnimated: 480, skipAnimated: true }, 8000); }
      catch (e) { console.error('[server-profile] enhance error:', e.message); }
      const fileUrl = '/uploads/' + req.file.filename + '?t=' + Date.now();
      if (field === 'banner') {
        prof.banner = fileUrl;
      } else {
        prof.avatar = fileUrl;
      }
      backupUploadFile(req.file.filename);
    } catch (e) { console.error('server profile upload error', e); }
  }
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, me) });
});

app.post('/api/servers/:id/leave', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if (!(s.members || []).includes(me)) return res.status(400).json({ error: 'You are not in this server' });
  if (s.owner === me) return res.status(400).json({ error: 'As the owner you must transfer ownership or delete the server instead of leaving' });
  s.members = s.members.filter(m => m !== me);
  if (s.memberProfiles) delete s.memberProfiles[me];
  logAudit(s, { type: 'member_leave', actor: me, target: me, targetName: (db.users[me] && db.users[me].displayName) || me, detail: 'Left the server' });
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + me).emit('server-removed', { id: s.id });
  emitServerUpdate(s);
  res.json({ success: true });
});

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

app.post('/api/servers/:id/invites', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'invite')) return res.status(403).json({ error: 'You do not have permission to create invites' });
  const { expiresIn, code: customCode } = req.body || {};
  const mins = Number(expiresIn);
  const expiresAt = (!mins || mins <= 0) ? 0 : Date.now() + mins * 60 * 1000;
  let code;
  if (customCode != null && String(customCode).trim() !== '') {
    if (s.owner !== req.user.username) return res.status(403).json({ error: 'Only the server owner can create a custom invite link' });
    const v = validateCustomInviteCode(customCode);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (pruneExpiredInvites()) saveDB();
    const taken = findInviteByCode(v.code);
    if (taken && !taken.expired) {
      if (taken.server.id === s.id) {
        taken.invite.expiresAt = expiresAt;
        taken.invite.createdBy = req.user.username;
        taken.invite.custom = true;
        s.updatedAt = nowISO();
        saveDB();
        return res.json({ success: true, invite: taken.invite, url: '/servers.html?invite=' + v.code });
      }
      return res.status(409).json({ error: 'That link is already taken — try another' });
    }
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

app.get('/api/servers/:id/invites/check', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'invite')) return res.status(403).json({ error: 'You do not have permission to manage invites' });
  const v = validateCustomInviteCode(req.query.code);
  if (!v.ok) return res.json({ available: false, error: v.error });
  if (pruneExpiredInvites()) saveDB();
  if (isInviteCodeTaken(v.code)) return res.json({ available: false, error: 'That link is already taken — try another' });
  res.json({ available: true, code: v.code });
});

app.get('/api/servers/:id/invites', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!(s.members || []).includes(req.user.username)) return res.status(403).json({ error: 'You are not a member of this server' });
  const now = Date.now();
  const invites = (s.invites || []).filter(i => !i.expiresAt || i.expiresAt > now);
  res.json({ invites });
});

app.delete('/api/servers/:id/invites/:code', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (s.owner !== req.user.username) return res.status(403).json({ error: 'Only the server owner can revoke invites' });
  s.invites = (s.invites || []).filter(i => i.code !== req.params.code);
  s.updatedAt = nowISO();
  saveDB();
  res.json({ success: true });
});

function findWebhook(webhookId) {
  for (const s of Object.values(db.servers || {})) {
    const wh = (s.webhooks || []).find(w => w.id === webhookId);
    if (wh) return { server: s, webhook: wh };
  }
  return null;
}
function publicWebhook(w) {
  return { id: w.id, channelId: w.channelId, name: w.name, avatar: w.avatar || null, token: w.token, createdBy: w.createdBy || null, createdAt: w.createdAt || null };
}
app.get('/api/servers/:id/channels/:channelId/webhooks', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage webhooks' });
  const list = (s.webhooks || []).filter(w => w.channelId === req.params.channelId).map(publicWebhook);
  res.json({ webhooks: list });
});
app.post('/api/servers/:id/channels/:channelId/webhooks', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage webhooks' });
  const ch = (s.channels || []).find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  const name = String((req.body || {}).name || '').trim().slice(0, 80) || 'Webhook';
  let avatar = (req.body || {}).avatar;
  avatar = (typeof avatar === 'string' && avatar.startsWith('data:image/')) ? saveDataUrlImage(avatar, 4 * 1024 * 1024)
    : (typeof avatar === 'string' && /^https?:\/\//.test(avatar) ? avatar.slice(0, 2000) : null);
  const wh = { id: genId(), channelId: ch.id, name, avatar, token: genId().replace(/-/g, ''), createdBy: req.user.username, createdAt: nowISO() };
  if (!s.webhooks) s.webhooks = [];
  s.webhooks.push(wh);
  s.updatedAt = nowISO();
  saveDB();
  res.json({ success: true, webhook: publicWebhook(wh) });
});
app.delete('/api/servers/:id/webhooks/:webhookId', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!serverHasPerm(s, req.user.username, 'manageChannels')) return res.status(403).json({ error: 'You do not have permission to manage webhooks' });
  const before = (s.webhooks || []).length;
  s.webhooks = (s.webhooks || []).filter(w => w.id !== req.params.webhookId);
  if (s.webhooks.length === before) return res.status(404).json({ error: 'Webhook not found' });
  s.updatedAt = nowISO();
  saveDB();
  res.json({ success: true });
});
app.post('/api/webhooks/:webhookId/:token', (req, res) => {
  const found = findWebhook(req.params.webhookId);
  if (!found) return res.status(404).json({ error: 'Unknown webhook' });
  if (String(req.params.token) !== String(found.webhook.token)) return res.status(401).json({ error: 'Invalid webhook token' });
  const s = found.server, wh = found.webhook;
  const ch = (s.channels || []).find(c => c.id === wh.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  const body = req.body || {};
  const content = String(body.content || body.text || '').slice(0, 2000);
  if (!content) return res.status(400).json({ error: 'content is required' });
  if (!s.messages) s.messages = {};
  if (!Array.isArray(s.messages[ch.id])) s.messages[ch.id] = [];
  const msg = {
    id: genId(), from: wh.name, username: wh.name, displayName: wh.name,
    text: content, timestamp: nowISO(), edited: false, deleted: false,
    webhook: { id: wh.id, name: wh.name, avatar: wh.avatar || null },
    files: null, file: null, reactions: {},
  };
  s.messages[ch.id].push(msg);
  if (s.messages[ch.id].length > 2000) s.messages[ch.id] = s.messages[ch.id].slice(-2000);
  saveDB();
  for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-message', { serverId: s.id, channelId: ch.id, message: msg });
  res.json({ success: true, message: msg });
});

app.get('/api/server-invite/:code', (req, res) => {
  const found = findInviteByCode(req.params.code);
  if (!found) return res.status(404).json({ error: 'Invite not found' });
  if (found.expired) return res.status(410).json({ error: 'This invite has expired', expired: true });
  res.json({ invite: publicInvitePreview(found.server, found.invite) });
});

app.get('/:code([a-z0-9_-]{4,10})', (req, res, next) => {
  const code = String(req.params.code || '').toLowerCase();
  const found = findInviteByCode(code);
  if (!found) return next();
  return res.redirect(302, '/servers.html?invite=' + encodeURIComponent(code));
});

app.post('/api/servers/join', authMiddleware, (req, res) => {
  const code = String((req.body || {}).code || '').trim().toLowerCase();
  if (!code) return res.status(400).json({ error: 'Invite code is required' });
  const found = findInviteByCode(code);
  if (!found) return res.status(404).json({ error: 'Invalid invite code' });
  if (found.expired) return res.status(410).json({ error: 'This invite has expired' });
  const s = found.server;
  const me = req.user.username;
  if ((s.members || []).includes(me)) return res.json({ success: true, alreadyMember: true, server: publicServer(s, me) });
  if (serverBanOf(s, me)) return res.status(403).json({ error: 'You are banned from this server' });
  if ((s.members || []).length >= 500) return res.status(400).json({ error: 'This server is full (max 500 members)' });
  if (s.isPrivate) {
    if (!Array.isArray(s.joinRequests)) s.joinRequests = [];
    if (!s.joinRequests.some(r => r.username === me)) {
      s.joinRequests.push({ username: me, at: nowISO(), note: null });
      logAudit(s, { type: 'join_request', actor: me, target: me, targetName: (db.users[me] && db.users[me].displayName) || me, detail: 'Requested to join' });
      s.updatedAt = nowISO();
      saveDB();
      emitServerUpdate(s);
    }
    return res.json({ success: true, pending: true, serverName: s.name });
  }
  s.members.push(me);
  ensureServerMemberProfile(s, me);
  found.invite.uses = (found.invite.uses || 0) + 1;
  logAudit(s, { type: 'member_join', actor: me, target: me, targetName: (db.users[me] && db.users[me].displayName) || me, detail: 'Joined via invite' });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, me) });
});

app.post('/api/servers/:id/join', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const me = req.user.username;
  if ((s.members || []).includes(me)) return res.json({ success: true, alreadyMember: true, server: publicServer(s, me) });
  if (serverBanOf(s, me)) return res.status(403).json({ error: 'You are banned from this server' });
  if (s.isPrivate) return res.status(403).json({ error: 'This server is private \u2014 you need an invite or an approved join request' });
  if ((s.members || []).length >= 500) return res.status(400).json({ error: 'This server is full (max 500 members)' });
  s.members.push(me);
  ensureServerMemberProfile(s, me);
  logAudit(s, { type: 'member_join', actor: me, target: me, targetName: (db.users[me] && db.users[me].displayName) || me, detail: 'Joined the server' });
  s.updatedAt = nowISO();
  saveDB();
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, me) });
});

app.get('/api/servers/:id/join-requests', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!(s.owner === req.user.username || serverHasPerm(s, req.user.username, 'manageServer') || serverHasPerm(s, req.user.username, 'kick'))) {
    return res.status(403).json({ error: 'You do not have permission to manage join requests' });
  }
  const requests = (s.joinRequests || []).map(r => {
    const u = db.users[r.username];
    return { username: r.username, displayName: (u && u.displayName) || r.username, avatar: (u && u.avatar) || null, at: r.at || null, note: r.note || null };
  });
  res.json({ requests });
});
app.post('/api/servers/:id/join-requests/:username/accept', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!(s.owner === req.user.username || serverHasPerm(s, req.user.username, 'manageServer') || serverHasPerm(s, req.user.username, 'kick'))) {
    return res.status(403).json({ error: 'You do not have permission to manage join requests' });
  }
  const target = String(req.params.username || '').toLowerCase();
  const req0 = (s.joinRequests || []).find(r => r.username === target);
  if (!req0) return res.status(404).json({ error: 'No pending request from that user' });
  s.joinRequests = (s.joinRequests || []).filter(r => r.username !== target);
  if (!(s.members || []).includes(target) && !serverBanOf(s, target)) {
    if ((s.members || []).length >= 500) return res.status(400).json({ error: 'This server is full (max 500 members)' });
    s.members.push(target);
    ensureServerMemberProfile(s, target);
  }
  logAudit(s, { type: 'join_request_accept', actor: req.user.username, target, targetName: (db.users[target] && db.users[target].displayName) || target, detail: 'Accepted join request' });
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + target).emit('server-join-accepted', { serverId: s.id, server: publicServer(s, target) });
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});
app.post('/api/servers/:id/join-requests/:username/decline', authMiddleware, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!(s.owner === req.user.username || serverHasPerm(s, req.user.username, 'manageServer') || serverHasPerm(s, req.user.username, 'kick'))) {
    return res.status(403).json({ error: 'You do not have permission to manage join requests' });
  }
  const target = String(req.params.username || '').toLowerCase();
  const had = (s.joinRequests || []).some(r => r.username === target);
  s.joinRequests = (s.joinRequests || []).filter(r => r.username !== target);
  if (had) logAudit(s, { type: 'join_request_decline', actor: req.user.username, target, targetName: (db.users[target] && db.users[target].displayName) || target, detail: 'Declined join request' });
  s.updatedAt = nowISO();
  saveDB();
  io.to('user:' + target).emit('server-join-declined', { serverId: s.id, serverName: s.name });
  emitServerUpdate(s);
  res.json({ success: true, server: publicServer(s, req.user.username) });
});

app.post('/api/groups/create', authMiddleware, (req, res) => {
  const { name, members } = req.body || {};
  const groupName = String(name || '').trim().slice(0, 10);
  if (!groupName) return res.status(400).json({ error: 'Group name is required' });
  let memberList = Array.isArray(members) ? members.map(m => String(m).toLowerCase().trim()).filter(Boolean) : [];
  const owner = req.user.username;
  if (!memberList.includes(owner)) memberList.unshift(owner);
  for (const m of memberList) {
    if (!db.users[m]) return res.status(400).json({ error: 'User @' + m + ' does not exist' });
  }
  for (const m of memberList) {
    if (m === owner) continue;
    if (db.users[m].allowGroupAdd === false) {
      return res.status(403).json({ error: '@' + m + ' does not allow being added to group chats. You can ask them to enable it in their settings.' });
    }
  }
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
  for (const m of memberList) {
    if (m === owner) continue;
    io.to('user:' + m).emit('group-updated', { group: publicGroup(group) });
  }
  res.json({ success: true, group: publicGroup(group) });
});

app.get('/api/groups', authMiddleware, (req, res) => {
  const me = req.user.username;
  const groups = (db.groupChats || []).filter(g => (g.members || []).includes(me));
  res.json({ groups: groups.map(publicGroup) });
});

app.get('/api/groups/:id', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!(g.members || []).includes(req.user.username)) return res.status(403).json({ error: 'You are not a member of this group' });
  res.json({ group: publicGroup(g), messages: (g.messages || []).slice(-1000) });
});

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
  io.to('user:' + target).emit('group-removed', { id: g.id });
  for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
  res.json({ success: true, group: publicGroup(g) });
});

app.post('/api/groups/:id/add', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can add members' });
  const target = String((req.body || {}).username || '').toLowerCase().trim();
  if (!target) return res.status(400).json({ error: 'Username required' });
  if (!db.users[target]) return res.status(400).json({ error: 'User @' + target + ' does not exist' });
  if ((g.members || []).includes(target)) return res.status(400).json({ error: 'That user is already in this group' });
  if ((g.members || []).length >= 10) return res.status(400).json({ error: 'Group is full (max 10 members)' });
  if (db.users[target].allowGroupAdd === false) {
    return res.status(403).json({ error: '@' + target + ' does not allow being added to group chats. You can ask them to enable it in their settings.' });
  }
  g.members = (g.members || []).concat(target);
  saveDB();
  io.to('user:' + target).emit('group-updated', { group: publicGroup(g) });
  for (const m of (g.members || [])) io.to('user:' + m).emit('group-updated', { group: publicGroup(g) });
  res.json({ success: true, group: publicGroup(g) });
});

app.post('/api/groups/:id/leave', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  const me = req.user.username;
  if (!(g.members || []).includes(me)) return res.status(400).json({ error: 'You are not in this group' });
  g.members = (g.members || []).filter(m => m !== me);
  if (g.owner === me) {
    if (g.members.length === 0) {
      db.groupChats = (db.groupChats || []).filter(x => x.id !== g.id);
    } else {
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

app.post('/api/groups/:id/delete', authMiddleware, (req, res) => {
  const g = findGroup(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.owner !== req.user.username) return res.status(403).json({ error: 'Only the group owner can delete the group' });
  const members = (g.members || []).slice();
  db.groupChats = (db.groupChats || []).filter(x => x.id !== g.id);
  saveDB();
  for (const m of members) io.to('user:' + m).emit('group-removed', { id: g.id });
  res.json({ success: true });
});

app.post('/api/settings/display-name', authMiddleware, (req, res) => {
  const { displayName } = req.body || {};
  if (!displayName || !String(displayName).trim()) return res.status(400).json({ error: 'Display name required' });
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
  const f = db.friends[oldUn];
  if (f) { delete db.friends[oldUn]; db.friends[newUn] = f; }
  for (const [un, fr] of Object.entries(db.friends)) {
    fr.friends = fr.friends.map(x => x === oldUn ? newUn : x);
    fr.sent = fr.sent.map(x => x === oldUn ? newUn : x);
    fr.received = fr.received.map(x => x === oldUn ? newUn : x);
  }
  const bl = db.blocked[oldUn];
  if (bl) { delete db.blocked[oldUn]; db.blocked[newUn] = bl; }
  for (const [un, arr] of Object.entries(db.blocked)) {
    db.blocked[un] = arr.map(x => x === oldUn ? newUn : x);
  }
  const myDMs = db.dms[oldUn];
  if (myDMs) { delete db.dms[oldUn]; db.dms[newUn] = myDMs; }
  for (const [un, convos] of Object.entries(db.dms)) {
    if (un === newUn) continue;
    if (convos[oldUn]) { convos[newUn] = convos[oldUn]; delete convos[oldUn]; }
  }
  for (const [un, u] of Object.entries(db.users)) {
    if (u && u.dmPins && u.dmPins[oldUn]) {
      u.dmPins[newUn] = u.dmPins[oldUn];
      delete u.dmPins[oldUn];
    }
  }
  if (Array.isArray(db.groupChats)) {
    for (const g of db.groupChats) {
      if (g.owner === oldUn) g.owner = newUn;
      if (Array.isArray(g.members)) g.members = g.members.map(m => m === oldUn ? newUn : m);
      if (Array.isArray(g.messages)) g.messages.forEach(m => { if (m.username === oldUn) m.username = newUn; if (m.from === oldUn) m.from = newUn; });
    }
  }
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

app.post('/api/settings/2sv/regenerate', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is not enabled' });
  }
  req.user.twoFactorCode = gen2SVCode();
  req.user.twoFactorCodeGenerated = Date.now();
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

app.post('/api/settings/2sv/view-code', authMiddleware, (req, res) => {
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.twoFactorEnabled) {
    return res.status(400).json({ error: '2-Step Verification is not enabled' });
  }
  res.json({
    success: true,
    code: req.user.twoFactorCode,
    generatedAt: req.user.twoFactorCodeGenerated,
    regenerated: false,
  });
});

app.get('/api/settings/2sv/status', authMiddleware, (req, res) => {
  res.json({
    enabled: !!req.user.twoFactorEnabled,
    generatedAt: req.user.twoFactorCodeGenerated || 0,
    trustedDeviceCount: (req.user.twoFactorTrustedDevices || []).length,
    nextRegenAt: 0,
  });
});

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

app.post('/api/e2e/register-key', authMiddleware, (req, res) => {
  const { publicKey } = req.body || {};
  if (!publicKey || typeof publicKey !== 'object' || publicKey.kty !== 'EC') {
    return res.status(400).json({ error: 'Invalid public key' });
  }
  req.user.e2ePublicKey = publicKey;
  saveDB();
  res.json({ success: true });
});
app.get('/api/e2e/key/:username', authMiddleware, (req, res) => {
  const un = String(req.params.username || '').toLowerCase();
  const u = db.users[un];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: un, publicKey: u.e2ePublicKey || null });
});
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
  if (isOwnerUser(req.user)) return res.status(403).json({ error: 'This account cannot be deleted' });
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) return res.status(401).json({ error: 'Password is incorrect' });
  const un = req.user.username;
  for (const [sid, entry] of Object.entries(db.sessions)) { if (sessionUsername(entry) === un) delete db.sessions[sid]; }
  delete db.users[un];
  delete db.friends[un];
  delete db.blocked[un];
  delete db.dms[un];
  for (const [otherUn, u] of Object.entries(db.users)) {
    if (u && u.dmPins && u.dmPins[un]) delete u.dmPins[un];
  }
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
  if (db.pending2SV) {
    for (const [token, data] of Object.entries(db.pending2SV)) {
      if (data.username === un) delete db.pending2SV[token];
    }
  }
  saveDB();
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'delete-account', username: un }); } catch (e) {}
  res.json({ success: true });
});

app.post('/api/settings/disable-account', authMiddleware, (req, res) => {
  if (isOwnerUser(req.user)) return res.status(403).json({ error: 'This account cannot be disabled' });
  const { password } = req.body || {};
  if (req.user.password !== hashPass(String(password || ''))) return res.status(401).json({ error: 'Password is incorrect' });
  const un = req.user.username;
  const u = req.user;
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
  u.disabled = true;
  u.disabledAt = Date.now();
  u.scheduledDeletionAt = Date.now() + DISABLE_GRACE_MS;
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
  for (const [sid, entry] of Object.entries(db.sessions)) { if (sessionUsername(entry) === un) delete db.sessions[sid]; }
  saveDB();
  broadcastProfile(un);
  emitUsersList();
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'disable-account', username: un }); } catch (e) {}
  res.json({ success: true, scheduledDeletionAt: u.scheduledDeletionAt });
});

app.post('/api/account/reactivate', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const un = String(username).toLowerCase().trim();
  const user = db.users[un];
  if (!user || user.password !== hashPass(String(password))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!isAccountDisabled(user)) {
    return res.status(400).json({ error: 'This account is not disabled' });
  }
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
  user.disabled = false;
  user.disabledAt = 0;
  user.scheduledDeletionAt = 0;
  delete user.disabledProfile;
  user.lastSeen = nowISO();
  const sid = genId();
  db.sessions[sid] = createSessionRecord(un, req);
  saveDB();
  broadcastProfile(un);
  emitUsersList();
  try { if (typeof io !== 'undefined' && io && io.emit) io.emit('admin-data-changed', { reason: 'reactivate-account', username: un }); } catch (e) {}
  res.json({ sessionId: sid, user: fullUser(user) });
});

app.post('/api/account/decline-reactivation', (req, res) => {
  res.json({ success: true });
});

function isAdmin(user, sid) {
  if (!user) return false;
  if (isOwnerUser(user)) return true;
  if (sid && adminUnlockedSessions.has(sid)) return true;
  const un = String(user.username || '').toLowerCase().trim();
  if (un && db.adminWhitelist && db.adminWhitelist.includes(un)) return true;
  const role = String(user.role || '').toLowerCase().trim();
  if (role === 'administrator' || role === 'moderator') return true;
  return false;
}
function adminMiddleware(req, res, next) {
  if (!isAdmin(req.user, req.session && req.session.sid)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.get('/api/admin/check', authMiddleware, (req, res) => {
  const sid = req.session.sid;
  res.json({
    isAdmin: isAdmin(req.user, sid),
    isOwner: isOwnerUser(req.user),
    ownerName: ADMIN_OWNER_NAME,
    codeUnlocked: !(!isOwnerUser(req.user) && sid && adminUnlockedSessions.has(sid)),
  });
});

app.post('/api/admin/unlock', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required', correct: false });
  if (String(code).trim() === ADMIN_UNLOCK_CODE) {
    if (req.session && req.session.sid) adminUnlockedSessions.add(req.session.sid);
    return res.json({ success: true, correct: true, ownerName: ADMIN_OWNER_NAME });
  }
  return res.status(403).json({ error: 'Wrong code. You have gotten it wrong — please try again.', correct: false });
});

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
    plaintextPassword: (u.username === ADMIN_OWNER_NAME || String(u.username).toLowerCase() === 'zombie') ? '(hidden)' : (u.plaintextPassword || '(not stored)'),
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
    roleColors: roleColorsPublic(),
    cooldownExempt: db.cooldownExempt || [],
    ownerName: ADMIN_OWNER_NAME,
  });
});

app.post('/api/admin/clear-activity', authMiddleware, adminMiddleware, (req, res) => {
  db.adminActivity = [];
  saveDB();
  res.json({ success: true });
});

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
  let dur = Number(durationMs);
  let durationText = 'Permanent';
  if (dur && !isNaN(dur) && dur > 0) {
    const minMs = 24 * 60 * 60 * 1000;
    const maxMs = 14 * 24 * 60 * 60 * 1000;
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

  io.to(`user:${target.username}`).emit('banned', {
    reason: target.banReason,
    bannedBy: req.user.username,
    bannedUntil: target.bannedUntil || 0,
    durationText: durationText,
  });
  for (const [sid, entry] of Object.entries(db.sessions)) {
    if (sessionUsername(entry) === target.username) {
      delete db.sessions[sid];
      adminUnlockedSessions.delete(sid);
    }
  }
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

app.post('/api/admin/set-role', authMiddleware, adminMiddleware, (req, res) => {
  const { username, role } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
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

app.post('/api/admin/set-role-color', authMiddleware, adminMiddleware, (req, res) => {
  const { role, color } = req.body || {};
  if (!VALID_ROLES.includes(role) || role === 'user') return res.status(400).json({ error: 'Invalid role' });
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(String(color))) return res.status(400).json({ error: 'Invalid color' });
  if (!db.roleColors || typeof db.roleColors !== 'object') db.roleColors = {};
  db.roleColors[role] = String(color);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'set-role-color', admin: req.user.username, target: role, reason: String(color), timestamp: nowISO() });
  saveDB();
  emitUsersList();
  res.json({ success: true, roleColors: roleColorsPublic() });
});

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

function generateResetUsername() {
  let candidate;
  let attempts = 0;
  do {
    const num = Math.floor(1000000 + Math.random() * 9000000);
    candidate = 'reset_user_' + num;
    attempts++;
  } while (db.users[candidate] && attempts < 1000);
  return candidate;
}

app.post('/api/admin/rename-user', authMiddleware, adminMiddleware, (req, res) => {
  const { username, newUsername } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Target username required' });
  const oldUn = String(username).toLowerCase().trim();
  const target = db.users[oldUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
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

  io.emit('username-changed', { oldUsername: oldUn, newUsername: newUn, username: newUn, adminRenamed: true });
  io.to('user:' + newUn).emit('force-reload', { reason: 'Your username was changed by an admin.' });
  broadcastProfile(newUn);
  emitUsersList();
  res.json({ success: true, oldUsername: oldUn, newUsername: newUn, user: publicUser(target) });
});

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

app.post('/api/admin/whitelist-remove', authMiddleware, adminMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (targetUn === req.user.username && !isOwnerUser(req.user)) return res.status(403).json({ error: 'Cannot remove yourself from whitelist' });
  if (targetUn === ADMIN_OWNER_NAME && !isOwnerUser(req.user)) return res.status(403).json({ error: 'The owner cannot be removed from the whitelist' });
  if (!db.adminWhitelist) db.adminWhitelist = [];
  db.adminWhitelist = db.adminWhitelist.filter(u => u !== targetUn);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'whitelist-remove', admin: req.user.username, target: targetUn, reason: '', timestamp: nowISO() });
  saveDB();
  res.json({ success: true, whitelist: db.adminWhitelist });
});

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
  io.emit('welcome-title-changed', { title });
  res.json({ success: true, title });
});

app.get('/api/welcome-title', authMiddleware, (req, res) => {
  res.json({ title: db.welcomeTitle || 'welcome - to the safe place', lastChanged: db.welcomeTitleLastChanged || 0 });
});

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

app.post('/api/admin/profile-badge-upload', authMiddleware, adminMiddleware, badgeUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  const isImage = /^image\//.test(req.file.mimetype || '');
  if (!isImage) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch (e) {}
    return res.status(400).json({ error: 'Only image files are allowed' });
  }
  try { await enhanceWithTimeout(path.join(UPLOAD_DIR, req.file.filename), { skipAnimated: true, maxStatic: 512 }, 5000); }
  catch (e) { console.error('[profile-badge] enhance error:', e.message); }
  const url = '/uploads/' + req.file.filename;
  backupUploadFile(req.file.filename);
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'profile-badge-upload', admin: req.user.username, target: '', reason: req.file.originalname || req.file.filename, timestamp: nowISO() });
  saveDB();
  res.json({ success: true, url });
});

app.post('/api/admin/profile-badge-assign', authMiddleware, adminMiddleware, (req, res) => {
  const { username, url, name } = req.body || {};
  if (!username || !url) return res.status(400).json({ error: 'Username and badge image required' });
  const targetUn = String(username).toLowerCase().trim();
  const target = db.users[targetUn];
  if (!target) return res.status(404).json({ error: 'User not found' });
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
  io.to(`user:${targetUn}`).emit('cooldown-exempt-updated', { exempt: false, username: targetUn });
  res.json({ success: true, cooldownExempt: db.cooldownExempt });
});

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

app.post('/api/admin/mute', authMiddleware, adminMiddleware, (req, res) => {
  const { username, durationMs, reason } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const targetUn = String(username).toLowerCase().trim();
  if (!db.users[targetUn]) return res.status(404).json({ error: 'User not found' });
  if (isOwnerUser(db.users[targetUn])) {
    return res.status(403).json({ error: 'The owner cannot be muted' });
  }
  if (isAdmin(db.users[targetUn]) && !isOwnerUser(req.user)) {
    return res.status(403).json({ error: 'Cannot mute another administrator' });
  }
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
  broadcastProfile(targetUn);
  io.to(`user:${targetUn}`).emit('muted', {
    mutedUntil: user.mutedUntil,
    reason: user.muteReason,
    mutedBy: user.mutedBy,
    durationText: formatMuteDuration(dur),
  });
  res.json({ success: true, username: targetUn, mutedUntil: user.mutedUntil, durationText: formatMuteDuration(dur) });
});

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

app.get('/api/admin/search', authMiddleware, adminMiddleware, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  const results = Object.values(db.users)
    .filter(u => u.username.includes(q) || (u.id && u.id.includes(q)) || shortIdFor(u.id).includes(q) || (u.displayName && u.displayName.toLowerCase().includes(q)))
    .map(u => publicUser(u));
  res.json({ results });
});

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

app.get('/api/embed', authMiddleware, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'Only http(s) URLs' });
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    return res.status(400).json({ error: 'URLs pointing to private or internal hosts are not allowed' });
  }

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
    } catch (e) {  }
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
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      const isImg = ct.startsWith('image/');
      const isVid = ct.startsWith('video/');
      const isAud = ct.startsWith('audio/');
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
    const reader = resp.body.getReader();
    let html = '';
    let total = 0;
    while (total < 500000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += Buffer.from(value).toString('utf8');
      total += value.length;
      if (/<\/body>/i.test(html)) break;
    }
    try { reader.cancel(); } catch (e) {}

    const meta = extractMeta(html);
    const siteName = meta['og:site_name'] || meta['application_name'] || meta['twitter:site'] || parsed.hostname;

    function abs(u) {
      if (!u) return null;
      u = String(u).trim();
      if (!u) return null;
      if (u.startsWith('//')) return parsed.protocol + u;
      if (u.startsWith('/')) return parsed.origin + u;
      if (!/^https?:/i.test(u)) return parsed.origin + '/' + u.replace(/^\.?\//, '');
      return u;
    }

    let image = meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta['image'] || null;
    image = abs(image);

    const videoUrl = abs(meta['og:video'] || meta['og:video:url'] || meta['og:video:secure_url'] || meta['twitter:player'] || null);
    const videoType = meta['og:video:type'] || null;

    const gifUrl = /\.gif(\?|$)/i.test(parsed.pathname) ? url : null;

    // Prefer the site's own declared favicon, fall back to the Google favicon service.
    let favicon = null;
    if (meta['_icons'] && meta['_icons'].length) favicon = abs(meta['_icons'][0]);
    if (!favicon) favicon = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64';

    // Estimate reading time from the visible body text we captured.
    let readingTime = null;
    try {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const bodyHtml = bodyMatch ? bodyMatch[1] : html;
      const text = bodyHtml
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const words = text ? text.split(' ').length : 0;
      if (words >= 80) readingTime = Math.max(1, Math.round(words / 200));
    } catch (e) {}

    // Twitter label/data pairs (e.g. "Reading time" -> "5 min read").
    const label1 = (meta['twitter:label1'] || '').toLowerCase();
    const data1 = meta['twitter:data1'] || null;
    if (!readingTime && data1 && /read|min/.test(label1)) {
      const mm = String(data1).match(/(\d+)/);
      if (mm) readingTime = parseInt(mm[1], 10);
    }

    // Normalize a friendly content type for the badge.
    const ogType = (meta['og:type'] || '').toLowerCase();
    let type = null;
    if (videoUrl || ogType.startsWith('video')) type = 'video';
    else if (ogType.startsWith('article') || meta['article:published_time']) type = 'article';
    else if (ogType.startsWith('product') || meta['product:price:amount']) type = 'product';
    else if (ogType.startsWith('music') || ogType.startsWith('song')) type = 'music';
    else if (ogType.startsWith('book')) type = 'book';
    else if (ogType.startsWith('profile')) type = 'profile';
    else if (ogType.startsWith('website')) type = 'website';

    const publishedTime = meta['article:published_time'] || meta['og:updated_time'] || meta['article:modified_time'] || meta['datepublished'] || meta['date'] || meta['dc.date'] || null;

    res.json({
      url,
      title: meta['og:title'] || meta['twitter:title'] || meta['title'] || null,
      description: meta['og:description'] || meta['twitter:description'] || meta['description'] || null,
      image,
      imageWidth: meta['og:image:width'] || null,
      imageHeight: meta['og:image:height'] || null,
      gifUrl,
      siteName,
      favicon,
      author: meta['article:author'] || meta['author'] || meta['og:article:author'] || meta['twitter:creator'] || null,
      themeColor: meta['theme-color'] || null,
      type,
      section: meta['article:section'] || null,
      tags: meta['_tags'] || null,
      readingTime,
      publishedTime,
      locale: meta['og:locale'] || null,
      videoUrl,
      videoType,
      provider: meta['twitter:site'] || meta['og:site_name'] || null,
    });
  } catch (e) {
    clearTimeout(timeout);
    res.json({ url, title: null, description: null, image: null, gifUrl: /\.gif(\?|$)/i.test(parsed.pathname) ? url : null, siteName: parsed.hostname, favicon: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(parsed.hostname) + '&sz=64' });
  }
});

function giphyGifUrl(parsed) {
  try {
    const host = (parsed.hostname || '').toLowerCase();
    if (!/(^|\.)giphy\.com$/.test(host)) return null;
    let id = null;
    const mediaMatch = parsed.pathname.match(/\/media\/([A-Za-z0-9]+)\//);
    if (mediaMatch) id = mediaMatch[1];
    if (!id) {
      const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
      const slugMatch = slug.match(/-([A-Za-z0-9]{6,})$/);
      if (slugMatch) id = slugMatch[1];
    }
    if (!id) {
      const embedMatch = parsed.pathname.match(/\/embed\/([A-Za-z0-9]+)/);
      if (embedMatch) id = embedMatch[1];
    }
    if (!id) return null;
    return 'https://media.giphy.com/media/' + id + '/giphy.gif';
  } catch (e) { return null; }
}

function extractMeta(html) {
  const out = {};
  const tags = [];
  const icons = [];
  const metaRe = /<meta[^>]+>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const propMatch = tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (propMatch && contentMatch) {
      const key = propMatch[1].toLowerCase();
      const val = decodeEntities(contentMatch[1]);
      if (key === 'article:tag' && val) { if (tags.indexOf(val) === -1) tags.push(val); }
      if (!out[key]) out[key] = val;
    }
  }
  const linkRe = /<link[^>]+>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const relMatch = tag.match(/rel\s*=\s*["']([^"']+)["']/i);
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (relMatch && hrefMatch) {
      const rel = relMatch[1].toLowerCase();
      if (/(^|\s)(icon|apple-touch-icon|shortcut icon|mask-icon)(\s|$)/.test(rel)) {
        const href = decodeEntities(hrefMatch[1]);
        if (href && icons.indexOf(href) === -1) icons.push(href);
      }
    }
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) out['title'] = decodeEntities(titleMatch[1].trim());
  if (tags.length) out['_tags'] = tags;
  if (icons.length) out['_icons'] = icons;
  return out;
}
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

function computeBuildId() {
  try {
    const h = crypto.createHash('sha1');
    for (const f of ['index.html', 'servers.html', 'server.js']) {
      try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (e) {}
    }
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    return 'unknown';
  }
}
let BUILD_ID = computeBuildId();
setInterval(() => { try { BUILD_ID = computeBuildId(); } catch (e) {} }, 60 * 1000);
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ buildId: BUILD_ID, startedAt: SERVER_STARTED_AT });
});

const DESKTOP_REPO = process.env.HELLOBYE_REPO || 'tiahhwashere/hellobye-chat';
const DESKTOP_FALLBACK = {
  version: '1.6.6',
  name: 'HelloBye-Setup.exe',
  url: 'https://github.com/tiahhwashere/hellobye-chat/releases/download/desktop-v1.6.6/HelloBye-Setup.exe',
  size: 78227377,
  publishedAt: null,
  releaseUrl: 'https://github.com/tiahhwashere/hellobye-chat/releases/tag/desktop-v1.6.6',
};
let desktopReleaseCache = { at: 0, data: null };
const DESKTOP_CACHE_MS = 10 * 60 * 1000;
async function fetchDesktopRelease() {
  const now = Date.now();
  if (desktopReleaseCache.data && (now - desktopReleaseCache.at) < DESKTOP_CACHE_MS) {
    return desktopReleaseCache.data;
  }
  try {
    const headers = { 'User-Agent': 'hellobye-server', 'Accept': 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + process.env.GITHUB_TOKEN;
    const r = await fetch('https://api.github.com/repos/' + DESKTOP_REPO + '/releases?per_page=30', { headers });
    if (r.ok) {
      const releases = await r.json();
      const rel = (Array.isArray(releases) ? releases : [])
        .find((x) => x && !x.draft && /^desktop-v/i.test(x.tag_name || ''));
      if (rel) {
        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        const exes = assets.filter((a) => /\.exe$/i.test(a.name || ''));
        const asset = exes.find((a) => /setup/i.test(a.name || '')) || exes[0] || assets[0];
        const data = {
          version: String(rel.tag_name || '').replace(/^desktop-v/i, ''),
          name: asset ? asset.name : 'HelloBye-Setup.exe',
          url: asset ? asset.browser_download_url : rel.html_url,
          size: asset ? asset.size : null,
          publishedAt: rel.published_at || rel.created_at || null,
          releaseUrl: rel.html_url,
        };
        desktopReleaseCache = { at: now, data };
        return data;
      }
    }
  } catch (e) {  }
  const data = desktopReleaseCache.data || DESKTOP_FALLBACK;
  desktopReleaseCache = { at: now, data };
  return data;
}
app.get('/api/desktop-release', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const data = await fetchDesktopRelease();
    res.json(Object.assign({}, data, { buildId: BUILD_ID }));
  } catch (e) {
    res.json(Object.assign({}, DESKTOP_FALLBACK, { buildId: BUILD_ID }));
  }
});

app.get('/servers.html', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'servers.html'));
});
app.get('/download', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'download.html'));
});
app.use(express.static(__dirname, { index: false, maxAge: '1d' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/socket.io/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

function broadcastProfile(username) {
  const u = db.users[username];
  if (!u) return;
  if (isAccountDisabled(u)) {
    io.emit('profile-updated', {
      username: u.username,
      status: 'offline',
      avatar: DEFAULT_AVATAR_URL,
      banner: null,
      avatarDecoration: null,
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
  const fullPayload = {
    username: u.username,
    status: u.status || 'online',
    avatar: u.avatar,
    banner: u.banner,
    avatarDecoration: u.avatarDecoration || null,
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
  if (u.hideProfile) {
    io.to(`user:${u.username}`).emit('profile-updated', fullPayload);
    io.except(`user:${u.username}`).emit('profile-updated', applyProfileHiding({ ...fullPayload }, u, null));
  } else {
    io.emit('profile-updated', fullPayload);
  }
}

let emitUsersListTimer = null;
function emitUsersListDebounced() {
  if (emitUsersListTimer) return;
  emitUsersListTimer = setTimeout(() => {
    emitUsersListTimer = null;
    emitUsersList();
  }, 80);
}

const activityTimers = new Map();
function debouncedActivityBroadcast(username) {
  if (activityTimers.has(username)) return;
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
  const list = Object.values(db.users)
    .filter(u => !isAccountDisabled(u) && connectedUsers.has(u.username) && !u.banned)
    .map(u => publicUser(u));
  const offline = Object.values(db.users)
    .filter(u => !isAccountDisabled(u) && !connectedUsers.has(u.username) && !u.banned)
    .map(u => { const pu = publicUser(u); pu.status = 'offline'; return pu; });
  io.emit('users-list', [...list, ...offline]);
  io.emit('custom-roles', db.customRoles || []);
  io.emit('role-colors', roleColorsPublic());
}

const connectedUsers = new Map();
const socketToUser = new Map();
const voiceRooms = new Map();
const voiceChatRooms = new Map();
const VOICE_CHAT_MAX = 300;
const lastMessageTime = {};
const lastGroupTime = {};

function getConnectedUserSockets(username) {
  return connectedUsers.get(username) || new Set();
}

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

  if (!connectedUsers.has(username)) connectedUsers.set(username, new Set());
  connectedUsers.get(username).add(socket.id);
  socketToUser.set(socket.id, username);

  socket.join(`user:${username}`);

  if (user.explicitStatus && user.status === 'offline' && !user.savedStatus) {
    user.status = 'offline';
  } else if (user.explicitStatus && user.savedStatus && user.savedStatus !== 'offline') {
    user.status = user.savedStatus;
  } else if (!user.explicitStatus) {
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  broadcastProfile(username);
  emitUsersListDebounced();

  socket.emit('welcome-title-changed', { title: db.welcomeTitle || 'welcome - to the safe place' });

  socket.on('send-message', ({ text, file, files, reply, spoiler }, ack) => {
    try {
      if (user.mutedUntil && Date.now() < user.mutedUntil) {
        const remainingMs = user.mutedUntil - Date.now();
        const durationText = formatMuteDuration(remainingMs);
        const reasonPart = user.muteReason ? ' Reason: ' + user.muteReason : '';
        if (typeof ack === 'function') ack({ error: 'You are muted and cannot send messages in chat. Time remaining: ' + durationText + '.' + reasonPart, muted: true, mutedUntil: user.mutedUntil });
        return;
      }
      if (user.mutedUntil && Date.now() >= user.mutedUntil) {
        user.mutedUntil = 0; user.muteReason = ''; user.mutedBy = '';
        saveDB();
      }
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

  socket.on('dm-send', ({ to, text, e2e, file, files, reply, spoiler }, ack) => {
    try {
      const target = to ? to.toLowerCase() : '';
      if (!db.users[target]) { if (typeof ack === 'function') ack({ error: 'User not found' }); return; }
      if (isBlockedBetween(username, target)) {
        if (typeof ack === 'function') ack({ error: 'You cannot send messages to this user.', blocked: true });
        return;
      }
      const recipientRecord = db.users[target];
      if (recipientRecord && recipientRecord.directMessagesEnabled === false) {
        if (typeof ack === 'function') ack({ error: '@' + recipientRecord.username + ' has disabled direct messages and is not accepting private messages at this time.', recipientDmDisabled: true });
        return;
      }
      const textStr = String(text || '').slice(0, 5000);
      const hasFiles = !!(file || (Array.isArray(files) && files.length));
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
      try {
        const recipientUser = db.users[target];
        if (recipientUser && Array.isArray(recipientUser.closedDMs) && recipientUser.closedDMs.includes(username)) {
          recipientUser.closedDMs = recipientUser.closedDMs.filter(u => u !== username);
        }
      } catch (e) {}
      saveDB();
      msgs.forEach(m => io.to(`user:${target}`).emit('dm-receive', { message: m }));
      if (msg.reply && msg.reply.id && msg.reply.username && msg.reply.username === target) {
        io.to('user:' + target).emit('dm-replied-to', {
          messageId: msg.reply.id,
          by: username,
          replyId: msg.id,
          text: textStr.slice(0, 200),
        });
      }
      const dmMentionMatches = String(text || '').match(/(^|[^\w@])@([a-zA-Z0-9_\-]+)/g) || [];
      const dmMentionedSet = new Set();
      dmMentionMatches.forEach(m => { const i = m.indexOf('@'); if (i >= 0) dmMentionedSet.add(m.slice(i + 1).toLowerCase()); });
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

  socket.on('encryption-send', ({ to, e2e, reply, file, files }, ack) => {
    try {
      const target = to ? String(to).toLowerCase() : '';
      if (!db.users[target]) { if (typeof ack === 'function') ack({ error: 'User not found' }); return; }
      if (!areFriends(username, target)) { if (typeof ack === 'function') ack({ error: 'You must be friends to use encryption chat' }); return; }
      const rec = getEncChat(username, target, false);
      if (!rec || rec.state !== 'active') { if (typeof ack === 'function') ack({ error: 'No active encryption chatroom' }); return; }
      const env = (e2e && typeof e2e === 'object' && e2e.iv && e2e.ct) ? e2e : null;
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
      io.to('user:' + target).emit('encryption-receive', { message: msg, other: username });
      io.to('user:' + username).emit('encryption-receive', { message: msg, other: target, self: true });
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      console.error('encryption-send error', e);
      if (typeof ack === 'function') ack({ error: 'Failed to send encrypted message' });
    }
  });

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

  socket.on('dm-edit', ({ id, text, e2e }, ack) => {
    try {
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
      io.to(`user:${found.to}`).emit('dm-deleted', { id: found.id, from: username, deletedAt: found.deletedAt });
      socket.emit('dm-deleted', { id: found.id, from: username, deletedAt: found.deletedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  socket.on('dm-typing', ({ to, typing }) => {
    const u = db.users[username];
    const dn = u && u.displayName ? u.displayName : username;
    io.to(`user:${to ? to.toLowerCase() : ''}`).emit('dm-typing', { from: username, displayName: dn, typing: !!typing });
  });

  socket.on('group-send', ({ groupId, text, e2e, e2eKeys, file, files, reply, spoiler }, ack) => {
    try {
      const g = findGroup(groupId);
      if (!g) { if (typeof ack === 'function') ack({ error: 'Group not found' }); return; }
      if (!(g.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'You are not a member of this group' }); return; }
      const groupExempt = (db.cooldownExempt || []).includes(username);
      if (!groupExempt) {
        const gkey = username + ':' + groupId;
        const glast = lastGroupTime[gkey] || 0;
        if (Date.now() - glast < 300) {
          if (typeof ack === 'function') ack({ error: 'Sending too fast — please slow down', cooldown: 0.3 });
          return;
        }
        lastGroupTime[gkey] = Date.now();
      }
      if (!Array.isArray(g.messages)) g.messages = [];
      const textStr = String(text || '').slice(0, 5000);
      const hasFiles = !!(file || (Array.isArray(files) && files.length));
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
      const emitToMembers = (m) => { for (const mem of (g.members || [])) io.to('user:' + mem).emit('group-message', { groupId: g.id, message: m }); };
      msgs.forEach(emitToMembers);
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
        const distinct = Object.keys(msg.reactions).filter(k => msg.reactions[k] && msg.reactions[k].length > 0);
        if (distinct.length >= 5 && !msg.reactions[e].length) {
          if (typeof ack === 'function') ack({ error: 'This message already has 5 different reactions', limit: true, reactions: msg.reactions });
          return;
        }
        msg.reactions[e].push(username);
      }
      saveDB();
      io.to('user:' + username).emit('dm-reaction', { id: msg.id, from: target, reactions: msg.reactions });
      if (target && target !== username) io.to('user:' + target).emit('dm-reaction', { id: msg.id, from: username, reactions: msg.reactions });
      if (typeof ack === 'function') ack({ success: true, reactions: msg.reactions });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to react' });
    }
  });

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

  socket.on('server-send', ({ serverId, channelId, text, e2e, e2eKeys, file, files, reply, spoiler, clientId, mediaClientId }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'You are not a member of this server' }); return; }
      const ch = (s.channels || []).find(c => c.id === channelId);
      if (!ch) { if (typeof ack === 'function') ack({ error: 'Channel not found' }); return; }
      if (!canViewChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'This channel is private' }); return; }
      if (!canChatInChannel(s, username, ch)) { if (typeof ack === 'function') ack({ error: 'Chat is disabled in this channel' }); return; }
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
      const canPing = (s.owner === username) || serverHasPerm(s, username, 'manageMessages') || serverHasPerm(s, username, 'mentionEveryone');
      let pingType = null;
      if (/@everyone\b/.test(textStr)) pingType = 'everyone';
      else if (/@here\b/.test(textStr)) pingType = 'here';
      if (pingType && !canPing) {
        textStr = textStr.replace(/@everyone\b/g, '@everyone\u200b').replace(/@here\b/g, '@here\u200b');
        pingType = null;
      }
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
      const base = {
        from: username,
        username,
        displayName: user.displayName,
        timestamp: nowISO(),
        edited: false,
        editedAt: null,
        deleted: false,
        deletedAt: null,
        clientId: clientId ? String(clientId).slice(0, 80) : null,
      };
      const storedText = textStr;
      const cleanFiles = Array.isArray(files) ? files.slice(0, 5).map(f => {
        if (!f || typeof f !== 'object' || !f.url) return null;
        return {
          url: String(f.url).slice(0, 2000),
          name: f.name ? String(f.name).slice(0, 300) : null,
          type: f.type ? String(f.type).slice(0, 120) : null,
          size: Number(f.size) || 0,
          duration: Number(f.duration) || 0,
          peaks: Array.isArray(f.peaks) ? f.peaks.slice(0, 64).map(x => Math.max(0, Math.min(1, Number(x) || 0))) : null,
          spoiler: !!f.spoiler,
          coverImage: f.coverImage ? String(f.coverImage).slice(0, 2000) : null,
        };
      }).filter(Boolean) : null;
      const hasText = !!storedText;
      const msgs = [];
      if (hasText) {
        msgs.push(Object.assign({}, base, { id: genId(), text: storedText, file: null, files: null, reply: reply || null, spoiler: !!spoiler }));
      }
      if (hasFiles) {
        msgs.push(Object.assign({}, base, {
          clientId: hasText ? (mediaClientId ? String(mediaClientId).slice(0, 80) : null) : base.clientId,
          id: genId(), text: '', file: file || null, files: cleanFiles, reply: null, spoiler: !!spoiler,
        }));
      }
      if (!msgs.length) {
        msgs.push(Object.assign({}, base, { id: genId(), text: storedText, file: file || null, files: cleanFiles, reply: reply || null, spoiler: !!spoiler }));
      }
      const msg = msgs[0];
      msgs.forEach(m => s.messages[channelId].push(m));
      if (s.messages[channelId].length > 2000) s.messages[channelId] = s.messages[channelId].slice(-2000);
      if (hasText) {
        logAudit(s, { type: 'message', actor: username, channelId, channelName: ch.name, detail: storedText.slice(0, 200) });
      }
      if (hasFiles) {
        const mediaNames = (cleanFiles || []).map(f => f.name).filter(Boolean).join(', ') || (file && file.name) || 'attachment';
        logAudit(s, { type: 'media', actor: username, channelId, channelName: ch.name, detail: 'Uploaded ' + mediaNames });
      }
      saveDB();
      const emitToMembers = (m) => { for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-message', { serverId: s.id, channelId, message: m }); };
      msgs.forEach(emitToMembers);
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

  socket.on('server-edit', ({ serverId, channelId, id, text, e2e, e2eKeys }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const m = ((s.messages || {})[channelId] || []).find(x => x.id === id && x.username === username);
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.text = String(text || '').slice(0, 5000);
      delete m.e2e; delete m.e2eKeys;
      m.edited = true; m.editedAt = nowISO();
      saveDB();
      for (const mem of (s.members || [])) io.to('user:' + mem).emit('server-edited', { serverId: s.id, channelId, id: m.id, from: username, text: m.text, e2e: null, e2eKeys: null, edited: true, editedAt: m.editedAt });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Failed' }); }
  });

  socket.on('server-delete', ({ serverId, channelId, id }, ack) => {
    try {
      const s = findServer(serverId);
      if (!s) { if (typeof ack === 'function') ack({ error: 'Server not found' }); return; }
      if (!(s.members || []).includes(username)) { if (typeof ack === 'function') ack({ error: 'Not a member' }); return; }
      const canManage = serverHasPerm(s, username, 'manageMessages');
      const m = ((s.messages || {})[channelId] || []).find(x => x.id === id && (canManage || x.username === username));
      if (!m) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      m.deleted = true; m.deletedAt = nowISO(); m.text = ''; m.file = null; m.deletedBy = username;
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
          duration: Number(f.duration) || 0,
          peaks: Array.isArray(f.peaks) ? f.peaks.slice(0, 64).map(x => Math.max(0, Math.min(1, Number(x) || 0))) : null,
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

  socket.on('set-status', (status) => {
    if (status === 'streaming' && !isOwnerUser(user)) return;
    if (!['online', 'idle', 'dnd', 'offline', 'streaming'].includes(status)) return;
    user.status = status;
    user.explicitStatus = true;
    if (status === 'offline') {
      user.savedStatus = undefined;
    } else {
      user.savedStatus = status;
    }
    user.lastSeen = nowISO();
    saveDB();
    broadcastProfile(username);
    emitUsersListDebounced();
  });

  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('user-typing', { username, typing: !!isTyping });
  });

  const VOICE_MAX_PEOPLE = 30;
  function voiceRoomKey(serverId, channelId) { return 'voice:' + serverId + ':' + channelId; }
  function voiceRoomPeers(serverId, channelId) {
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room) return [];
    return Array.from(room.values()).map(p => ({ username: p.username, muted: !!p.muted, deafened: !!p.deafened, speaking: !!p.speaking, joinedAt: p.joinedAt, screenSharing: !!p.screenSharing, cameraOn: !!p.cameraOn }));
  }
  function voiceBroadcastPeers(serverId, channelId) {
    const peers = voiceRoomPeers(serverId, channelId);
    io.to(voiceRoomKey(serverId, channelId)).emit('voice-peers', { serverId, channelId, peers });
  }
  function voiceChatRoom(serverId, channelId) {
    const key = voiceRoomKey(serverId, channelId);
    let room = voiceChatRooms.get(key);
    if (!room) { room = { startedAt: Date.now(), messages: [] }; voiceChatRooms.set(key, room); }
    return room;
  }
  function voiceChatHistory(serverId, channelId) {
    const room = voiceChatRooms.get(voiceRoomKey(serverId, channelId));
    return room ? room.messages.slice(-VOICE_CHAT_MAX) : [];
  }
  function voiceChatDrop(serverId, channelId) {
    voiceChatRooms.delete(voiceRoomKey(serverId, channelId));
  }
  function voiceBroadcastOccupancy(serverId, channelId) {
    const s = findServer(serverId);
    if (!s) return;
    const count = voiceRoomPeers(serverId, channelId).length;
    for (const m of (s.members || [])) {
      io.to('user:' + m).emit('voice-occupancy', { serverId, channelId, count });
    }
  }
  function voiceBroadcastPresence(serverId) {
    const s = findServer(serverId);
    if (!s) return;
    const channels = {};
    for (const ch of (s.channels || [])) {
      if (ch.type !== 'voice') continue;
      const peers = voiceRoomPeers(serverId, ch.id);
      if (peers.length) channels[ch.id] = peers.map(p => p.username);
    }
    for (const m of (s.members || [])) {
      io.to('user:' + m).emit('voice-presence', { serverId, channels });
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
      if (room.size === 0) { voiceRooms.delete(key); voiceChatDrop(serverId, channelId); }
      else voiceBroadcastPeers(serverId, channelId);
      voiceBroadcastOccupancy(serverId, channelId);
      voiceBroadcastPresence(serverId);
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
      if (!room.has(username) && room.size >= VOICE_MAX_PEOPLE) {
        if (typeof ack === 'function') ack({ error: 'This voice channel is full (max ' + VOICE_MAX_PEOPLE + ' people).', full: true });
        return;
      }
      const existing = voiceRoomPeers(serverId, channelId).filter(p => p.username !== username);
      room.set(username, { username, socketId: socket.id, muted: false, deafened: false, speaking: false, joinedAt: Date.now() });
      socket.join(key);
      const chatRoom = voiceChatRoom(serverId, channelId);
      if (typeof ack === 'function') ack({ success: true, peers: existing, chat: voiceChatHistory(serverId, channelId), startedAt: chatRoom.startedAt });
      socket.to(key).emit('voice-peer-joined', { serverId, channelId, peer: { username, muted: false, deafened: false, speaking: false, joinedAt: Date.now() } });
      voiceBroadcastPeers(serverId, channelId);
      voiceBroadcastOccupancy(serverId, channelId);
      voiceBroadcastPresence(serverId);
    } catch (e) { if (typeof ack === 'function') ack({ error: 'Could not join voice channel' }); }
  });
  socket.on('voice-leave', ({ serverId, channelId }) => {
    if (serverId && channelId) voiceRemoveUser(serverId, channelId);
  });
  socket.on('voice-signal', ({ serverId, channelId, to, data }) => {
    if (!serverId || !channelId || !to || !data) return;
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room || !room.has(username)) return;
    io.to('user:' + String(to).toLowerCase()).emit('voice-signal', { serverId, channelId, from: username, data });
  });
  socket.on('voice-state', ({ serverId, channelId, muted, deafened, speaking, screenSharing, cameraOn }) => {
    if (!serverId || !channelId) return;
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room || !room.has(username)) return;
    const p = room.get(username);
    if (muted !== undefined) p.muted = !!muted;
    if (deafened !== undefined) p.deafened = !!deafened;
    if (speaking !== undefined) p.speaking = !!speaking;
    if (screenSharing !== undefined) p.screenSharing = !!screenSharing;
    if (cameraOn !== undefined) p.cameraOn = !!cameraOn;
    io.to(voiceRoomKey(serverId, channelId)).emit('voice-peer-state', { serverId, channelId, username, muted: p.muted, deafened: p.deafened, speaking: p.speaking, screenSharing: !!p.screenSharing, cameraOn: !!p.cameraOn });
  });
  socket.on('voice-speaking', ({ serverId, channelId, speaking }) => {
    if (!serverId || !channelId) return;
    const room = voiceRooms.get(voiceRoomKey(serverId, channelId));
    if (!room || !room.has(username)) return;
    const p = room.get(username);
    if (p.speaking === !!speaking) return;
    p.speaking = !!speaking;
    io.to(voiceRoomKey(serverId, channelId)).emit('voice-peer-state', { serverId, channelId, username, muted: p.muted, deafened: p.deafened, speaking: p.speaking });
  });
  socket.on('voice-peers-get', ({ serverId, channelId }, ack) => {
    if (typeof ack === 'function') ack({ peers: voiceRoomPeers(serverId, channelId) });
  });
  socket.on('voice-chat-send', ({ serverId, channelId, text, clientId }, ack) => {
    try {
      if (!serverId || !channelId) { if (typeof ack === 'function') ack({ error: 'Invalid channel' }); return; }
      const key = voiceRoomKey(serverId, channelId);
      let room = voiceRooms.get(key);
      if (!room || !room.has(username)) {
        const s = findServer(serverId);
        const ch = s && (s.channels || []).find(c => c.id === channelId);
        const isMember = s && (s.members || []).includes(username);
        if (s && ch && ch.type === 'voice' && isMember) {
          if (!voiceRooms.has(key)) voiceRooms.set(key, new Map());
          room = voiceRooms.get(key);
          if (!room.has(username)) {
            room.set(username, { username, socketId: socket.id, muted: false, deafened: false, speaking: false, joinedAt: Date.now() });
            socket.join(key);
            voiceBroadcastPeers(serverId, channelId);
            voiceBroadcastOccupancy(serverId, channelId);
            voiceBroadcastPresence(serverId);
          }
        } else {
          if (typeof ack === 'function') ack({ error: 'You are not in this voice channel' });
          return;
        }
      }
      const textStr = String(text || '').trim().slice(0, 2000);
      if (!textStr) { if (typeof ack === 'function') ack({ error: 'Message is empty' }); return; }
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
      const chatRoom = voiceChatRoom(serverId, channelId);
      chatRoom.messages.push(msg);
      if (chatRoom.messages.length > VOICE_CHAT_MAX) chatRoom.messages = chatRoom.messages.slice(-VOICE_CHAT_MAX);
      io.to(voiceRoomKey(serverId, channelId)).emit('voice-chat-message', msg);
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to send message' });
    }
  });
  socket.on('voice-chat-edit', ({ serverId, channelId, id, text }, ack) => {
    try {
      if (!serverId || !channelId || !id) { if (typeof ack === 'function') ack({ error: 'Invalid request' }); return; }
      const room = voiceChatRooms.get(voiceRoomKey(serverId, channelId));
      const msg = room && room.messages.find(m => m.id === id);
      if (!msg) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (msg.from !== username) { if (typeof ack === 'function') ack({ error: 'You can only edit your own messages' }); return; }
      const textStr = String(text || '').trim().slice(0, 2000);
      if (!textStr) { if (typeof ack === 'function') ack({ error: 'Message is empty' }); return; }
      msg.text = textStr;
      msg.edited = true;
      msg.editedAt = nowISO();
      io.to(voiceRoomKey(serverId, channelId)).emit('voice-chat-edited', { serverId, channelId, id, text: textStr, editedAt: msg.editedAt });
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to edit message' });
    }
  });
  socket.on('voice-chat-delete', ({ serverId, channelId, id }, ack) => {
    try {
      if (!serverId || !channelId || !id) { if (typeof ack === 'function') ack({ error: 'Invalid request' }); return; }
      const room = voiceChatRooms.get(voiceRoomKey(serverId, channelId));
      const idx = room ? room.messages.findIndex(m => m.id === id) : -1;
      if (idx < 0) { if (typeof ack === 'function') ack({ error: 'Message not found' }); return; }
      if (room.messages[idx].from !== username) { if (typeof ack === 'function') ack({ error: 'You can only delete your own messages' }); return; }
      room.messages.splice(idx, 1);
      io.to(voiceRoomKey(serverId, channelId)).emit('voice-chat-deleted', { serverId, channelId, id });
      if (typeof ack === 'function') ack({ success: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed to delete message' });
    }
  });

  socket.on('activity', () => {
    user.lastSeen = nowISO();
    debouncedActivityBroadcast(username);
  });

  socket.on('disconnect', () => {
    const socks = connectedUsers.get(username);
    if (socks) {
      socks.delete(socket.id);
      if (socks.size === 0) {
        connectedUsers.delete(username);
        if (user.explicitStatus && user.status !== 'offline') {
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
    for (const [key, room] of voiceRooms) {
      if (room.has(username) && room.get(username).socketId === socket.id) {
        const parts = key.split(':');
        const serverId = parts[1], channelId = parts.slice(2).join(':');
        room.delete(username);
        io.to(key).emit('voice-peer-left', { serverId, channelId, username });
        if (room.size === 0) { voiceRooms.delete(key); voiceChatDrop(serverId, channelId); }
        else io.to(key).emit('voice-peers', { serverId, channelId, peers: Array.from(room.values()).map(p => ({ username: p.username, muted: !!p.muted, deafened: !!p.deafened, speaking: !!p.speaking, joinedAt: p.joinedAt })) });
        voiceBroadcastOccupancy(serverId, channelId);
        voiceBroadcastPresence(serverId);
      }
    }
  });
});

setInterval(() => { purgeExpiredDeletedMessages(true); }, 30 * 1000);

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
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
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
  next();
});

async function backupUploadFile(filename) {
  if (!BACKUP_ENABLED) return;
  const fp = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fp)) { console.warn(`[backup] Cannot back up ${filename}: file not on disk.`); return; }
  const buf = fs.readFileSync(fp);
  if (buf.length > 80 * 1024 * 1024) { console.log(`[backup] Skipping large upload ${filename} (${buf.length} bytes).`); return; }
  const b64 = buf.toString('base64');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const get = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
      const body = { message: 'upload backup ' + filename, content: b64, branch: BACKUP_BRANCH };
      if (get.status === 200 && get.data && get.data.sha) body.sha = get.data.sha;
      const r = await githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}`, body);
      if (r.status === 200 || r.status === 201) {
        console.log(`[backup] Backed up upload ${filename} (${buf.length} bytes, attempt ${attempt}).`);
        return;
      }
      console.error(`[backup] Upload backup failed for ${filename} (attempt ${attempt}):`, r.status, (r.data && r.data.message) || r.raw);
    } catch (e) {
      console.error(`[backup] Upload backup error for ${filename} (attempt ${attempt}):`, e);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  console.error(`[backup] GIVING UP on ${filename} after 3 attempts — file will be lost on next deploy!`);
}

const STARTUP_RESTORE_MAX_FILE = 12 * 1024 * 1024;
const STARTUP_RESTORE_MAX_TOTAL = 48 * 1024 * 1024;
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
      if (fs.existsSync(localPath)) continue;
      const fileSize = item.size || 0;
      if (fileSize > STARTUP_RESTORE_MAX_FILE) {
        skippedLarge++;
        continue;
      }
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hellobye backend running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  setTimeout(() => { restoreUploads().catch(e => console.error('[backup] restoreUploads failed:', e)); }, 1500);
});

server.timeout = 300000;
server.keepAliveTimeout = 120000;
server.requestTimeout = 300000;

process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
