const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'oilnwine_sample.db');

// Initialize SQLite database
const db = new DatabaseSync(DB_PATH);

// Create the application schema for a fresh checkout. Existing local databases
// are left intact, and runtime database files should remain untracked.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    otp TEXT,
    verified INTEGER NOT NULL DEFAULT 1,
    permission INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    alternate_title TEXT,
    lyrics TEXT NOT NULL DEFAULT '',
    transliteration TEXT,
    chord TEXT,
    language TEXT,
    search_title TEXT,
    search_lyrics TEXT,
    youtube_link TEXT,
    create_date TEXT DEFAULT (datetime('now')),
    modified_date TEXT DEFAULT (datetime('now')),
    username TEXT
  );
`);

// Add language tags to the existing song table without creating a new database.
const songColumns = db.prepare('PRAGMA table_info(songs)').all();
if (songColumns.length && !songColumns.some(column => column.name === 'language')) {
  db.exec('ALTER TABLE songs ADD COLUMN language TEXT');
}
db.exec(`
  UPDATE songs
  SET language = CASE
    WHEN lower(coalesce(alternate_title, '') || ' ' || coalesce(title, '')) LIKE '%malayalam%' THEN 'Malayalam'
    WHEN lower(coalesce(alternate_title, '') || ' ' || coalesce(title, '')) LIKE '%tamil%' THEN 'Tamil'
    WHEN lower(coalesce(alternate_title, '') || ' ' || coalesce(title, '')) LIKE '%hindi%' THEN 'Hindi'
    WHEN lower(coalesce(alternate_title, '') || ' ' || coalesce(title, '')) LIKE '%telugu%' THEN 'Telugu'
    WHEN lower(coalesce(alternate_title, '') || ' ' || coalesce(title, '')) LIKE '%nagamese%' THEN 'Nagamese'
    WHEN lower(coalesce(alternate_title, '') || ' ' || coalesce(title, '')) LIKE '%english%' THEN 'English'
    ELSE language
  END
  WHERE language IS NULL
`);

// Initialize Setlists table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS setlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    items TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Ensure master admin user exists if no admin exists
try {
  const adminCheck = db.prepare('SELECT id FROM users WHERE permission >= 2 LIMIT 1').get();
  if (!adminCheck) {
    const adminHash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare(`
      INSERT INTO users (username, email, password, permission, verified)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin', 'admin@oilnwine.org', adminHash, 2, 1);
    console.log('Master admin account created: admin / admin123');
  }
} catch (e) {
  console.warn('Admin check warning:', e.message);
}

// Session store in memory: token -> { user, expiresAt }
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const SONG_LANGUAGES = new Set(['English', 'Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Nagamese', 'Other']);

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      permission: user.permission
    },
    expiresAt: Date.now() + SESSION_TTL
  });
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session.user;
}

// Authentication middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/session_token=([^;]+)/);
    if (match) token = match[1];
  }

  const user = getSessionUser(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.permission < 2) {
    return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
  }
  next();
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

  // If first stanza is a chord header like 'E' or '[E maj]', remove it from slides
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

    // Detect labels like '1.', '2.', 'Chorus', etc.
    if (displayLines.length > 0) {
      // Filter out leading chord lines like 'E' or '[E maj]'
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

    // Pair transliteration lines
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

// Live Presentation State
const liveState = {
  currentSong: null,
  activeSlideIndex: 0,
  isBlank: false,        // blackout screen
  isClear: false,        // clear lyrics
  showTranslit: true,    // show transliterated line underneath
  theme: 'clean-white',  // clean-white (white screen, black text, blue accent), sanctuary, pure-black, cathedral, warm-ember
  fontSize: 54,          // font size in px
  fontFamily: 'Outfit',  // Outfit, Plus Jakarta Sans, Inter, Cinzel
  textAlign: 'center',   // center, left
  displayWidth: 1920,
  displayHeight: 1080,
  displayContentWidth: 1574,
  displayContentHeight: 778,
  displayCharWidthRatio: 0.56,
  displayFitScale: 1
};

function reflowCurrentSongSlides() {
  if (!liveState.currentSong) return;
  const songRow = db.prepare('SELECT lyrics, transliteration FROM songs WHERE id = ?').get(liveState.currentSong.id);
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Set up HTTP and WebSocket Servers
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastState() {
  const payload = JSON.stringify({
    type: 'STATE_UPDATE',
    state: liveState,
    timestamp: Date.now()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws, req) => {
  // Send current state immediately on connection
  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    state: liveState,
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
        reflowCurrentSongSlides();
        broadcastState();
      }
      break;
    }
    case 'DISPLAY_OVERFLOW': {
      if (liveState.currentSong && Number(data.songId) === Number(liveState.currentSong.id) && Number(data.fontSize) === Number(liveState.fontSize) && liveState.displayFitScale > 0.32) {
        liveState.displayFitScale = Math.max(0.32, liveState.displayFitScale * 0.78);
        reflowCurrentSongSlides();
        broadcastState();
      }
      break;
    }
    case 'SET_SONG': {
      const { songId, slideIndex = 0 } = data;
      const songRow = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
      if (songRow) {
        liveState.displayFitScale = 1;
        const slides = parseLyricsIntoSlides(songRow.lyrics, songRow.transliteration, liveState.fontSize, liveState.displayWidth, liveState.displayHeight, liveState.displayContentWidth, liveState.displayContentHeight, liveState.displayCharWidthRatio, liveState.displayFitScale);
        liveState.currentSong = {
          id: songRow.id,
          title: songRow.title,
          alternate_title: songRow.alternate_title,
          chord: songRow.chord,
          youtube_link: songRow.youtube_link,
          slides
        };
        liveState.activeSlideIndex = Math.min(slideIndex, Math.max(0, slides.length - 1));
        liveState.isBlank = false;
        liveState.isClear = false;
        broadcastState();
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
          broadcastState();
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
          broadcastState();
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
          broadcastState();
        }
      }
      break;
    }
    case 'TOGGLE_BLANK': {
      liveState.isBlank = typeof data.isBlank === 'boolean' ? data.isBlank : !liveState.isBlank;
      broadcastState();
      break;
    }
    case 'TOGGLE_CLEAR': {
      liveState.isClear = typeof data.isClear === 'boolean' ? data.isClear : !liveState.isClear;
      broadcastState();
      break;
    }
    case 'TOGGLE_TRANSLIT': {
      liveState.showTranslit = typeof data.showTranslit === 'boolean' ? data.showTranslit : !liveState.showTranslit;
      broadcastState();
      break;
    }
    case 'UPDATE_STYLE': {
      if (data.theme) liveState.theme = data.theme;
      if (data.fontSize !== undefined) {
        liveState.fontSize = Math.max(32, Math.min(84, Number(data.fontSize) || liveState.fontSize));
        liveState.displayFitScale = 1;
        reflowCurrentSongSlides();
      }
      if (data.fontFamily) liveState.fontFamily = data.fontFamily;
      if (data.textAlign) liveState.textAlign = data.textAlign;
      broadcastState();
      break;
    }
    case 'RESET_DISPLAY': {
      liveState.currentSong = null;
      liveState.activeSlideIndex = 0;
      liveState.isBlank = false;
      liveState.isClear = false;
      broadcastState();
      break;
    }
  }
}

// --- REST API ENDPOINTS ---

// Auth Endpoints
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required' });
  }

  const hashedPassword = crypto.createHash('sha256').update(password.trim()).digest('hex');

  const user = db.prepare(`
    SELECT id, username, email, password, permission, verified 
    FROM users 
    WHERE username = ? OR email = ?
  `).get(username.trim(), username.trim());

  if (!user || user.password !== hashedPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createSession(user);
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
      permission: user.permission
    }
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/session_token=([^;]+)/);
    if (match) token = match[1];
  }
  if (token) sessions.delete(token);
  res.clearCookie('session_token');
  res.json({ message: 'Logged out successfully' });
});

// Songs Endpoints
app.get('/api/songs', requireAuth, (req, res) => {
  const { q = '', language = '' } = req.query;
  const searchTerm = q.trim();

  let query = 'SELECT id, title, alternate_title, chord, language, youtube_link, create_date FROM songs';
  const params = [];
  const conditions = [];

  if (searchTerm) {
    // If search term is a pure number, prioritize exact song number or ID
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
    conditions.push('(language = ? OR (language IS NULL AND (alternate_title LIKE ? OR title LIKE ?)))');
    params.push(language, `%${language}%`, `%${language}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY id ASC';

  const songs = db.prepare(query).all(...params);
  res.json({ songs, total: songs.length });
});

app.get('/api/songs/:id', requireAuth, (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song) {
    return res.status(404).json({ error: 'Song not found' });
  }

  const slides = parseLyricsIntoSlides(song.lyrics, song.transliteration, liveState.fontSize, liveState.displayWidth, liveState.displayHeight, liveState.displayContentWidth, liveState.displayContentHeight, liveState.displayCharWidthRatio, liveState.displayFitScale);
  res.json({
    song: {
      ...song,
      slides
    }
  });
});

app.post('/api/songs', requireAuth, (req, res) => {
  const { alternate_title, transliteration, chord } = req.body;
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const language = typeof req.body.language === 'string' ? req.body.language.trim() : '';
  const lyrics = typeof req.body.lyrics === 'string' ? req.body.lyrics.trim() : '';
  const alternateTitle = typeof alternate_title === 'string' ? alternate_title.trim() : '';
  const transliterationText = typeof transliteration === 'string' ? transliteration.trim() : '';
  const chordText = typeof chord === 'string' ? chord.trim() : '';
  if (!title || !SONG_LANGUAGES.has(language)) {
    return res.status(400).json({ error: 'Song title and a valid language are required' });
  }

  const now = new Date().toISOString();
  const searchTitle = (title + ' ' + alternateTitle).toLowerCase();
  const searchLyrics = lyrics.toLowerCase();

  const info = db.prepare(`
    INSERT INTO songs (title, alternate_title, lyrics, transliteration, chord, language, search_title, search_lyrics, youtube_link, create_date, modified_date, username)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    alternateTitle || null,
    lyrics,
    transliterationText || null,
    chordText || null,
    language,
    searchTitle,
    searchLyrics,
    null,
    now,
    now,
    req.user.username
  );

  res.status(201).json({ message: 'Song created', id: info.lastInsertRowid });
});

app.put('/api/songs/:id', requireAuth, (req, res) => {
  const { alternate_title, transliteration, chord } = req.body;
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const language = typeof req.body.language === 'string' ? req.body.language.trim() : '';
  const lyrics = typeof req.body.lyrics === 'string' ? req.body.lyrics.trim() : '';
  const alternateTitle = typeof alternate_title === 'string' ? alternate_title.trim() : '';
  const transliterationText = typeof transliteration === 'string' ? transliteration.trim() : '';
  const chordText = typeof chord === 'string' ? chord.trim() : '';
  if (!title || !SONG_LANGUAGES.has(language)) {
    return res.status(400).json({ error: 'Song title and a valid language are required' });
  }

  const now = new Date().toISOString();
  const searchTitle = (title + ' ' + alternateTitle).toLowerCase();
  const searchLyrics = lyrics.toLowerCase();

  const info = db.prepare(`
    UPDATE songs
    SET title = ?, alternate_title = ?, lyrics = ?, transliteration = ?, chord = ?, language = ?,
        search_title = ?, search_lyrics = ?, modified_date = ?
    WHERE id = ?
  `).run(
    title,
    alternateTitle || null,
    lyrics,
    transliterationText || null,
    chordText || null,
    language,
    searchTitle,
    searchLyrics,
    now,
    req.params.id
  );

  if (info.changes === 0) {
    return res.status(404).json({ error: 'Song not found' });
  }

  // If currently projecting this song, update live slides
  if (liveState.currentSong && liveState.currentSong.id === Number(req.params.id)) {
    const slides = parseLyricsIntoSlides(lyrics, transliterationText, liveState.fontSize, liveState.displayWidth, liveState.displayHeight, liveState.displayContentWidth, liveState.displayContentHeight, liveState.displayCharWidthRatio, liveState.displayFitScale);
    liveState.currentSong.title = title;
    liveState.currentSong.alternate_title = alternateTitle || null;
    liveState.currentSong.chord = chordText || null;
    liveState.currentSong.language = language;
    liveState.currentSong.slides = slides;
    broadcastState();
  }

  res.json({ message: 'Song updated successfully' });
});

app.delete('/api/songs/:id', requireAuth, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM songs WHERE id = ?').run(req.params.id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Song not found' });
  }
  if (liveState.currentSong && liveState.currentSong.id === Number(req.params.id)) {
    liveState.currentSong = null;
    liveState.activeSlideIndex = 0;
    liveState.isBlank = false;
    liveState.isClear = false;
    broadcastState();
  }
  res.json({ message: 'Song deleted successfully' });
});

// Setlists Endpoints (Sunday Service Queues)
app.get('/api/setlists', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM setlists ORDER BY updated_at DESC').all();
  const setlists = rows.map(r => ({
    ...r,
    items: JSON.parse(r.items || '[]')
  }));
  res.json({ setlists });
});

app.post('/api/setlists', requireAuth, (req, res) => {
  const { name, items, id } = req.body;
  if (!name) return res.status(400).json({ error: 'Setlist name is required' });

  const itemsJson = JSON.stringify(items || []);
  const now = new Date().toISOString();

  if (id) {
    db.prepare('UPDATE setlists SET name = ?, items = ?, updated_at = ? WHERE id = ?').run(name, itemsJson, now, id);
    res.json({ message: 'Setlist updated', id });
  } else {
    const info = db.prepare('INSERT INTO setlists (name, items, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, itemsJson, now, now);
    res.status(201).json({ message: 'Setlist created', id: info.lastInsertRowid });
  }
});

app.delete('/api/setlists/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM setlists WHERE id = ?').run(req.params.id);
  res.json({ message: 'Setlist deleted' });
});

// Users Management Endpoints (Admin only)
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, email, permission, verified FROM users ORDER BY id ASC').all();
  res.json({ users });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, email, password, permission = 0 } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  const hashedPassword = crypto.createHash('sha256').update(password.trim()).digest('hex');

  try {
    const info = db.prepare(`
      INSERT INTO users (username, email, password, permission, verified)
      VALUES (?, ?, ?, ?, 1)
    `).run(username.trim(), email.trim(), hashedPassword, Number(permission));

    res.status(201).json({ message: 'User created successfully', id: info.lastInsertRowid });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username or Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { password, permission, email } = req.body;
  const userId = req.params.id;

  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  if (password && password.trim()) {
    const hashed = crypto.createHash('sha256').update(password.trim()).digest('hex');
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, userId);
  }

  if (permission !== undefined) {
    db.prepare('UPDATE users SET permission = ? WHERE id = ?').run(Number(permission), userId);
  }

  if (email && email.trim()) {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email.trim(), userId);
  }

  res.json({ message: 'User updated successfully' });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const userId = req.params.id;
  if (Number(userId) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own admin account' });
  }

  const info = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ message: 'User deleted successfully' });
});

// Presentation State Endpoint
app.get('/api/state', (req, res) => {
  res.json({ state: liveState });
});

// Clean Page Routing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/controller', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/projector', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  Oil & Wine Church Presentation System is Live!       `);
  console.log(`  Controller (Mobile & PC): http://localhost:${PORT}/controller`);
  console.log(`  Projector Display View  : http://localhost:${PORT}/display   `);
  console.log(`  Login Page              : http://localhost:${PORT}/login     `);
  console.log(`=======================================================`);
});
