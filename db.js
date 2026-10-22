const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const ORGS_DIR = path.join(DATA_DIR, 'orgs');
const MASTER_SEED_PATH = path.join(__dirname, 'seed', 'master_songs.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ORGS_DIR, { recursive: true });

const MASTER_DB_PATH = path.join(DATA_DIR, 'master_songs.db');
// New checkouts get the shared song catalog without inheriting account or org data.
if (!fs.existsSync(MASTER_DB_PATH) && fs.existsSync(MASTER_SEED_PATH)) {
  fs.copyFileSync(MASTER_SEED_PATH, MASTER_DB_PATH);
}
const masterDb = new DatabaseSync(MASTER_DB_PATH);

// Initialize Master Database Schema
masterDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    otp TEXT,
    verified INTEGER NOT NULL DEFAULT 1,
    permission INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    db_filename TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    logo_data TEXT,
    brand_color TEXT NOT NULL DEFAULT '#2563eb',
    welcome_text TEXT
  );

  CREATE TABLE IF NOT EXISTS user_organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('org_owner', 'org_admin', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, organization_id)
  );

  CREATE TABLE IF NOT EXISTS master_songs (
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
    tags TEXT,
    ccli_number TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    modified_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS master_migrations (
    migration_key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Add organisation branding fields to databases created by earlier versions.
const organizationColumns = new Set(masterDb.prepare('PRAGMA table_info(organizations)').all().map(column => column.name));
if (!organizationColumns.has('logo_data')) masterDb.exec('ALTER TABLE organizations ADD COLUMN logo_data TEXT');
if (!organizationColumns.has('brand_color')) masterDb.exec("ALTER TABLE organizations ADD COLUMN brand_color TEXT NOT NULL DEFAULT '#2563eb'");
if (!organizationColumns.has('welcome_text')) masterDb.exec('ALTER TABLE organizations ADD COLUMN welcome_text TEXT');

// Song numbers belong to each organisation's songbook, never the shared master catalog.
const masterSongColumns = new Set(masterDb.prepare('PRAGMA table_info(master_songs)').all().map(column => column.name));
if (masterSongColumns.has('song_number')) {
  masterDb.exec('ALTER TABLE master_songs DROP COLUMN song_number');
  masterDb.exec("UPDATE master_songs SET search_title = lower(trim(coalesce(title, '') || ' ' || coalesce(alternate_title, '')))");
}

// Cache of open SQLite connections per organization
const orgDbs = new Map();

function initOrgDbSchema(orgDb) {
  orgDb.exec(`
    CREATE TABLE IF NOT EXISTS organization_info (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      master_song_id INTEGER,
      song_number TEXT,
      title TEXT NOT NULL,
      alternate_title TEXT,
      lyrics TEXT NOT NULL DEFAULT '',
      transliteration TEXT,
      chord TEXT,
      language TEXT,
      songbook_tag TEXT,
      search_title TEXT,
      search_lyrics TEXT,
      youtube_link TEXT,
      tags TEXT,
      is_custom INTEGER NOT NULL DEFAULT 0,
      added_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      modified_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS songbook_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('group_admin', 'member')),
      can_display INTEGER NOT NULL DEFAULT 0,
      can_add_songs INTEGER NOT NULL DEFAULT 0,
      can_edit_songs INTEGER NOT NULL DEFAULT 0,
      added_by INTEGER,
      UNIQUE(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_songbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      custom_order INTEGER NOT NULL DEFAULT 0,
      added_by INTEGER,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, song_id)
    );

    CREATE TABLE IF NOT EXISTS song_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL,
      actor_user_id INTEGER,
      actor_username TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      change_type TEXT NOT NULL DEFAULT 'edit',
      source_version_id INTEGER,
      snapshot TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_live_states (
      group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      modified_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const songColumns = new Set(orgDb.prepare('PRAGMA table_info(songs)').all().map(column => column.name));
  if (!songColumns.has('songbook_tag')) orgDb.exec('ALTER TABLE songs ADD COLUMN songbook_tag TEXT');
  for (const tag of SONG_CATEGORIES) {
    orgDb.prepare('INSERT OR IGNORE INTO songbook_tags (name) VALUES (?)').run(tag);
  }
  orgDb.exec(`
    UPDATE songs
    SET alternate_title = NULL,
        search_title = lower(trim(coalesce(song_number, '') || ' ' || coalesce(title, '')))
    WHERE trim(coalesce(alternate_title, '')) <> ''
      AND trim(alternate_title) NOT GLOB '*[^0-9]*'
  `);
  const songsNeedingTag = orgDb.prepare(`
    SELECT id, title, alternate_title, language, tags, songbook_tag FROM songs
    WHERE songbook_tag IS NULL OR trim(songbook_tag) = '' OR (songbook_tag = 'Other' AND language IS NULL)
  `).all();
  for (const song of songsNeedingTag) {
    const tag = String(song.language || resolveSongCategory(song));
    orgDb.prepare('INSERT OR IGNORE INTO songbook_tags (name) VALUES (?)').run(tag);
    orgDb.prepare('UPDATE songs SET songbook_tag = ? WHERE id = ?').run(tag, song.id);
  }
  orgDb.prepare(`
    INSERT OR IGNORE INTO songbook_tags (name)
    SELECT DISTINCT songbook_tag FROM songs WHERE songbook_tag IS NOT NULL AND trim(songbook_tag) <> ''
  `).run();
}

function getOrgDb(orgId) {
  const id = Number(orgId);
  if (!id) return null;
  if (orgDbs.has(id)) return orgDbs.get(id);

  const org = masterDb.prepare('SELECT id, name, db_filename FROM organizations WHERE id = ?').get(id);
  if (!org) return null;

  const orgDbPath = path.join(ORGS_DIR, org.db_filename);
  const orgDb = new DatabaseSync(orgDbPath);
  initOrgDbSchema(orgDb);

  // Seed organization info if empty
  const info = orgDb.prepare('SELECT id FROM organization_info LIMIT 1').get();
  if (!info) {
    orgDb.prepare('INSERT OR REPLACE INTO organization_info (id, name) VALUES (1, ?)').run(org.name);
  }

  orgDbs.set(id, orgDb);
  return orgDb;
}

function createOrganization({ name, slug, createdBy }) {
  const cleanName = String(name || '').trim();
  const cleanSlug = String(slug || cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).trim();

  if (!cleanName || !cleanSlug) {
    throw new Error('Organization name and slug are required');
  }

  const existing = masterDb.prepare('SELECT id FROM organizations WHERE name = ? OR slug = ?').get(cleanName, cleanSlug);
  if (existing) {
    throw new Error('An organization with that name or slug already exists');
  }

  let orgId = null;
  try {
    masterDb.exec('BEGIN');
    const result = masterDb.prepare(`
      INSERT INTO organizations (name, slug, db_filename, created_by)
      VALUES (?, ?, ?, ?)
    `).run(cleanName, cleanSlug, 'temp.db', createdBy || null);

    orgId = Number(result.lastInsertRowid);
    const dbFilename = `org_${orgId}.db`;
    masterDb.prepare('UPDATE organizations SET db_filename = ? WHERE id = ?').run(dbFilename, orgId);

    if (createdBy) {
      masterDb.prepare(`
        INSERT INTO user_organizations (user_id, organization_id, role)
        VALUES (?, ?, 'org_owner')
      `).run(Number(createdBy), orgId);
    }
    masterDb.exec('COMMIT');
  } catch (err) {
    try { masterDb.exec('ROLLBACK'); } catch {}
    throw err;
  }

  // Initialize the new organization's SQLite file
  const orgDb = getOrgDb(orgId);
  return { id: orgId, name: cleanName, slug: cleanSlug, orgDb };
}

const SONG_CATEGORIES = ['English', 'Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Nagamese', 'Other'];

function resolveSongCategory(song = {}, requestedCategory = '') {
  const requested = String(requestedCategory || '').trim();
  const language = String(requested || song.language || '').trim();
  const matchedLanguage = SONG_CATEGORIES.find(item => item.toLowerCase() === language.toLowerCase());
  if (matchedLanguage) return matchedLanguage;

  const tags = String(song.tags || '').toLowerCase();
  const taggedLanguage = SONG_CATEGORIES.find(item => new RegExp(`(^|[^a-z])${item.toLowerCase()}([^a-z]|$)`).test(tags));
  if (taggedLanguage) return taggedLanguage;

  const text = `${song.alternate_title || ''} ${song.title || ''}`;
  if (/[\u0D00-\u0D7F]/.test(text)) return 'Malayalam';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'Tamil';
  if (/[\u0900-\u097F]/.test(text)) return 'Hindi';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'Telugu';
  if (/\b(nagamese|naga)\b/i.test(text)) return 'Nagamese';
  if (/[a-z]/i.test(text) && /^[\x00-\x7F]*$/.test(text)) return 'English';
  return 'Other';
}

function getSongbookTags(orgDb) {
  return orgDb.prepare('SELECT id, name FROM songbook_tags ORDER BY name COLLATE NOCASE ASC').all();
}

function resolveSongbookTag(orgDb, requestedTag) {
  const requested = String(requestedTag || '').trim();
  if (!requested) throw new Error('Choose a songbook tag first.');
  const tag = orgDb.prepare('SELECT name FROM songbook_tags WHERE name = ? COLLATE NOCASE').get(requested);
  if (!tag) throw new Error('Choose a valid songbook tag.');
  return tag.name;
}

function getNextOrgSongNumber(orgDb, tag) {
  const normalizedTag = resolveSongbookTag(orgDb, tag);
  const songs = orgDb.prepare('SELECT song_number, title, alternate_title, language, tags, songbook_tag FROM songs').all();
  const categorySongs = songs.filter(song => String(song.songbook_tag || resolveSongCategory(song)).toLowerCase() === normalizedTag.toLowerCase());
  const usedNumbers = new Set(categorySongs.map(song => String(song.song_number || '').trim()).filter(Boolean));
  let nextNumber = categorySongs.length + 1;
  while (usedNumbers.has(String(nextNumber))) nextNumber += 1;
  return String(nextNumber);
}

function importMasterSongToOrg(orgId, { masterSongId, language, songbookTag, userId, username }) {
  const orgDb = getOrgDb(orgId);
  if (!orgDb) throw new Error('Organization database not found');

  const masterSong = masterDb.prepare('SELECT * FROM master_songs WHERE id = ?').get(Number(masterSongId));
  if (!masterSong) throw new Error('Master song not found');

  const songLanguage = resolveSongCategory(masterSong, language);
  const assignedTag = resolveSongbookTag(orgDb, songbookTag || songLanguage);
  const assignedNumber = getNextOrgSongNumber(orgDb, assignedTag);
  const alternateTitle = /^\d+$/.test(String(masterSong.alternate_title || '').trim()) ? null : masterSong.alternate_title;

  const now = new Date().toISOString();
  const searchTitle = `${assignedNumber} ${masterSong.title} ${alternateTitle || ''}`.toLowerCase().trim();
  const searchLyrics = String(masterSong.lyrics || '').toLowerCase();

  const result = orgDb.prepare(`
    INSERT INTO songs (
      master_song_id, song_number, title, alternate_title, lyrics, transliteration,
      chord, language, songbook_tag, search_title, search_lyrics, youtube_link, tags,
      is_custom, added_by, created_at, modified_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    masterSong.id,
    assignedNumber,
    masterSong.title,
    alternateTitle,
    masterSong.lyrics,
    masterSong.transliteration,
    masterSong.chord,
    songLanguage,
    assignedTag,
    searchTitle,
    searchLyrics,
    masterSong.youtube_link,
    masterSong.tags,
    userId || null,
    now,
    now
  );

  const newSongId = Number(result.lastInsertRowid);
  const createdSong = orgDb.prepare('SELECT * FROM songs WHERE id = ?').get(newSongId);

  // Record version baseline
  const snapshot = {
    song_number: createdSong.song_number,
    title: createdSong.title,
    alternate_title: createdSong.alternate_title,
    lyrics: createdSong.lyrics,
    transliteration: createdSong.transliteration,
    chord: createdSong.chord,
    language: createdSong.language,
    youtube_link: createdSong.youtube_link
  };

  orgDb.prepare(`
    INSERT INTO song_versions (song_id, actor_user_id, actor_username, changed_at, change_type, snapshot)
    VALUES (?, ?, ?, ?, 'import', ?)
  `).run(newSongId, userId || null, username || 'System', now, JSON.stringify(snapshot));

  return createdSong;
}

// Migrate legacy oilnwine_sample.db into master_songs.db and org_1.db
function migrateLegacySampleDb() {
  const legacyPath = path.join(__dirname, 'oilnwine_sample.db');
  if (!fs.existsSync(legacyPath)) return;

  const migrated = masterDb.prepare("SELECT migration_key FROM master_migrations WHERE migration_key = 'initial_legacy_migration'").get();
  if (migrated) return;

  console.log('Beginning migration from oilnwine_sample.db to multi-database architecture...');
  const legacyDb = new DatabaseSync(legacyPath);

  try {
    masterDb.exec('BEGIN');

    // 1. Migrate Users
    const legacyUsers = legacyDb.prepare('SELECT * FROM users').all();
    for (const u of legacyUsers) {
      const exists = masterDb.prepare('SELECT id FROM users WHERE id = ? OR username = ? OR email = ?').get(u.id, u.username, u.email);
      if (!exists) {
        masterDb.prepare(`
          INSERT INTO users (id, username, email, password, otp, verified, permission)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(u.id, u.username, u.email, u.password, u.otp || null, u.verified ?? 1, u.permission ?? 0);
      }
    }

    // 2. Migrate Songs to master_songs
    const legacySongs = legacyDb.prepare('SELECT * FROM songs').all();
    for (const s of legacySongs) {
      masterDb.prepare(`
        INSERT INTO master_songs (
          id, title, alternate_title, lyrics, transliteration, chord,
          language, search_title, search_lyrics, youtube_link, tags, created_at, modified_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        s.id,
        s.title,
        s.alternate_title,
        s.lyrics || '',
        s.transliteration || null,
        s.chord || null,
        s.language || null,
        `${s.title || ''} ${s.alternate_title || ''}`.toLowerCase().trim(),
        s.search_lyrics || '',
        s.youtube_link || null,
        null,
        s.create_date || new Date().toISOString(),
        s.modified_date || new Date().toISOString()
      );
    }

    // 3. Create Default Organization: "Oil & Wine Church"
    const firstAdmin = masterDb.prepare('SELECT id FROM users WHERE permission >= 2 LIMIT 1').get() || { id: 1 };
    const orgResult = masterDb.prepare(`
      INSERT INTO organizations (id, name, slug, db_filename, created_by)
      VALUES (1, 'Oil & Wine Church', 'oil-and-wine', 'org_1.db', ?)
    `).run(firstAdmin.id);

    // Link all migrated users to Organization 1
    for (const u of legacyUsers) {
      const role = u.permission >= 2 ? 'org_admin' : 'member';
      masterDb.prepare(`
        INSERT OR IGNORE INTO user_organizations (user_id, organization_id, role)
        VALUES (?, 1, ?)
      `).run(u.id, role);
    }

    masterDb.prepare("INSERT INTO master_migrations (migration_key) VALUES ('initial_legacy_migration')").run();
    masterDb.exec('COMMIT');

    // 4. Setup org_1.db with the copied songbook, groups, memberships, and live states
    const org1Db = getOrgDb(1);
    org1Db.exec('BEGIN');

    for (const s of legacySongs) {
      const isAltNumeric = /^\d+$/.test(String(s.alternate_title || '').trim());
      const songNumber = isAltNumeric ? String(s.alternate_title).trim() : String(s.id);
      const songbookTag = String(s.language || resolveSongCategory(s));
      org1Db.prepare('INSERT OR IGNORE INTO songbook_tags (name) VALUES (?)').run(songbookTag);
      org1Db.prepare(`
        INSERT INTO songs (
          id, master_song_id, song_number, title, alternate_title, lyrics, transliteration, chord,
          language, songbook_tag, search_title, search_lyrics, youtube_link, is_custom, added_by, created_at, modified_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        s.id,
        s.id,
        songNumber,
        s.title,
        s.alternate_title,
        s.lyrics || '',
        s.transliteration || null,
        s.chord || null,
        s.language || null,
        songbookTag,
        s.search_title || '',
        s.search_lyrics || '',
        s.youtube_link || null,
        firstAdmin.id,
        s.create_date || new Date().toISOString(),
        s.modified_date || new Date().toISOString()
      );
    }

    // Migrate groups
    const legacyGroups = legacyDb.prepare('SELECT * FROM groups').all();
    for (const g of legacyGroups) {
      org1Db.prepare(`
        INSERT INTO groups (id, name, created_by, created_at)
        VALUES (?, ?, ?, ?)
      `).run(g.id, g.name, g.created_by, g.created_at);
    }

    // Migrate group memberships
    const legacyMemberships = legacyDb.prepare('SELECT * FROM group_memberships').all();
    for (const m of legacyMemberships) {
      org1Db.prepare(`
        INSERT INTO group_memberships (id, group_id, user_id, role, can_display, can_add_songs, can_edit_songs, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(m.id, m.group_id, m.user_id, m.role, m.can_display, m.can_add_songs, m.can_edit_songs, m.added_by);
    }

    // Migrate song versions if any
    const legacyVersions = legacyDb.prepare('SELECT * FROM song_versions').all();
    for (const v of legacyVersions) {
      org1Db.prepare(`
        INSERT INTO song_versions (id, song_id, actor_user_id, actor_username, changed_at, change_type, source_version_id, snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(v.id, v.song_id, v.actor_user_id, v.actor_username, v.changed_at, v.change_type, v.source_version_id, v.snapshot);
    }

    // Migrate group live states
    const legacyStates = legacyDb.prepare('SELECT * FROM group_live_states').all();
    for (const ls of legacyStates) {
      org1Db.prepare(`
        INSERT INTO group_live_states (group_id, state_json, modified_at)
        VALUES (?, ?, ?)
      `).run(ls.group_id, ls.state_json, ls.modified_at);
    }

    org1Db.exec('COMMIT');
    console.log('Legacy migration completed successfully! Master DB and Org 1 DB created.');
  } catch (err) {
    try { masterDb.exec('ROLLBACK'); } catch {}
    console.error('Migration failed:', err);
  }
}

// Ensure default master admin exists in masterDb
function ensureMasterAdmin(hashPasswordFn) {
  try {
    const adminCheck = masterDb.prepare("SELECT id FROM users WHERE username = 'admin' LIMIT 1").get();
    if (!adminCheck) {
      const adminHash = hashPasswordFn('admin123');
      masterDb.prepare(`
        INSERT INTO users (username, email, password, permission, verified)
        VALUES (?, ?, ?, 2, 1)
      `).run('admin', 'admin@oilnwine.org', adminHash);
      console.log('Master admin account created: admin / admin123');
    }
  } catch (e) {
    console.warn('Master admin check warning:', e.message);
  }
}

module.exports = {
  DATA_DIR,
  ORGS_DIR,
  MASTER_DB_PATH,
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
};
