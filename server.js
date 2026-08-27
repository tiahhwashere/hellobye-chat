// Hellobye Chat — Compatible Backend
// Express + Socket.io implementation matching the frontend SPA's API surface.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

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

function defaultDB() {
  return { users: {}, messages: [], sessions: {}, dms: {}, friends: {}, blocked: {}, lastRegTime: {} };
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
// Ensure new fields exist on existing DB
if (!db.welcomeTitle) db.welcomeTitle = 'welcome - to the safe place';
if (!db.welcomeTitleLastChanged) db.welcomeTitleLastChanged = 0;
if (!db.customRoles) db.customRoles = []; // [{ id, name, color, members: [username,...] }]
if (!db.cooldownExempt) db.cooldownExempt = []; // [username, ...] — users exempt from chat cooldown

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

// On startup: purge any chat messages that were soft-deleted but never got
// removed (e.g. the server restarted before the 2-minute cleanup timer fired).
// This prevents stuck "This message was deleted" placeholders from lingering.
if (Array.isArray(db.messages)) {
  const before = db.messages.length;
  db.messages = db.messages.filter(m => !m.deleted);
  const purged = before - db.messages.length;
  if (purged > 0) { saveDB(); console.log(`Startup cleanup: removed ${purged} stuck deleted message(s).`); }
}

// ---------- Helpers ----------
function genId() { return crypto.randomUUID(); }
function hashPass(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function nowISO() { return new Date().toISOString(); }
// Admin-related constants
// ADMIN_OWNER_ID is kept for two reasons: (1) the owner can never be banned,
// and (2) @lore is always displayed as the panel owner in the UI.
// However, the panel is now UNLOCKED via a secret code (ADMIN_UNLOCK_CODE),
// so ANY user who enters the correct code can use the admin panel.
const ADMIN_OWNER_ID = 'ff1db773-9f98-4141-8449-90aeaa68a965';
const ADMIN_OWNER_NAME = 'lore'; // always shown as the owner username
const ADMIN_UNLOCK_CODE = 'Xk8vL2pQ9mR4wZ7bY1fH3dCs';
const VALID_ROLES = ['user', 'developer', 'administrator', 'moderator', 'beta_tester'];
const VALID_BADGES = ['moderator', 'developer', 'staff', 'trusted_user'];
// Tracks which session IDs have unlocked the admin panel via the code.
// Stored in memory (resets on restart — users just re-enter the code).
const adminUnlockedSessions = new Set();
const WELCOME_TITLE_COOLDOWN = 20000; // 20 seconds in ms

function publicUser(u) {
  if (!u) return null;
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
    hideLastSeen: !!u.hideLastSeen,
    lastSeen: u.lastSeen || nowISO(),
    showOnlineStatus: u.showOnlineStatus !== false,
    createdAt: u.createdAt || nowISO(),
    id: u.id || null,
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
    banReason: u.banReason || null,
    mutedUntil: (u.mutedUntil && Date.now() < u.mutedUntil) ? u.mutedUntil : 0,
  };
}
function fullUser(u) {
  const pub = publicUser(u);
  pub.email = u.email || '';
  pub.compactMode = !!u.compactMode;
  pub.notificationsEnabled = u.notificationsEnabled !== false;
  pub.messageSounds = u.messageSounds !== false;
  pub.theme = u.theme || 'dark';
  pub.preferences = u.preferences || {};
  pub.isAdmin = (u.id === ADMIN_OWNER_ID);
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
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static uploads
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

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
const upload = multer({ storage, limits: { fileSize: 121 * 1024 * 1024 } }); // 120MB + 1MB headroom
const avatarUpload = multer({ storage, limits: { fileSize: 121 * 1024 * 1024 } });

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
    hideLastSeen: false,
    showOnlineStatus: true,
    lastSeen: nowISO(),
    createdAt: nowISO(),
    compactMode: false,
    notificationsEnabled: true,
    messageSounds: true,
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
  if (user.banned) {
    return res.status(403).json({ error: 'This account has been banned' + (user.banReason ? ': ' + user.banReason : '') });
  }
  const sid = genId();
  db.sessions[sid] = un;
  // On login, restore the user's explicitly-saved status if they had one
  // (e.g. they chose "idle" or "dnd", then closed the tab — on login it
  // should come back to their chosen status, not reset to "offline").
  if (user.explicitStatus && user.savedStatus) {
    user.status = user.savedStatus;
  } else if (!user.explicitStatus || user.status !== 'offline') {
    user.status = 'online';
  }
  user.lastSeen = nowISO();
  saveDB();
  res.json({ sessionId: sid, user: fullUser(user) });
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

// ---------- Users ----------
app.get('/api/users', authMiddleware, (req, res) => {
  const list = Object.values(db.users).map(u => publicUser(u));
  res.json({ users: list });
});

app.get('/api/user/:username', authMiddleware, (req, res) => {
  const u = db.users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
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
app.post('/api/profile', authMiddleware, avatarUpload.single('image'), (req, res) => {
  const u = req.user;
  if (req.file) {
    // Image upload (avatar or banner)
    const type = req.body.type || 'avatar';
    const url = '/uploads/' + req.file.filename;
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
  const { bio, hideLastSeen, pronouns, showOnlineStatus } = req.body || {};
  if (bio !== undefined) u.bio = String(bio).slice(0, 500);
  if (hideLastSeen !== undefined) u.hideLastSeen = !!hideLastSeen;
  if (pronouns !== undefined) u.pronouns = String(pronouns).slice(0, 50);
  if (showOnlineStatus !== undefined) u.showOnlineStatus = showOnlineStatus !== false;
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
  res.json({ success: true });
});

// ---------- File Upload ----------
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const url = '/uploads/' + req.file.filename;
  backupUploadFile(req.file.filename);
  res.json({
    file: {
      url,
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
      mimetype: req.file.mimetype, // alias so the frontend's createFileElement works
    },
  });
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

// ---------- Settings ----------
app.post('/api/settings/display-name', authMiddleware, (req, res) => {
  const { displayName } = req.body || {};
  if (!displayName || !String(displayName).trim()) return res.status(400).json({ error: 'Display name required' });
  req.user.displayName = String(displayName).trim().slice(0, 50);
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

app.post('/api/settings/preferences', authMiddleware, (req, res) => {
  const p = req.body || {};
  if (p.notificationsEnabled !== undefined) req.user.notificationsEnabled = !!p.notificationsEnabled;
  if (p.messageSounds !== undefined) req.user.messageSounds = !!p.messageSounds;
  if (p.compactMode !== undefined) req.user.compactMode = !!p.compactMode;
  if (p.theme) req.user.theme = p.theme;
  req.user.preferences = p;
  saveDB();
  res.json({ success: true });
});

app.post('/api/settings/delete-account', authMiddleware, (req, res) => {
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
  saveDB();
  res.json({ success: true });
});

// ---------- Admin Middleware & Endpoints ----------
// Admin access is granted when EITHER:
//   (a) the user is the owner (id === ADMIN_OWNER_ID), OR
//   (b) the user's session has unlocked the panel by entering ADMIN_UNLOCK_CODE.
// Every logged-in user can SEE the admin tab; clicking it prompts for the code.
function isAdmin(user, sid) {
  if (!user) return false;
  if (user.id === ADMIN_OWNER_ID) return true;
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
    isOwner: req.user.id === ADMIN_OWNER_ID,
    ownerName: ADMIN_OWNER_NAME,
    codeUnlocked: !!(req.user.id !== ADMIN_OWNER_ID && sid && adminUnlockedSessions.has(sid)),
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

// Ban a user
app.post('/api/admin/ban', authMiddleware, adminMiddleware, (req, res) => {
  const { username, reason } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.users[String(username).toLowerCase().trim()];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === ADMIN_OWNER_ID) return res.status(403).json({ error: 'Cannot ban the owner' });
  if (isAdmin(target) && req.user.id !== ADMIN_OWNER_ID) return res.status(403).json({ error: 'Cannot ban another admin' });
  target.banned = true;
  target.banReason = String(reason || 'No reason provided').trim();
  target.bannedAt = nowISO();
  target.bannedBy = req.user.username;
  if (!db.adminActivity) db.adminActivity = [];
  db.adminActivity.push({ action: 'ban', admin: req.user.username, target: target.username, reason: target.banReason, timestamp: nowISO() });
  saveDB();

  // ---- Force logout the banned user ----
  // 1. Notify the user's connected sockets so the frontend can show a "banned"
  //    message and return to the login screen.
  io.to(`user:${target.username}`).emit('banned', {
    reason: target.banReason,
    bannedBy: req.user.username,
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
  res.json({ success: true, user: publicUser(target) });
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
  if (target.id === ADMIN_OWNER_ID && req.user.id !== ADMIN_OWNER_ID) {
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
  if (targetUn === req.user.username && req.user.id !== ADMIN_OWNER_ID) return res.status(403).json({ error: 'Cannot remove yourself from whitelist' });
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
    showOnlineStatus: u.showOnlineStatus !== false,
    role: u.role || 'user',
    badges: u.badges || [],
    banned: !!u.banned,
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
    .filter(u => connectedUsers.has(u.username) && (u.showOnlineStatus !== false || customRoleUsernames.has(u.username)) && !u.banned)
    .map(u => publicUser(u));
  // Also include offline users with their last seen
  const offline = Object.values(db.users)
    .filter(u => !connectedUsers.has(u.username) && !u.banned)
    .map(u => { const pu = publicUser(u); pu.status = 'offline'; return pu; });
  io.emit('users-list', [...list, ...offline]);
  // Also emit custom roles so the member sidebar can render custom role groups
  io.emit('custom-roles', db.customRoles || []);
}

const connectedUsers = new Map(); // username -> Set(socketIds)
const socketToUser = new Map(); // socketId -> username
const lastMessageTime = {}; // username -> timestamp (cooldown)
const lastDMTime = {}; // username:other -> timestamp

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

  // Mark online — preserve user's explicitly-set status (e.g. "offline" / "dnd")
  // Only default to "online" if the user never explicitly chose a status,
  // or if they were showing online/idle/dnd (not "offline").
  if (!user.explicitStatus || (user.status !== 'offline')) {
    user.status = user.explicitStatus ? user.status : 'online';
  }
  // If user explicitly chose "offline", keep it as "offline" (appear offline persists)
  // Restore a previously-saved explicit status (e.g. online/idle/dnd) on reconnect
  if (user.explicitStatus && user.savedStatus && user.status === 'offline') {
    user.status = user.savedStatus;
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
      // 5-second cooldown (skip if user is exempt)
      const isExempt = (db.cooldownExempt || []).includes(username);
      if (!isExempt) {
        const last = lastMessageTime[username] || 0;
        if (Date.now() - last < 5000) {
          const cooldown = Math.ceil((5000 - (Date.now() - last)) / 1000);
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
      // After 2 minutes, permanently remove the message from chat & database
      const removeId = msg.id;
      setTimeout(() => {
        const idx = db.messages.findIndex(m => m.id === removeId);
        if (idx >= 0) {
          db.messages.splice(idx, 1);
          saveDB();
          io.emit('message-removed', { id: removeId });
        }
      }, 2 * 60 * 1000); // 2 minutes
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- DM send ----
  socket.on('dm-send', ({ to, text, file, files, reply }, ack) => {
    try {
      const target = to ? to.toLowerCase() : '';
      if (!db.users[target]) { if (typeof ack === 'function') ack({ error: 'User not found' }); return; }
      const key = username + ':' + target;
      const last = lastDMTime[key] || 0;
      if (Date.now() - last < 3000) {
        const cooldown = Math.ceil((3000 - (Date.now() - last)) / 1000);
        if (typeof ack === 'function') ack({ error: 'Please wait ' + cooldown + 's', cooldown });
        return;
      }
      lastDMTime[key] = Date.now();
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
      saveDB();
      // Emit to recipient
      io.to(`user:${target}`).emit('dm-receive', { message: msg });
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
      if (typeof ack === 'function') ack({ success: true });
      // After 2 minutes, permanently remove the DM from chat & database
      const removeId = found.id;
      const removeTo = found.to;
      setTimeout(() => {
        // Remove from sender's DM store
        const senderDMs = db.dms[username] || {};
        for (const [other, msgs] of Object.entries(senderDMs)) {
          const idx = msgs.findIndex(x => x.id === removeId);
          if (idx >= 0) { msgs.splice(idx, 1); break; }
        }
        // Remove from recipient's DM store
        const recipDMs = db.dms[removeTo] || {};
        for (const [other, msgs] of Object.entries(recipDMs)) {
          const idx = msgs.findIndex(x => x.id === removeId);
          if (idx >= 0) { msgs.splice(idx, 1); break; }
        }
        saveDB();
        io.to(`user:${username}`).emit('dm-removed', { id: removeId });
        io.to(`user:${removeTo}`).emit('dm-removed', { id: removeId });
      }, 2 * 60 * 1000); // 2 minutes
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Failed' });
    }
  });

  // ---- DM typing ----
  socket.on('dm-typing', ({ to, typing }) => {
    io.to(`user:${to ? to.toLowerCase() : ''}`).emit('dm-typing', { from: username, typing: !!typing });
  });

  // ---- Set status ----
  socket.on('set-status', (status) => {
    if (!['online', 'idle', 'dnd', 'offline'].includes(status)) return;
    user.status = status;
    user.explicitStatus = true; // Mark as user-set (persists across reconnects)
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

// ---------- Multer Error Handler ----------
// Catches file-size-exceeded and other multer errors so the client gets a
// clean JSON response instead of a raw 500.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 120MB size limit.' });
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
const UPLOAD_BACKUP_DIR = 'uploads'; // path inside the backup repo

async function backupUploadFile(filename) {
  if (!BACKUP_ENABLED) return;
  try {
    const fp = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(fp)) return;
    const buf = fs.readFileSync(fp);
    // Skip if larger than ~80MB to avoid GitHub content limits / timeouts.
    if (buf.length > 80 * 1024 * 1024) { console.log(`[backup] Skipping large upload ${filename} (${buf.length} bytes).`); return; }
    const b64 = buf.toString('base64');
    // Check if file exists remotely to get sha (needed to update vs create).
    const get = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
    const body = { message: 'upload backup ' + filename, content: b64, branch: BACKUP_BRANCH };
    if (get.status === 200 && get.data && get.data.sha) body.sha = get.data.sha;
    const r = await githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + filename)}`, body);
    if (r.status === 200 || r.status === 201) {
      console.log(`[backup] Backed up upload ${filename} (${buf.length} bytes).`);
    } else {
      console.error(`[backup] Upload backup failed for ${filename}:`, r.status, (r.data && r.data.message) || r.raw);
    }
  } catch (e) {
    console.error('[backup] Upload backup error:', e);
  }
}

// Restore uploads from the backup repo on startup (files not already present).
async function restoreUploads() {
  if (!BACKUP_ENABLED) return;
  try {
    const r = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
    if (r.status !== 200 || !Array.isArray(r.data)) {
      console.log(`[backup] No remote uploads dir to restore (status ${r.status}).`);
      return;
    }
    let restored = 0;
    for (const item of r.data) {
      if (item.type !== 'file') continue;
      const localPath = path.join(UPLOAD_DIR, item.name);
      if (fs.existsSync(localPath)) continue; // already present (e.g. badge icons)
      try {
        const fr = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${encodeURIComponent(UPLOAD_BACKUP_DIR + '/' + item.name)}?ref=${encodeURIComponent(BACKUP_BRANCH)}`);
        if (fr.status === 200 && fr.data && fr.data.content) {
          const b64 = (fr.data.content || '').replace(/\s/g, '');
          const buf = Buffer.from(b64, 'base64');
          fs.writeFileSync(localPath, buf);
          restored++;
        }
      } catch (e) { console.error(`[backup] Failed to restore upload ${item.name}:`, e); }
    }
    if (restored > 0) console.log(`[backup] Restored ${restored} user upload(s) from GitHub.`);
    else console.log('[backup] No user uploads needed restoring.');
  } catch (e) {
    console.error('[backup] restoreUploads error:', e);
  }
}
restoreUploads();

// ---------- Start ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hellobye backend running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
});

// Allow large file uploads (120MB) without timeout issues
server.timeout = 300000;       // 5 minutes for request timeout
server.keepAliveTimeout = 120000; // 2 minutes keep-alive
server.requestTimeout = 300000;   // 5 minutes for full request

// Save on exit
process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
