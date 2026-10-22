const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const {
  masterDb,
  getOrgDb,
  createOrganization,
  getNextOrgSongNumber,
  getSongbookTags,
  resolveSongbookTag,
  resolveSongCategory,
  importMasterSongToOrg,
  migrateLegacySampleDb,
  ensureMasterAdmin
} = require('./db');

const PORT = process.env.PORT || 3000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password).trim(), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function passwordMatches(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, expectedHex] = stored.split('$');
    if (!salt || !expectedHex) return false;
    const actual = crypto.scryptSync(String(password).trim(), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  const legacy = crypto.createHash('sha256').update(String(password).trim()).digest('hex');
  const actual = Buffer.from(legacy, 'hex'), expected = Buffer.from(stored, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Run legacy data migration & ensure root admin
migrateLegacySampleDb();
ensureMasterAdmin(hashPassword);

// Session store in memory: token -> session
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const SONG_LANGUAGES = new Set(['English', 'Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Nagamese', 'Other']);

function organizationsForUser(user) {
  if (user.isMasterAdmin) {
    return masterDb.prepare('SELECT id, name, slug, logo_data AS logoData, brand_color AS brandColor, welcome_text AS welcomeText, created_at, 1 AS isOrgAdmin FROM organizations ORDER BY name').all();
  }
  return masterDb.prepare(`
    SELECT o.id, o.name, o.slug, o.logo_data AS logoData, o.brand_color AS brandColor,
           o.welcome_text AS welcomeText, o.created_at,
           uo.role,
           CASE WHEN uo.role IN ('org_owner', 'org_admin') THEN 1 ELSE 0 END AS isOrgAdmin
    FROM organizations o
    JOIN user_organizations uo ON uo.organization_id = o.id
    WHERE uo.user_id = ?
    ORDER BY o.name
  `).all(user.id);
}

function orgRoleFor(userId, orgId) {
  if (!orgId) return null;
  return masterDb.prepare('SELECT role FROM user_organizations WHERE user_id = ? AND organization_id = ?').get(userId, orgId) || null;
}

function groupsForUser(user, orgId) {
  const orgDb = getOrgDb(orgId);
  if (!orgDb) return [];
  const orgRole = orgRoleFor(user.id, orgId);
  const isOrgAdmin = user.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';

  if (isOrgAdmin) {
    return orgDb.prepare('SELECT id, name, NULL AS role, 1 AS canDisplay, 1 AS canAddSongs, 1 AS canEditSongs FROM groups ORDER BY name').all();
  }
  return orgDb.prepare(`
    SELECT gm.group_id AS id, g.name, gm.role,
           gm.can_display AS canDisplay, gm.can_add_songs AS canAddSongs, gm.can_edit_songs AS canEditSongs
    FROM group_memberships gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.name
  `).all(user.id);
}

function groupMembershipFor(userId, orgId, groupId) {
  const orgDb = getOrgDb(orgId);
  if (!orgDb || !groupId) return null;
  return orgDb.prepare(`
    SELECT gm.group_id, gm.role, gm.can_display, gm.can_add_songs, gm.can_edit_songs,
           g.name AS group_name
    FROM group_memberships gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = ? AND gm.group_id = ?
  `).get(userId, groupId) || null;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const orgs = organizationsForUser({ id: user.id, isMasterAdmin: user.permission >= 2 });
  const defaultOrgId = orgs[0] ? orgs[0].id : null;
  let defaultGroupId = null;

  if (defaultOrgId) {
    const groups = groupsForUser({ id: user.id, isMasterAdmin: user.permission >= 2 }, defaultOrgId);
    defaultGroupId = groups[0] ? groups[0].id : null;
  }

  sessions.set(token, {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      isMasterAdmin: user.permission >= 2
    },
    organizationId: defaultOrgId,
    groupId: defaultGroupId,
    expiresAt: Date.now() + SESSION_TTL
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// Authentication & Context Middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/session_token=([^;]+)/);
    if (match) token = match[1];
  }

  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }

  req.token = token;
  req.session = session;
  req.user = session.user;
  req.orgId = session.organizationId;
  req.groupId = session.groupId;
  req.orgDb = getOrgDb(session.organizationId);

  const orgRole = orgRoleFor(req.user.id, session.organizationId);
  req.isOrgAdmin = req.user.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';
  req.groupMembership = groupMembershipFor(req.user.id, session.organizationId, session.groupId);

  next();
}

function requireMasterAdmin(req, res, next) {
  if (!req.user || !req.user.isMasterAdmin) {
    return res.status(403).json({ error: 'Forbidden. Master admin privileges required.' });
  }
  next();
}

function requireOrg(req, res, next) {
  if (!req.orgDb) {
    return res.status(400).json({ error: 'Please select an active organization first.' });
  }
  next();
}

function requireOrgAdmin(req, res, next) {
  if (!req.isOrgAdmin) {
    return res.status(403).json({ error: 'Forbidden. Organization admin privileges required.' });
  }
  next();
}

function requireGroup(req, res, next) {
  if (!req.orgDb) return res.status(400).json({ error: 'Please select an active organization first.' });
  if (!req.groupId) return res.status(403).json({ error: 'Please select an active group.' });
  if (!req.isOrgAdmin && !req.groupMembership) {
    return res.status(403).json({ error: 'You are not a member of this group.' });
  }
  next();
}

function requireGroupPermission(permission) {
  return (req, res, next) => {
    if (req.isOrgAdmin) return next();
    if (!req.groupMembership || !(req.groupMembership.role === 'group_admin' || req.groupMembership[permission])) {
      return res.status(403).json({ error: 'Your membership in this group does not grant permission for this action.' });
    }
    next();
  };
}

// Lyric parser into slides
function wrapLyricText(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const parts = [];
  let part = '';

  for (const word of words) {
    if (word.length > maxChars) {
      if (part) parts.push(part);
      part = '';
      for (let i = 0; i < word.length; i += maxChars) parts.push(word.slice(i, i + maxChars));
      continue;
    }
    if (part && `${part} ${word}`.length > maxChars) {
      parts.push(part);
      part = word;
    } else {
      part = part ? `${part} ${word}` : word;
    }
  }

  if (part) parts.push(part);
  return parts.length ? parts : [''];
}

function parseLyricsIntoSlides(rawLyrics, rawTranslit = '', fontSize = 54, displayWidth = 1920, displayHeight = 1080, contentWidth = displayWidth * 0.82, contentHeight = displayHeight * 0.72, charWidthRatio = 0.56, fitScale = 1) {
  if (!rawLyrics) return [];
  fontSize = Math.max(32, Math.min(84, Number(fontSize) || 54));
  const maxChars = Math.max(12, Math.floor((contentWidth * 0.88) / (fontSize * charWidthRatio * 1.08)));
  const maxSlideHeight = Math.max(fontSize * 1.35, contentHeight * 0.72 * fitScale);
  const cleanLyrics = rawLyrics.replace(/\r\n/g, '\n').trim();
  let stanzas = cleanLyrics.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);

  if (stanzas.length > 0 && stanzas[0].length <= 10 && /^[A-G][b#]?(?:maj|min|m|dim|aug|sus|7|9|add9)?(?:\[.*\])?$/i.test(stanzas[0].trim())) {
    stanzas.shift();
  }

  const translitStanzas = rawTranslit 
    ? rawTranslit.replace(/\r\n/g, '\n').trim().split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean)
    : [];

  const slides = [];
  stanzas.forEach((stanza, idx) => {
    const rawLines = stanza.split('\n').map(l => l.replace(/\t+/g, ' ').trim()).filter(Boolean);
    const translitRawLines = translitStanzas[idx] 
      ? translitStanzas[idx].split('\n').map(l => l.replace(/\t+/g, ' ').trim()).filter(Boolean)
      : [];

    let label = `Verse ${idx + 1}`;
    let displayLines = [...rawLines];

    if (displayLines.length > 0) {
      if (/^(?:\[?[A-G][b#]?(?:maj|min|m|dim|aug|sus|7|9|add9)?(?:\s+maj|\s+min)?\]?)$/i.test(displayLines[0].trim())) {
        displayLines.shift();
      }
    }

    if (displayLines.length > 0) {
      const firstLine = displayLines[0];
      const numMatch = firstLine.match(/^(\d+)[\.\:\)]\s*(.*)$/);
      if (numMatch) {
        label = `Verse ${numMatch[1]}`;
        if (numMatch[2].trim()) {
          displayLines[0] = numMatch[2].trim();
        } else {
          displayLines.shift();
        }
      } else if (/^chorus/i.test(firstLine)) {
        label = 'Chorus';
        displayLines.shift();
      } else if (/^bridge/i.test(firstLine)) {
        label = 'Bridge';
        displayLines.shift();
      }
    }

    const pairedLines = [];
    displayLines.forEach((line, lineIdx) => {
      const textParts = wrapLyricText(line, maxChars);
      const translitParts = translitRawLines[lineIdx]
        ? wrapLyricText(translitRawLines[lineIdx], maxChars)
        : [];
      const partCount = Math.max(textParts.length, translitParts.length, 1);
      for (let partIdx = 0; partIdx < partCount; partIdx++) {
        pairedLines.push({
          text: textParts[partIdx] || '',
          translit: translitParts[partIdx] || null
        });
      }
    });

    let chunk = [];
    let chunkHeight = 0;
    let chunkNumber = 0;
    const pushChunk = () => {
      if (!chunk.length) return;
      slides.push({
        index: slides.length,
        label: chunkNumber === 0 ? label : `${label} (cont.)`,
        lines: chunk.map(item => item.text).filter(Boolean),
        pairedLines: chunk,
        rawStanza: stanza,
        sourceStanzaIndex: idx,
        sourceLineStart: chunk[0].sourceLineIndex
      });
      chunk = [];
      chunkHeight = 0;
      chunkNumber++;
    };

    pairedLines.forEach((item, lineIdx) => {
      item.sourceLineIndex = lineIdx;
      const mainHeight = fontSize * 1.25;
      const translitHeight = item.translit ? fontSize * 0.65 * 1.25 + 7 : 0;
      const itemHeight = mainHeight + translitHeight + 16;
      if (chunk.length && chunkHeight + itemHeight > maxSlideHeight) pushChunk();
      chunk.push(item);
      chunkHeight += itemHeight;
    });
    pushChunk();
  });

  return slides;
}

// Live state is isolated per organization and group
const DEFAULT_LIVE_STATE = {
  currentSong: null,
  activeSlideIndex: 0,
  isBlank: false,
  isClear: false,
  showTranslit: true,
  theme: 'clean-white',
  fontSize: 54,
  fontFamily: 'Outfit',
  textAlign: 'center',
  displayWidth: 1920,
  displayHeight: 1080,
  displayContentWidth: 1574,
  displayContentHeight: 778,
  displayCharWidthRatio: 0.56,
  displayFitScale: 1
};

const liveStates = new Map();

function stateKey(orgId, groupId) {
  return `${Number(orgId)}:${Number(groupId)}`;
}

function getLiveState(orgId, groupId) {
  const key = stateKey(orgId, groupId);
  if (!liveStates.has(key)) {
    const orgDb = getOrgDb(orgId);
    let state = structuredClone(DEFAULT_LIVE_STATE);
    if (orgDb) {
      const saved = orgDb.prepare('SELECT state_json FROM group_live_states WHERE group_id = ?').get(Number(groupId));
      if (saved) {
        try { state = { ...state, ...JSON.parse(saved.state_json) }; } catch (_) {}
      }
    }
    liveStates.set(key, state);
  }
  return liveStates.get(key);
}

function persistLiveState(orgId, groupId, state) {
  const orgDb = getOrgDb(orgId);
  if (!orgDb) return;
  orgDb.prepare(`INSERT INTO group_live_states (group_id, state_json, modified_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(group_id) DO UPDATE SET state_json = excluded.state_json, modified_at = excluded.modified_at`)
    .run(Number(groupId), JSON.stringify(state));
}

function reflowCurrentSongSlides(orgId, liveState) {
  if (!liveState.currentSong) return;
  const orgDb = getOrgDb(orgId);
  if (!orgDb) return;
  const songRow = orgDb.prepare('SELECT lyrics, transliteration FROM songs WHERE id = ?').get(liveState.currentSong.id);
  if (!songRow) return;

  const previousSlide = liveState.currentSong.slides[liveState.activeSlideIndex];
  const slides = parseLyricsIntoSlides(
    songRow.lyrics,
    songRow.transliteration,
    liveState.fontSize,
    liveState.displayWidth,
    liveState.displayHeight,
    liveState.displayContentWidth,
    liveState.displayContentHeight,
    liveState.displayCharWidthRatio,
    liveState.displayFitScale
  );
  liveState.currentSong.slides = slides;

  if (previousSlide && slides.length) {
    const sameStanza = slides.filter(slide => slide.sourceStanzaIndex === previousSlide.sourceStanzaIndex);
    const preserved = sameStanza.find(slide => slide.sourceLineStart <= previousSlide.sourceLineStart);
    liveState.activeSlideIndex = preserved ? preserved.index : (sameStanza[0] ? sameStanza[0].index : 0);
  } else {
    liveState.activeSlideIndex = Math.min(liveState.activeSlideIndex, Math.max(0, slides.length - 1));
  }
}

// Express App
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Set up HTTP and WebSocket Servers
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastState(orgId, groupId) {
  const liveState = getLiveState(orgId, groupId);
  persistLiveState(orgId, groupId, liveState);
  const payload = JSON.stringify({
    type: 'STATE_UPDATE',
    state: liveState,
    timestamp: Date.now()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.orgId === Number(orgId) && client.groupId === Number(groupId)) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const orgId = Number(url.searchParams.get('orgId') || 1);
  const groupId = Number(url.searchParams.get('groupId'));
  const orgDb = getOrgDb(orgId);

  if (!orgDb || !groupId || !orgDb.prepare('SELECT id FROM groups WHERE id = ?').get(groupId)) {
    return ws.close(1008, 'A valid orgId and groupId are required');
  }

  ws.orgId = orgId;
  ws.groupId = groupId;
  ws.isDisplay = true;

  const tokenMatch = (req.headers.cookie || '').match(/session_token=([^;]+)/);
  const token = tokenMatch ? tokenMatch[1] : null;
  const requestedClient = url.searchParams.get('client');

  if (token) {
    const session = getSession(token);
    const user = session ? session.user : null;
    const membership = user && groupMembershipFor(user.id, orgId, groupId);
    const orgRole = user && orgRoleFor(user.id, orgId);
    const isOrgAdmin = user?.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';

    if (!user || (!membership && !isOrgAdmin)) {
      if (requestedClient !== 'display') return ws.close(1008, 'Not a member of this group');
    } else if (requestedClient !== 'display') {
      ws.isDisplay = false;
      ws.sessionToken = token;
      ws.userId = user.id;
      ws.canControl = Boolean(isOrgAdmin || membership.role === 'group_admin' || membership.can_display);
    }
  } else if (requestedClient !== 'display') {
    return ws.close(1008, 'Sign in to control this group');
  }

  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    state: getLiveState(orgId, groupId),
    timestamp: Date.now()
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleWebSocketMessage(ws, data);
    } catch (e) {
      console.error('WebSocket message parsing error:', e);
    }
  });
});

function handleWebSocketMessage(ws, data) {
  const liveState = getLiveState(ws.orgId, ws.groupId);
  if (!ws.isDisplay) {
    const session = getSession(ws.sessionToken);
    const user = session?.user;
    const orgRole = user && orgRoleFor(user.id, ws.orgId);
    const isOrgAdmin = user?.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';
    const membership = user && groupMembershipFor(user.id, ws.orgId, ws.groupId);
    if (!isOrgAdmin && (!membership || !(membership.role === 'group_admin' || membership.can_display))) return;
  }

  if (ws.isDisplay && !['DISPLAY_SIZE', 'DISPLAY_OVERFLOW'].includes(data.action)) return;

  switch (data.action) {
    case 'DISPLAY_SIZE': {
      const width = Math.max(320, Math.min(7680, parseInt(data.width, 10) || liveState.displayWidth));
      const height = Math.max(240, Math.min(4320, parseInt(data.height, 10) || liveState.displayHeight));
      const contentWidth = Math.max(240, Math.min(width, parseInt(data.contentWidth, 10) || Math.floor(width * 0.82)));
      const contentHeight = Math.max(180, Math.min(height, parseInt(data.contentHeight, 10) || Math.floor(height * 0.72)));
      const charWidthRatio = Math.max(0.3, Math.min(1.2, Number(data.charWidthRatio) || liveState.displayCharWidthRatio));
      if (width !== liveState.displayWidth || height !== liveState.displayHeight || contentWidth !== liveState.displayContentWidth || contentHeight !== liveState.displayContentHeight || Math.abs(charWidthRatio - liveState.displayCharWidthRatio) > 0.01) {
        liveState.displayWidth = width;
        liveState.displayHeight = height;
        liveState.displayContentWidth = contentWidth;
        liveState.displayContentHeight = contentHeight;
        liveState.displayCharWidthRatio = charWidthRatio;
        liveState.displayFitScale = 1;
        reflowCurrentSongSlides(ws.orgId, liveState);
        broadcastState(ws.orgId, ws.groupId);
      }
      break;
    }
    case 'DISPLAY_OVERFLOW': {
      if (liveState.currentSong && Number(data.songId) === Number(liveState.currentSong.id) && Number(data.fontSize) === Number(liveState.fontSize) && liveState.displayFitScale > 0.32) {
        liveState.displayFitScale = Math.max(0.32, liveState.displayFitScale * 0.78);
        reflowCurrentSongSlides(ws.orgId, liveState);
        broadcastState(ws.orgId, ws.groupId);
      }
      break;
    }
    case 'SET_SONG': {
      const { songId, slideIndex = 0 } = data;
      const orgDb = getOrgDb(ws.orgId);
      const songRow = orgDb ? orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(songId) : null;
      if (songRow) {
        liveState.displayFitScale = 1;
        const slides = parseLyricsIntoSlides(songRow.lyrics, songRow.transliteration, liveState.fontSize, liveState.displayWidth, liveState.displayHeight, liveState.displayContentWidth, liveState.displayContentHeight, liveState.displayCharWidthRatio, liveState.displayFitScale);
        liveState.currentSong = {
          id: songRow.id,
          song_number: songRow.song_number,
          title: songRow.title,
          alternate_title: songRow.alternate_title,
          chord: songRow.chord,
          youtube_link: songRow.youtube_link,
          slides
        };
        liveState.activeSlideIndex = Math.min(slideIndex, Math.max(0, slides.length - 1));
        liveState.isBlank = false;
        liveState.isClear = false;
        broadcastState(ws.orgId, ws.groupId);
      }
      break;
    }
    case 'SET_SLIDE': {
      if (liveState.currentSong && liveState.currentSong.slides.length > 0) {
        const target = parseInt(data.slideIndex, 10);
        if (target >= 0 && target < liveState.currentSong.slides.length) {
          liveState.activeSlideIndex = target;
          liveState.isBlank = false;
          liveState.isClear = false;
          broadcastState(ws.orgId, ws.groupId);
        }
      }
      break;
    }
    case 'NEXT_SLIDE': {
      if (liveState.currentSong && liveState.currentSong.slides.length > 0) {
        if (liveState.activeSlideIndex < liveState.currentSong.slides.length - 1) {
          liveState.activeSlideIndex++;
          liveState.isBlank = false;
          liveState.isClear = false;
          broadcastState(ws.orgId, ws.groupId);
        }
      }
      break;
    }
    case 'PREV_SLIDE': {
      if (liveState.currentSong && liveState.currentSong.slides.length > 0) {
        if (liveState.activeSlideIndex > 0) {
          liveState.activeSlideIndex--;
          liveState.isBlank = false;
          liveState.isClear = false;
          broadcastState(ws.orgId, ws.groupId);
        }
      }
      break;
    }
    case 'TOGGLE_BLANK': {
      liveState.isBlank = typeof data.isBlank === 'boolean' ? data.isBlank : !liveState.isBlank;
      broadcastState(ws.orgId, ws.groupId);
      break;
    }
    case 'TOGGLE_CLEAR': {
      liveState.isClear = typeof data.isClear === 'boolean' ? data.isClear : !liveState.isClear;
      broadcastState(ws.orgId, ws.groupId);
      break;
    }
    case 'TOGGLE_TRANSLIT': {
      liveState.showTranslit = typeof data.showTranslit === 'boolean' ? data.showTranslit : !liveState.showTranslit;
      broadcastState(ws.orgId, ws.groupId);
      break;
    }
    case 'UPDATE_STYLE': {
      if (data.theme) liveState.theme = data.theme;
      if (data.fontSize !== undefined) {
        liveState.fontSize = Math.max(32, Math.min(84, Number(data.fontSize) || liveState.fontSize));
        liveState.displayFitScale = 1;
        reflowCurrentSongSlides(ws.orgId, liveState);
      }
      if (data.fontFamily) liveState.fontFamily = data.fontFamily;
      if (data.textAlign) liveState.textAlign = data.textAlign;
      broadcastState(ws.orgId, ws.groupId);
      break;
    }
    case 'RESET_DISPLAY': {
      liveState.currentSong = null;
      liveState.activeSlideIndex = 0;
      liveState.isBlank = false;
      liveState.isClear = false;
      broadcastState(ws.orgId, ws.groupId);
      break;
    }
  }
}

// Version tracking within organization songs
const VERSION_FIELDS = ['song_number', 'title', 'alternate_title', 'lyrics', 'transliteration', 'chord', 'language', 'songbook_tag', 'youtube_link'];

function recordSongVersion(orgDb, song, actor, changeType = 'edit', sourceVersionId = null) {
  const snapshot = {};
  for (const field of VERSION_FIELDS) snapshot[field] = song[field] ?? null;
  orgDb.prepare(`INSERT INTO song_versions (song_id, actor_user_id, actor_username, changed_at, change_type, source_version_id, snapshot)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(song.id, actor.id, actor.username, new Date().toISOString(), changeType, sourceVersionId, JSON.stringify(snapshot));
}

function broadcastSongToLiveGroups(orgId, song) {
  const orgDb = getOrgDb(orgId);
  if (!orgDb) return;
  for (const group of orgDb.prepare('SELECT id FROM groups').all()) {
    const state = getLiveState(orgId, group.id);
    if (!state.currentSong || state.currentSong.id !== Number(song.id)) continue;
    state.currentSong.song_number = song.song_number;
    state.currentSong.title = song.title;
    state.currentSong.alternate_title = song.alternate_title;
    state.currentSong.chord = song.chord;
    state.currentSong.language = song.language;
    state.currentSong.slides = parseLyricsIntoSlides(song.lyrics, song.transliteration, state.fontSize, state.displayWidth, state.displayHeight, state.displayContentWidth, state.displayContentHeight, state.displayCharWidthRatio, state.displayFitScale);
    state.activeSlideIndex = Math.min(state.activeSlideIndex, Math.max(0, state.currentSong.slides.length - 1));
    broadcastState(orgId, group.id);
  }
}

// --- REST API ENDPOINTS ---

// Auth Endpoints
app.post('/api/auth/login', (req, res) => {
  const { username, password, organizationSlug } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required' });
  }

  const user = masterDb.prepare(`
    SELECT id, username, email, password, permission, verified 
    FROM users 
    WHERE lower(username) = lower(?) OR lower(email) = lower(?)
  `).get(username.trim(), username.trim());

  if (!user || !passwordMatches(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!user.password.startsWith('scrypt$')) masterDb.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), user.id);

  const token = createSession(user);
  const session = sessions.get(token);
  const orgs = organizationsForUser({ id: user.id, isMasterAdmin: user.permission >= 2 });
  if (organizationSlug) {
    const selectedOrg = masterDb.prepare('SELECT id FROM organizations WHERE slug = ?').get(String(organizationSlug));
    const hasAccess = selectedOrg && (user.permission >= 2 || orgRoleFor(user.id, selectedOrg.id));
    if (!hasAccess) {
      sessions.delete(token);
      return res.status(403).json({ error: 'This account does not belong to that organisation.' });
    }
    session.organizationId = selectedOrg.id;
    const selectedGroups = groupsForUser({ id: user.id, isMasterAdmin: user.permission >= 2 }, selectedOrg.id);
    session.groupId = selectedGroups[0]?.id || null;
  }
  const groups = session.organizationId ? groupsForUser({ id: user.id, isMasterAdmin: user.permission >= 2 }, session.organizationId) : [];

  res.cookie('session_token', token, {
    httpOnly: true,
    maxAge: SESSION_TTL,
    sameSite: 'lax',
    path: '/'
  });

  res.json({
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      isMasterAdmin: user.permission >= 2,
      organizations: orgs,
      activeOrganizationId: session.organizationId,
      groups,
      activeGroupId: session.groupId
    }
  });
});

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Username, valid email, and password of at least 6 characters are required.' });
  }

  try {
    const hash = hashPassword(password);
    const result = masterDb.prepare(`
      INSERT INTO users (username, email, password, permission, verified)
      VALUES (?, ?, ?, 0, 1)
    `).run(String(username).trim(), String(email).trim().toLowerCase(), hash);

    const newUser = masterDb.prepare('SELECT id, username, email, permission FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
    const token = createSession(newUser);
    const session = sessions.get(token);

    res.cookie('session_token', token, {
      httpOnly: true,
      maxAge: SESSION_TTL,
      sameSite: 'lax',
      path: '/'
    });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        isMasterAdmin: false,
        organizations: [],
        activeOrganizationId: null,
        groups: [],
        activeGroupId: null
      }
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username or email is already registered.' });
    }
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/register-organization', (req, res) => {
  const { organizationName, username, email, password, logoData, brandColor, welcomeText } = req.body;
  const cleanOrgName = typeof organizationName === 'string' ? organizationName.trim() : '';
  const cleanUsername = typeof username === 'string' ? username.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!cleanOrgName) {
    return res.status(400).json({ error: 'Organisation name is required.' });
  }
  if (!cleanUsername || !cleanEmail || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Username, valid email, and password of at least 6 characters are required.' });
  }

  const existingUser = masterDb.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(cleanUsername, cleanEmail);
  if (existingUser) {
    return res.status(409).json({ error: 'That username or email is already in use.' });
  }

  const existingOrg = masterDb.prepare('SELECT id FROM organizations WHERE lower(name) = lower(?)').get(cleanOrgName);
  if (existingOrg) {
    return res.status(409).json({ error: 'An organisation with that name already exists.' });
  }

  try {
    const hash = hashPassword(password);
    const userResult = masterDb.prepare(`
      INSERT INTO users (username, email, password, permission, verified)
      VALUES (?, ?, ?, 0, 1)
    `).run(cleanUsername, cleanEmail, hash);

    const newUserId = Number(userResult.lastInsertRowid);
    const createdOrg = createOrganization({
      name: cleanOrgName,
      createdBy: newUserId
    });

    const cleanLogoData = typeof logoData === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(logoData) && logoData.length <= 1400000
      ? logoData : null;
    const cleanBrandColor = /^#[0-9a-fA-F]{6}$/.test(String(brandColor || '')) ? brandColor : '#2563eb';
    const cleanWelcomeText = String(welcomeText || '').trim().slice(0, 180) || null;
    masterDb.prepare('UPDATE organizations SET logo_data = ?, brand_color = ?, welcome_text = ? WHERE id = ?')
      .run(cleanLogoData, cleanBrandColor, cleanWelcomeText, createdOrg.id);

    const orgDb = createdOrg.orgDb;
    const groupResult = orgDb.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run('Main Service', newUserId);
    const newGroupId = Number(groupResult.lastInsertRowid);

    orgDb.prepare(`
      INSERT INTO group_memberships (group_id, user_id, role, can_display, can_add_songs, can_edit_songs, added_by)
      VALUES (?, ?, 'group_admin', 1, 1, 1, ?)
    `).run(newGroupId, newUserId, newUserId);

    const userObj = {
      id: newUserId,
      username: cleanUsername,
      email: cleanEmail,
      permission: 0
    };

    const token = createSession(userObj);
    const session = sessions.get(token);
    session.organizationId = createdOrg.id;
    session.groupId = newGroupId;

    res.cookie('session_token', token, {
      httpOnly: true,
      maxAge: SESSION_TTL,
      sameSite: 'lax',
      path: '/'
    });

    res.status(201).json({
      message: 'Organisation registered successfully',
      token,
      user: {
        id: newUserId,
        username: cleanUsername,
        email: cleanEmail,
        isMasterAdmin: false,
        organizations: organizationsForUser({ id: newUserId, isMasterAdmin: false }),
        activeOrganization: masterDb.prepare('SELECT id, name, slug, logo_data AS logoData, brand_color AS brandColor, welcome_text AS welcomeText FROM organizations WHERE id = ?').get(createdOrg.id),
        activeOrganizationId: createdOrg.id,
        activeGroupId: newGroupId
      }
    });
  } catch (err) {
    console.error('Organisation registration error:', err);
    res.status(500).json({ error: err.message || 'Could not register organisation.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const orgs = organizationsForUser(req.user);
  if (!req.orgId && orgs.length > 0) {
    req.session.organizationId = orgs[0].id;
    req.orgId = orgs[0].id;
    req.orgDb = getOrgDb(orgs[0].id);
  }

  const groups = req.orgId ? groupsForUser(req.user, req.orgId) : [];
  if (!req.groupId && groups.length > 0) {
    req.session.groupId = groups[0].id;
    req.groupId = groups[0].id;
    req.groupMembership = groupMembershipFor(req.user.id, req.orgId, req.groupId);
  }

  const currentOrg = orgs.find(o => o.id === req.orgId) || null;

  res.json({
    user: {
      ...req.user,
      organizations: orgs,
      activeOrganizationId: req.orgId,
      activeOrganization: currentOrg,
      groups,
      activeGroupId: req.groupId,
      activeGroup: req.groupMembership,
      isOrgAdmin: req.isOrgAdmin
    }
  });
});

app.post('/api/auth/select-organization', requireAuth, (req, res) => {
  const orgId = Number(req.body.organizationId);
  const org = masterDb.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const role = orgRoleFor(req.user.id, orgId);
  if (!req.user.isMasterAdmin && !role) {
    return res.status(403).json({ error: 'You are not a member of this organization' });
  }

  req.session.organizationId = orgId;
  const groups = groupsForUser(req.user, orgId);
  req.session.groupId = groups[0] ? groups[0].id : null;

  res.json({
    activeOrganizationId: orgId,
    activeGroupId: req.session.groupId,
    groups
  });
});

app.post('/api/auth/select-group', requireAuth, (req, res) => {
  const groupId = Number(req.body.groupId);
  if (!req.orgDb) return res.status(400).json({ error: 'Select an organization first' });

  const group = req.orgDb.prepare('SELECT id, name FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found in this organization.' });

  const membership = groupMembershipFor(req.user.id, req.orgId, groupId);
  if (!req.isOrgAdmin && !membership) {
    return res.status(403).json({ error: 'You are not a member of that group.' });
  }

  req.session.groupId = groupId;
  res.json({ activeGroupId: groupId, group });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.token) sessions.delete(req.token);
  res.clearCookie('session_token');
  res.json({ message: 'Logged out successfully' });
});

// --- ORGANIZATIONS ENDPOINTS ---

app.get('/api/organization-brand', (req, res) => {
  let org;
  if (req.query.slug) {
    org = masterDb.prepare('SELECT name, slug, logo_data AS logoData, brand_color AS brandColor, welcome_text AS welcomeText FROM organizations WHERE slug = ?').get(String(req.query.slug));
  } else if (req.query.id && Number.isInteger(Number(req.query.id))) {
    org = masterDb.prepare('SELECT name, slug, logo_data AS logoData, brand_color AS brandColor, welcome_text AS welcomeText FROM organizations WHERE id = ?').get(Number(req.query.id));
  }
  if (!org) return res.status(404).json({ error: 'Organisation not found.' });
  res.json({ organization: org });
});

app.put('/api/organizations/:id/settings', requireAuth, (req, res) => {
  const orgId = Number(req.params.id);
  const org = masterDb.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organisation not found.' });

  const orgRole = orgRoleFor(req.user.id, orgId);
  const canManage = req.user.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';
  if (!canManage) return res.status(403).json({ error: 'Organisation admin access required.' });

  const name = String(req.body.name || '').trim();
  const brandColor = String(req.body.brandColor || '');
  const welcomeText = String(req.body.welcomeText || '').trim().slice(0, 180) || null;
  const logoData = req.body.logoData === undefined ? undefined : req.body.logoData;
  if (!name) return res.status(400).json({ error: 'Organisation name is required.' });
  if (!/^#[0-9a-fA-F]{6}$/.test(brandColor)) return res.status(400).json({ error: 'Choose a valid brand colour.' });
  if (logoData !== undefined && logoData !== null && (typeof logoData !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(logoData) || logoData.length > 1400000)) {
    return res.status(400).json({ error: 'Choose a valid image smaller than 1 MB.' });
  }

  try {
    const duplicate = masterDb.prepare('SELECT id FROM organizations WHERE lower(name) = lower(?) AND id <> ?').get(name, orgId);
    if (duplicate) return res.status(409).json({ error: 'An organisation with that name already exists.' });
    if (logoData === undefined) {
      masterDb.prepare('UPDATE organizations SET name = ?, brand_color = ?, welcome_text = ? WHERE id = ?').run(name, brandColor, welcomeText, orgId);
    } else {
      masterDb.prepare('UPDATE organizations SET name = ?, logo_data = ?, brand_color = ?, welcome_text = ? WHERE id = ?').run(name, logoData, brandColor, welcomeText, orgId);
    }
    const organization = masterDb.prepare('SELECT id, name, slug, logo_data AS logoData, brand_color AS brandColor, welcome_text AS welcomeText FROM organizations WHERE id = ?').get(orgId);
    const orgDb = getOrgDb(orgId);
    if (orgDb) orgDb.prepare('UPDATE organization_info SET name = ? WHERE id = 1').run(name);
    res.json({ organization });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'An organisation with that name already exists.' });
    res.status(500).json({ error: 'Could not update organisation settings.' });
  }
});

app.get('/api/organizations', requireAuth, (req, res) => {
  const orgs = organizationsForUser(req.user);
  res.json({ organizations: orgs });
});

app.post('/api/organizations', requireAuth, (req, res) => {
  const { name, slug } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Organization name is required.' });

  try {
    const created = createOrganization({
      name: name.trim(),
      slug: slug ? slug.trim() : null,
      createdBy: req.user.id
    });

    // Auto-select newly created organization in session
    req.session.organizationId = created.id;
    req.session.groupId = null;

    res.status(201).json({
      message: 'Organization created successfully',
      organization: { id: created.id, name: created.name, slug: created.slug }
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not create organization.' });
  }
});

// Organization Dashboard Overview (for Admin homepage view)
app.get('/api/organizations/:id/overview', requireAuth, (req, res) => {
  const orgId = Number(req.params.id);
  const org = masterDb.prepare('SELECT id, name, slug, created_at FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const orgRole = orgRoleFor(req.user.id, orgId);
  const isOrgAdmin = req.user.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';
  if (!isOrgAdmin) {
    return res.status(403).json({ error: 'Organization admin access required' });
  }

  const orgDb = getOrgDb(orgId);
  if (!orgDb) return res.status(500).json({ error: 'Could not connect to organization database' });

  const songCount = orgDb.prepare('SELECT count(*) AS count FROM songs').get().count;
  const groups = orgDb.prepare('SELECT id, name, created_at FROM groups ORDER BY name').all().map(g => {
    const memberCount = orgDb.prepare('SELECT count(*) AS count FROM group_memberships WHERE group_id = ?').get(g.id).count;
    return { ...g, memberCount };
  });

  const totalMembers = masterDb.prepare(`
    SELECT count(DISTINCT user_id) AS count FROM user_organizations WHERE organization_id = ?
  `).get(orgId).count;

  res.json({
    organization: org,
    stats: {
      songCount,
      groupCount: groups.length,
      memberCount: totalMembers
    },
    groups
  });
});

// --- MASTER SONGS DB ENDPOINTS ---

app.get('/api/master-songs', requireAuth, (req, res) => {
  const { q = '', language = '', page = 1, limit = 50 } = req.query;
  const searchTerm = String(q).trim();

  let query = 'SELECT id, title, alternate_title, chord, language, youtube_link, tags, created_at FROM master_songs';
  const params = [];
  const conditions = [];

  if (searchTerm) {
    const isNum = /^\d+$/.test(searchTerm);
    if (isNum) {
      conditions.push('(id = ? OR alternate_title LIKE ?)');
      params.push(Number(searchTerm), `%${searchTerm}%`);
    } else {
      conditions.push('(title LIKE ? OR alternate_title LIKE ? OR lyrics LIKE ? OR search_title LIKE ? OR search_lyrics LIKE ?)');
      const wild = `%${searchTerm}%`;
      params.push(wild, wild, wild, wild, wild);
    }
  }

  if (language) {
    conditions.push('language = ?');
    params.push(language);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY title COLLATE NOCASE ASC, id ASC LIMIT ? OFFSET ?';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  params.push(pageSize, (pageNum - 1) * pageSize);

  const songs = masterDb.prepare(query).all(...params);
  const totalCount = masterDb.prepare('SELECT count(*) as count FROM master_songs').get().count;

  res.json({ songs, total: totalCount, page: pageNum, limit: pageSize });
});

app.get('/api/master-songs/:id', requireAuth, (req, res) => {
  const song = masterDb.prepare('SELECT * FROM master_songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).json({ error: 'Master song not found' });
  res.json({ song });
});

app.post('/api/master-songs', requireAuth, (req, res) => {
  if (!req.user.isMasterAdmin && !req.isOrgAdmin) {
    return res.status(403).json({ error: 'Only admins can add songs directly to the Master Songs DB' });
  }

  const { title, alternate_title, lyrics, transliteration, chord, language, youtube_link, tags } = req.body;
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanLyrics = typeof lyrics === 'string' ? lyrics.trim() : '';
  if (!cleanTitle) return res.status(400).json({ error: 'Song title is required' });

  const songCategory = resolveSongCategory({ title: cleanTitle, alternate_title, language, tags });
  if (language && !SONG_LANGUAGES.has(String(language).trim())) {
    return res.status(400).json({ error: 'Choose a valid song language/category.' });
  }
  const searchTitle = `${cleanTitle} ${alternate_title || ''}`.toLowerCase();
  const searchLyrics = cleanLyrics.toLowerCase();

  const result = masterDb.prepare(`
    INSERT INTO master_songs (
      title, alternate_title, lyrics, transliteration, chord, language,
      search_title, search_lyrics, youtube_link, tags, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanTitle,
    alternate_title ? String(alternate_title).trim() : null,
    cleanLyrics,
    transliteration ? String(transliteration).trim() : null,
    chord ? String(chord).trim() : null,
    songCategory,
    searchTitle,
    searchLyrics,
    youtube_link || null,
    tags || null,
    req.user.id
  );

  const id = Number(result.lastInsertRowid);
  res.status(201).json({ message: 'Master song created', id });
});

// Import song from Master DB into Organization Songbook
app.post('/api/organizations/:orgId/songbook/import', requireAuth, (req, res) => {
  const orgId = Number(req.params.orgId);
  const orgRole = orgRoleFor(req.user.id, orgId);
  const isOrgAdmin = req.user.isMasterAdmin || orgRole?.role === 'org_owner' || orgRole?.role === 'org_admin';
  if (!isOrgAdmin) {
    return res.status(403).json({ error: 'Organization admin privileges required to add songs to songbook' });
  }

  const { masterSongId, language, songbookTag } = req.body;
  if (!masterSongId) return res.status(400).json({ error: 'masterSongId is required' });

  try {
    const importedSong = importMasterSongToOrg(orgId, {
      masterSongId,
      language,
      songbookTag,
      userId: req.user.id,
      username: req.user.username
    });
    res.status(201).json({ message: 'Song added to organization songbook', song: importedSong });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not import song' });
  }
});

// Shortcut import to current active organization's songbook
app.post('/api/songbook/import', requireAuth, requireOrg, (req, res) => {
  const canAddToSongbook = req.isOrgAdmin || Boolean(req.groupMembership && (req.groupMembership.role === 'group_admin' || req.groupMembership.can_add_songs));
  if (!canAddToSongbook) return res.status(403).json({ error: 'Your membership does not grant permission to add songs.' });
  const { masterSongId, language, songbookTag } = req.body;
  if (!masterSongId) return res.status(400).json({ error: 'masterSongId is required' });

  try {
    const importedSong = importMasterSongToOrg(req.orgId, {
      masterSongId,
      language,
      songbookTag,
      userId: req.user.id,
      username: req.user.username
    });
    res.status(201).json({ message: 'Song added to songbook', song: importedSong });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not import song' });
  }
});

// Next available song number for the active organization's songbook
app.get('/api/songbook/next-song-number', requireAuth, requireOrg, (req, res) => {
  const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
  try {
    const normalizedTag = resolveSongbookTag(req.orgDb, tag);
    const nextNum = getNextOrgSongNumber(req.orgDb, normalizedTag);
    res.json({ nextSongNumber: nextNum, tag: normalizedTag });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/songbook/tags', requireAuth, requireOrg, (req, res) => {
  res.json({ tags: getSongbookTags(req.orgDb) });
});

app.post('/api/songbook/tags', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 40) return res.status(400).json({ error: 'Enter a tag name up to 40 characters.' });
  try {
    req.orgDb.prepare('INSERT INTO songbook_tags (name) VALUES (?)').run(name);
    res.status(201).json({ message: 'Songbook tag added.', tags: getSongbookTags(req.orgDb) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That tag already exists.' });
    res.status(500).json({ error: 'Could not add songbook tag.' });
  }
});

// --- ORGANIZATION SONGBOOK ENDPOINTS (/api/songs) ---

app.get('/api/songs', requireAuth, requireOrg, (req, res) => {
  const { q = '', language = '', tag = '' } = req.query;
  const searchTerm = String(q).trim();

  let query = 'SELECT id, master_song_id, song_number, title, alternate_title, chord, language, songbook_tag, tags, youtube_link, is_custom, created_at FROM songs';
  const params = [];
  const conditions = [];

  if (searchTerm) {
    const isNum = /^\d+$/.test(searchTerm);
    if (isNum) {
      conditions.push('(song_number = ? OR id = ? OR alternate_title LIKE ?)');
      params.push(searchTerm, Number(searchTerm), `%${searchTerm}%`);
    } else {
      conditions.push('(song_number LIKE ? OR title LIKE ? OR alternate_title LIKE ? OR lyrics LIKE ? OR search_title LIKE ? OR search_lyrics LIKE ?)');
      const wild = `%${searchTerm}%`;
      params.push(wild, wild, wild, wild, wild, wild);
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  // Keep songbook lists alphabetical; song numbers remain visible as metadata.
  query += ' ORDER BY title COLLATE NOCASE ASC, id ASC';

  let songs = req.orgDb.prepare(query).all(...params);
  if (tag) songs = songs.filter(song => String(song.songbook_tag || resolveSongCategory(song)).toLowerCase() === String(tag).trim().toLowerCase());
  if (language) songs = songs.filter(song => resolveSongCategory(song) === language);
  res.json({ songs, total: songs.length });
});

app.get('/api/songs/:id', requireAuth, requireOrg, (req, res) => {
  const song = req.orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song) {
    return res.status(404).json({ error: 'Song not found in organization songbook' });
  }

  const liveState = req.groupId ? getLiveState(req.orgId, req.groupId) : DEFAULT_LIVE_STATE;
  const slides = parseLyricsIntoSlides(song.lyrics, song.transliteration, liveState.fontSize, liveState.displayWidth, liveState.displayHeight, liveState.displayContentWidth, liveState.displayContentHeight, liveState.displayCharWidthRatio, liveState.displayFitScale);

  res.json({
    song: {
      ...song,
      slides
    }
  });
});

app.post('/api/songs', requireAuth, requireOrg, requireGroup, requireGroupPermission('can_add_songs'), (req, res) => {
  const { alternate_title, transliteration, chord } = req.body;
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const language = typeof req.body.language === 'string' ? req.body.language.trim() : '';
  const requestedTag = typeof req.body.songbook_tag === 'string' ? req.body.songbook_tag.trim() : '';
  const lyrics = typeof req.body.lyrics === 'string' ? req.body.lyrics.trim() : '';
  const rawAlternateTitle = typeof alternate_title === 'string' ? alternate_title.trim() : '';
  const alternateTitle = /^\d+$/.test(rawAlternateTitle) ? '' : rawAlternateTitle;
  const transliterationText = typeof transliteration === 'string' ? transliteration.trim() : '';
  const chordText = typeof chord === 'string' ? chord.trim() : '';

  if (!title || !SONG_LANGUAGES.has(language)) {
    return res.status(400).json({ error: 'Song title and a valid language are required' });
  }

  let songbookTag;
  try { songbookTag = resolveSongbookTag(req.orgDb, requestedTag); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const songNumber = getNextOrgSongNumber(req.orgDb, songbookTag);
  const now = new Date().toISOString();
  const searchTitle = `${songNumber} ${title} ${alternateTitle}`.toLowerCase();
  const searchLyrics = lyrics.toLowerCase();

  const info = req.orgDb.prepare(`
    INSERT INTO songs (
      song_number, title, alternate_title, lyrics, transliteration, chord, language, songbook_tag,
      search_title, search_lyrics, youtube_link, is_custom, added_by, created_at, modified_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    songNumber,
    title,
    alternateTitle || null,
    lyrics,
    transliterationText || null,
    chordText || null,
    language,
    songbookTag,
    searchTitle,
    searchLyrics,
    null,
    req.user.id,
    now,
    now
  );

  const created = req.orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(Number(info.lastInsertRowid));
  recordSongVersion(req.orgDb, created, req.user, 'create');

  res.status(201).json({ message: 'Song added to songbook', id: info.lastInsertRowid, song: created });
});

app.put('/api/songs/:id', requireAuth, requireOrg, requireGroup, requireGroupPermission('can_edit_songs'), (req, res) => {
  const { alternate_title, transliteration, chord } = req.body;
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const language = typeof req.body.language === 'string' ? req.body.language.trim() : '';
  const requestedTag = typeof req.body.songbook_tag === 'string' ? req.body.songbook_tag.trim() : '';
  const lyrics = typeof req.body.lyrics === 'string' ? req.body.lyrics.trim() : '';
  const rawAlternateTitle = typeof alternate_title === 'string' ? alternate_title.trim() : '';
  const alternateTitle = /^\d+$/.test(rawAlternateTitle) ? '' : rawAlternateTitle;
  const transliterationText = typeof transliteration === 'string' ? transliteration.trim() : '';
  const chordText = typeof chord === 'string' ? chord.trim() : '';

  if (!title || !SONG_LANGUAGES.has(language)) {
    return res.status(400).json({ error: 'Song title and a valid language are required' });
  }

  const now = new Date().toISOString();
  const existing = req.orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Song not found' });

  let songbookTag;
  try { songbookTag = resolveSongbookTag(req.orgDb, requestedTag); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const existingTag = existing.songbook_tag || resolveSongCategory(existing);
  const songNumber = existingTag.toLowerCase() === songbookTag.toLowerCase() ? existing.song_number : getNextOrgSongNumber(req.orgDb, songbookTag);
  const searchTitle = `${songNumber} ${title} ${alternateTitle}`.toLowerCase();
  const searchLyrics = lyrics.toLowerCase();

  if (!req.orgDb.prepare('SELECT id FROM song_versions WHERE song_id = ? LIMIT 1').get(existing.id)) {
    recordSongVersion(req.orgDb, existing, req.user, 'baseline');
  }

  const info = req.orgDb.prepare(`
    UPDATE songs
    SET song_number = ?, title = ?, alternate_title = ?, lyrics = ?, transliteration = ?, chord = ?, language = ?, songbook_tag = ?,
        search_title = ?, search_lyrics = ?, modified_at = ?
    WHERE id = ?
  `).run(
    songNumber,
    title,
    alternateTitle || null,
    lyrics,
    transliterationText || null,
    chordText || null,
    language,
    songbookTag,
    searchTitle,
    searchLyrics,
    now,
    req.params.id
  );

  if (info.changes === 0) return res.status(404).json({ error: 'Song not found' });

  const revised = req.orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  recordSongVersion(req.orgDb, revised, req.user, 'edit');
  broadcastSongToLiveGroups(req.orgId, revised);

  res.json({ message: 'Song updated successfully', song: revised });
});

app.delete('/api/songs/:id', requireAuth, requireOrg, (req, res) => {
  if (!req.isOrgAdmin) {
    return res.status(403).json({ error: 'Forbidden. Organization admin privileges required to delete a song.' });
  }

  const info = req.orgDb.prepare('DELETE FROM songs WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Song not found' });

  for (const group of req.orgDb.prepare('SELECT id FROM groups').all()) {
    const state = getLiveState(req.orgId, group.id);
    if (state.currentSong && state.currentSong.id === Number(req.params.id)) {
      state.currentSong = null;
      state.activeSlideIndex = 0;
      state.isBlank = false;
      state.isClear = false;
      broadcastState(req.orgId, group.id);
    }
  }

  res.json({ message: 'Song deleted successfully from organization songbook' });
});

app.get('/api/songs/:id/versions', requireAuth, requireOrg, (req, res) => {
  if (!req.orgDb.prepare('SELECT id FROM songs WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Song not found' });
  }
  const versions = req.orgDb.prepare(`SELECT id, actor_user_id AS actorUserId, actor_username AS actorUsername,
      changed_at AS changedAt, change_type AS changeType, source_version_id AS sourceVersionId, snapshot
      FROM song_versions WHERE song_id = ? ORDER BY id DESC`).all(req.params.id)
    .map(version => ({ ...version, snapshot: JSON.parse(version.snapshot) }));
  res.json({ versions });
});

app.post('/api/songs/:id/versions/:versionId/rollback', requireAuth, requireOrg, requireGroup, requireGroupPermission('can_edit_songs'), (req, res) => {
  const song = req.orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  const version = req.orgDb.prepare('SELECT * FROM song_versions WHERE id = ? AND song_id = ?').get(req.params.versionId, req.params.id);
  if (!song || !version) return res.status(404).json({ error: 'Song version not found' });

  const snapshot = JSON.parse(version.snapshot);
  const values = VERSION_FIELDS.map(field => snapshot[field] ?? null);
  const now = new Date().toISOString();

  req.orgDb.prepare(`UPDATE songs SET song_number = ?, title = ?, alternate_title = ?, lyrics = ?, transliteration = ?, chord = ?, language = ?, songbook_tag = ?,
      youtube_link = ?, search_title = ?, search_lyrics = ?, modified_at = ? WHERE id = ?`)
    .run(...values, `${snapshot.song_number || ''} ${snapshot.title || ''} ${snapshot.alternate_title || ''}`.toLowerCase(), String(snapshot.lyrics || '').toLowerCase(), now, song.id);

  const restored = req.orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(song.id);
  recordSongVersion(req.orgDb, restored, req.user, 'rollback', version.id);
  broadcastSongToLiveGroups(req.orgId, restored);

  res.json({ message: 'Song restored. Rollback recorded as a new version.' });
});

// --- GROUP-LEVEL SONGBOOK CURATION ---

app.get('/api/groups/:groupId/songbook', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId);
  const songs = req.orgDb.prepare(`
    SELECT s.id, s.song_number, s.title, s.alternate_title, s.chord, s.language, gs.custom_order
    FROM group_songbooks gs
    JOIN songs s ON s.id = gs.song_id
    WHERE gs.group_id = ?
    ORDER BY gs.custom_order ASC, s.song_number ASC
  `).all(groupId);
  res.json({ songs });
});

app.post('/api/groups/:groupId/songbook/:songId', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId);
  const songId = Number(req.params.songId);
  const membership = groupMembershipFor(req.user.id, req.orgId, groupId);

  if (!req.isOrgAdmin && (!membership || !(membership.role === 'group_admin' || membership.can_add_songs))) {
    return res.status(403).json({ error: 'Permission denied to modify group songbook' });
  }

  try {
    req.orgDb.prepare(`
      INSERT INTO group_songbooks (group_id, song_id, added_by)
      VALUES (?, ?, ?)
    `).run(groupId, songId, req.user.id);
    res.status(201).json({ message: 'Song pinned to group songbook' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Song is already in this group’s songbook' });
    }
    res.status(500).json({ error: 'Could not pin song' });
  }
});

app.delete('/api/groups/:groupId/songbook/:songId', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId);
  const songId = Number(req.params.songId);
  const membership = groupMembershipFor(req.user.id, req.orgId, groupId);

  if (!req.isOrgAdmin && (!membership || !(membership.role === 'group_admin' || membership.can_edit_songs))) {
    return res.status(403).json({ error: 'Permission denied to modify group songbook' });
  }

  req.orgDb.prepare('DELETE FROM group_songbooks WHERE group_id = ? AND song_id = ?').run(groupId, songId);
  res.json({ message: 'Song removed from group songbook' });
});

// --- GROUPS & GROUP MEMBERS MANAGEMENT ---

app.get('/api/groups', requireAuth, requireOrg, (req, res) => {
  const groups = req.isOrgAdmin
    ? req.orgDb.prepare('SELECT id, name, NULL AS role, 1 AS canDisplay, 1 AS canAddSongs, 1 AS canEditSongs FROM groups ORDER BY name').all()
    : req.orgDb.prepare(`SELECT g.id, g.name, gm.role,
        gm.can_display AS canDisplay, gm.can_add_songs AS canAddSongs, gm.can_edit_songs AS canEditSongs
        FROM groups g JOIN group_memberships gm ON gm.group_id = g.id WHERE gm.user_id = ? ORDER BY g.name`).all(req.user.id);
  res.json({ groups });
});

app.post('/api/groups', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Enter a group name up to 80 characters.' });
  try {
    const result = req.orgDb.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run(name, req.user.id);
    const id = Number(result.lastInsertRowid);
    res.status(201).json({ group: { id, name } });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'A group with that name already exists in this organization.' });
    res.status(500).json({ error: 'Could not create group.' });
  }
});

app.put('/api/groups/:groupId', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId < 1) return res.status(400).json({ error: 'Invalid group.' });
  const group = req.orgDb.prepare('SELECT id, name FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const name = req.body.name === undefined ? group.name : typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Enter a group name up to 80 characters.' });
  try {
    req.orgDb.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, groupId);
    res.json({ message: 'Group name updated.', group: { id: groupId, name } });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'A group with that name already exists in this organization.' });
    res.status(500).json({ error: 'Could not rename group.' });
  }
});

app.delete('/api/groups/:groupId', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId < 1) return res.status(400).json({ error: 'Invalid group.' });
  const group = req.orgDb.prepare('SELECT id, name FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  try {
    req.orgDb.exec('BEGIN IMMEDIATE');
    // Remove dependent rows explicitly so deletion also works if an older org DB
    // was created without SQLite foreign-key cascading enabled.
    req.orgDb.prepare('DELETE FROM group_songbooks WHERE group_id = ?').run(groupId);
    req.orgDb.prepare('DELETE FROM group_live_states WHERE group_id = ?').run(groupId);
    req.orgDb.prepare('DELETE FROM group_memberships WHERE group_id = ?').run(groupId);
    req.orgDb.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    req.orgDb.exec('COMMIT');
    const fallbackGroup = req.orgDb.prepare('SELECT id FROM groups ORDER BY name COLLATE NOCASE, id LIMIT 1').get();
    for (const session of sessions.values()) {
      if (Number(session.organizationId) === Number(req.orgId) && Number(session.groupId) === groupId) {
        session.groupId = fallbackGroup?.id || null;
      }
    }
    res.json({ message: 'Group deleted.', groupId, fallbackGroupId: fallbackGroup?.id || null });
  } catch (err) {
    try { req.orgDb.exec('ROLLBACK'); } catch {}
    console.error(`Could not delete group ${groupId} from organisation ${req.orgId}:`, err);
    res.status(500).json({ error: `Could not delete group: ${err.message || 'database error'}` });
  }
});

app.get('/api/groups/:groupId/members', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId);
  const ownMembership = groupMembershipFor(req.user.id, req.orgId, groupId);
  if (!req.isOrgAdmin && (!ownMembership || ownMembership.role !== 'group_admin')) {
    return res.status(403).json({ error: 'Group admin access required.' });
  }

  // Get memberships from orgDb and user details from masterDb
  const groupRows = req.orgDb.prepare(`
    SELECT user_id, role, can_display AS canDisplay, can_add_songs AS canAddSongs, can_edit_songs AS canEditSongs
    FROM group_memberships WHERE group_id = ?
  `).all(groupId);

  const members = groupRows.map(row => {
    const user = masterDb.prepare('SELECT id, username, email FROM users WHERE id = ?').get(row.user_id) || { id: row.user_id, username: 'Unknown', email: '' };
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: row.role,
      canDisplay: row.canDisplay,
      canAddSongs: row.canAddSongs,
      canEditSongs: row.canEditSongs
    };
  });

  res.json({ members });
});

app.post('/api/groups/:groupId/members', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId);
  const ownMembership = groupMembershipFor(req.user.id, req.orgId, groupId);
  if (!req.isOrgAdmin && (!ownMembership || ownMembership.role !== 'group_admin')) {
    return res.status(403).json({ error: 'Group admin access required.' });
  }
  const group = req.orgDb.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  let target = req.body.userId ? masterDb.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.body.userId)) : null;
  if (!target && req.body.email) target = masterDb.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(req.body.email).trim());

  if (!target) {
    const { username, email, password } = req.body;
    if (!username || !email || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'New accounts need a username, email, and password of at least 6 characters.' });
    }
    try {
      const hash = hashPassword(password);
      const created = masterDb.prepare('INSERT INTO users (username, email, password, verified) VALUES (?, ?, ?, 1)').run(String(username).trim(), String(email).trim().toLowerCase(), hash);
      target = masterDb.prepare('SELECT * FROM users WHERE id = ?').get(Number(created.lastInsertRowid));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That username or email is already in use.' });
      return res.status(500).json({ error: 'Could not create account.' });
    }
  }

  // Ensure user is registered in organization
  masterDb.prepare(`
    INSERT OR IGNORE INTO user_organizations (user_id, organization_id, role)
    VALUES (?, ?, 'member')
  `).run(target.id, req.orgId);

  const role = req.isOrgAdmin && req.body.role === 'group_admin' ? 'group_admin' : 'member';
  try {
    req.orgDb.prepare(`INSERT INTO group_memberships (group_id, user_id, role, can_display, can_add_songs, can_edit_songs, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(groupId, target.id, role, role === 'group_admin' || req.body.canDisplay ? 1 : 0,
      role === 'group_admin' || req.body.canAddSongs ? 1 : 0, role === 'group_admin' || req.body.canEditSongs ? 1 : 0, req.user.id);
    res.status(201).json({ message: 'Member added to group.' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'This account is already a member of the group.' });
    res.status(500).json({ error: 'Could not add member.' });
  }
});

app.put('/api/groups/:groupId/members/:userId', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId), userId = Number(req.params.userId);
  const ownMembership = groupMembershipFor(req.user.id, req.orgId, groupId), target = groupMembershipFor(userId, req.orgId, groupId);
  if (!req.isOrgAdmin && (!ownMembership || ownMembership.role !== 'group_admin')) return res.status(403).json({ error: 'Group admin access required.' });
  if (!target) return res.status(404).json({ error: 'Member not found in this group.' });
  if (!req.isOrgAdmin && target.role === 'group_admin') return res.status(403).json({ error: 'Only an admin can change a group admin account.' });

  const role = req.isOrgAdmin ? (req.body.role === 'group_admin' ? 'group_admin' : 'member') : target.role;
  if (target.role === 'group_admin' && role !== target.role && req.orgDb.prepare(`SELECT COUNT(*) AS count FROM group_memberships WHERE group_id = ? AND role = 'group_admin'`).get(groupId).count <= 1) {
    return res.status(400).json({ error: 'A group must keep at least one group admin.' });
  }

  req.orgDb.prepare(`UPDATE group_memberships SET role = ?, can_display = ?, can_add_songs = ?, can_edit_songs = ? WHERE group_id = ? AND user_id = ?`)
    .run(role, role === 'group_admin' || req.body.canDisplay ? 1 : 0,
      role === 'group_admin' || req.body.canAddSongs ? 1 : 0,
      role === 'group_admin' || req.body.canEditSongs ? 1 : 0, groupId, userId);
  res.json({ message: 'Group permissions updated.' });
});

app.delete('/api/groups/:groupId/members/:userId', requireAuth, requireOrg, (req, res) => {
  const groupId = Number(req.params.groupId), userId = Number(req.params.userId);
  const ownMembership = groupMembershipFor(req.user.id, req.orgId, groupId), target = groupMembershipFor(userId, req.orgId, groupId);
  if (!req.isOrgAdmin && (!ownMembership || ownMembership.role !== 'group_admin')) return res.status(403).json({ error: 'Group admin access required.' });
  if (!target) return res.status(404).json({ error: 'Member not found in this group.' });
  if (!req.isOrgAdmin && target.role === 'group_admin') return res.status(403).json({ error: 'Only an admin can remove a group admin.' });
  if (target.role === 'group_admin' && req.orgDb.prepare(`SELECT COUNT(*) AS count FROM group_memberships WHERE group_id = ? AND role = 'group_admin'`).get(groupId).count <= 1) {
    return res.status(400).json({ error: 'A group must keep at least one group admin.' });
  }

  req.orgDb.prepare('DELETE FROM group_memberships WHERE group_id = ? AND user_id = ?').run(groupId, userId);
  res.json({ message: 'Member removed from group.' });
});

app.post('/api/groups/:groupId/members/:userId/assign', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const sourceGroupId = Number(req.params.groupId);
  const targetGroupId = Number(req.body.targetGroupId);
  const userId = Number(req.params.userId);
  const mode = req.body.mode;
  const sourceMembership = groupMembershipFor(userId, req.orgId, sourceGroupId);
  const targetGroup = req.orgDb.prepare('SELECT id FROM groups WHERE id = ?').get(targetGroupId);

  if (!sourceMembership) return res.status(404).json({ error: 'Member is not in the source group.' });
  if (!targetGroup) return res.status(404).json({ error: 'Target group not found.' });
  if (sourceGroupId === targetGroupId) return res.status(400).json({ error: 'Choose a different group.' });
  if (!['add', 'move'].includes(mode)) return res.status(400).json({ error: 'Choose whether to add or move this member.' });
  if (mode === 'move' && sourceMembership.role === 'group_admin' &&
      req.orgDb.prepare("SELECT COUNT(*) AS count FROM group_memberships WHERE group_id = ? AND role = 'group_admin'").get(sourceGroupId).count <= 1) {
    return res.status(400).json({ error: 'Assign another group admin before moving the last admin out.' });
  }

  const role = req.body.role === 'group_admin' ? 'group_admin' : 'member';
  const canDisplay = role === 'group_admin' || Boolean(req.body.canDisplay) ? 1 : 0;
  const canAddSongs = role === 'group_admin' || Boolean(req.body.canAddSongs) ? 1 : 0;
  const canEditSongs = role === 'group_admin' || Boolean(req.body.canEditSongs) ? 1 : 0;
  const existingTarget = groupMembershipFor(userId, req.orgId, targetGroupId);
  if (mode === 'add' && existingTarget) return res.status(409).json({ error: 'This member is already in the target group.' });
  try {
    req.orgDb.exec('BEGIN');
    if (existingTarget) {
      req.orgDb.prepare(`UPDATE group_memberships SET role = ?, can_display = ?, can_add_songs = ?, can_edit_songs = ?, added_by = ?
        WHERE group_id = ? AND user_id = ?`)
        .run(role, canDisplay, canAddSongs, canEditSongs, req.user.id, targetGroupId, userId);
    } else {
      req.orgDb.prepare(`INSERT INTO group_memberships (group_id, user_id, role, can_display, can_add_songs, can_edit_songs, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(targetGroupId, userId, role, canDisplay, canAddSongs, canEditSongs, req.user.id);
    }
    if (mode === 'move') req.orgDb.prepare('DELETE FROM group_memberships WHERE group_id = ? AND user_id = ?').run(sourceGroupId, userId);
    req.orgDb.exec('COMMIT');
    res.json({ message: mode === 'move' ? 'Member moved to the selected group.' : 'Member added to the selected group.' });
  } catch (err) {
    try { req.orgDb.exec('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'Could not update this member’s group access.' });
  }
});

// Presentation State Endpoint
app.get('/api/state', (req, res) => {
  const orgId = Number(req.query.orgId || 1);
  const groupId = Number(req.query.groupId);
  const orgDb = getOrgDb(orgId);
  if (!orgDb || !orgDb.prepare('SELECT id FROM groups WHERE id = ?').get(groupId)) {
    return res.status(404).json({ error: 'Group not found' });
  }
  res.json({ state: getLiveState(orgId, groupId) });
});

// Routing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/groups', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'groups.html'));
});

app.get('/add-songs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'add-songs.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/controller', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function serveGroupDisplay(req, res) {
  const cookie = (req.headers.cookie || '').match(/session_token=([^;]+)/);
  const session = cookie && getSession(cookie[1]);
  const orgId = Number(req.query.orgId || session?.organizationId || 1);
  const orgDb = getOrgDb(orgId);

  if (req.query.groupId && orgDb && orgDb.prepare('SELECT id FROM groups WHERE id = ?').get(Number(req.query.groupId))) {
    return res.sendFile(path.join(__dirname, 'public', 'display.html'));
  }

  const defaultGroup = session?.groupId || (orgDb && orgDb.prepare('SELECT id FROM groups ORDER BY id LIMIT 1').get()?.id);
  if (!defaultGroup) return res.status(404).send('No group display is configured yet.');
  res.redirect(`${req.path}?orgId=${orgId}&groupId=${defaultGroup}`);
}

app.get('/display', serveGroupDisplay);
app.get('/projector', serveGroupDisplay);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  const networkInterfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const lanAddress = networkInterfaces.find(address =>
    !address.internal && address.family === 'IPv4'
  )?.address;

  console.log(`=======================================================`);
  console.log(`  Oil & Wine Multi-Tenant Church Presentation System   `);
  console.log(`  Controller (Mobile & PC): http://localhost:${PORT}/controller`);
  console.log(`  Projector Display View  : http://localhost:${PORT}/display   `);
  console.log(`  Login Page              : http://localhost:${PORT}/login     `);
  if (lanAddress) {
    console.log(`  Mobile on same Wi-Fi    : http://${lanAddress}:${PORT}/controller`);
  } else {
    console.log(`  Mobile on same Wi-Fi    : Find this PC's IPv4 address and use http://<IPv4>:${PORT}/controller`);
  }
  console.log(`=======================================================`);
});
