// db.js - the database layer.
//
// It uses libSQL (the SQLite-compatible engine behind Turso):
//   - locally (npm start) it stores everything in data/skillswap.db
//   - on Vercel it talks to a free Turso database (set TURSO_DATABASE_URL
//     and TURSO_AUTH_TOKEN as environment variables)
//
// The rest of the app only uses all(), get(), run() and tx(), so nothing else
// needs to know where the data lives.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'skillswap.db');
const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const DEMO_PASSWORD = 'demo1234'; // password of the 6 sample users

let client;
let initPromise;

// While a transaction is open, db calls must run on that transaction.
// AsyncLocalStorage keeps each request's transaction separate, even when
// several requests are handled at the same time.
const txStorage = new AsyncLocalStorage();

function executor() {
  const store = txStorage.getStore();
  return store && store.tx ? store.tx : client;
}

const toFileUrl = (file) => 'file:' + file.replace(/\\/g, '/');

// Run a SELECT and return all rows as objects
async function all(sql, params = []) {
  const result = await executor().execute({ sql, args: params });
  return result.rows.map((row) => ({ ...row }));
}

// Run a SELECT and return the first row (or undefined)
async function get(sql, params = []) {
  return (await all(sql, params))[0];
}

// Run INSERT / UPDATE / DELETE. Returns { id: new row id, changes: rows changed }
async function run(sql, params = []) {
  const result = await executor().execute({ sql, args: params });
  return { id: Number(result.lastInsertRowid), changes: result.rowsAffected };
}

// Run several changes as ONE unit: either all succeed or none are kept.
// Usage: await db.tx(async () => { await db.run(...); await db.get(...); });
async function tx(fn) {
  if (txStorage.getStore()) return fn(); // already inside a transaction

  const transaction = await client.transaction('write');
  try {
    const result = await txStorage.run({ tx: transaction }, fn);
    await transaction.commit();
    return result;
  } catch (err) {
    try { await transaction.rollback(); } catch (e) { /* nothing to roll back */ }
    throw err;
  }
}

async function init() {
  // Vercel can import this module more than once, so only do the work once.
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!REMOTE_URL && process.env.VERCEL) {
      throw new Error(
        'No database configured. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel ' +
        '(Project -> Settings -> Environment Variables), then redeploy. ' +
        'Vercel cannot keep the local data/skillswap.db file.'
      );
    }

    if (REMOTE_URL) {
      client = createClient({ url: REMOTE_URL, authToken: AUTH_TOKEN });
      console.log('Using the Turso database.');
    } else {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

      // Older versions of this project used a "city" column. Keep that file
      // as a backup and start fresh instead of crashing on old data.
      if (fs.existsSync(DB_FILE)) {
        const probe = createClient({ url: toFileUrl(DB_FILE) });
        const old = await isOldSchemaFor(probe).catch(() => false);
        await probe.close();
        if (old) {
          const backup = DB_FILE.replace('.db', '.old-' + Date.now() + '.db');
          fs.renameSync(DB_FILE, backup);
          console.log('Old database found (it had cities and no passwords).');
          console.log('It was kept as ' + path.basename(backup) + ' and a fresh one will be created.\n');
        }
      }

      client = createClient({ url: toFileUrl(DB_FILE) });
      console.log('Using the local database file: ' + DB_FILE);
    }

    try {
      await client.execute('PRAGMA foreign_keys = ON');
    } catch (e) {
      // Some hosted libSQL setups manage this for us.
    }

    await createTables();
    await seed();
    await client.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')");
    return module.exports;
  })().catch((err) => {
    initPromise = null; // let the next request try again instead of caching the failure
    throw err;
  });

  return initPromise;
}

// Small helper used before the main client exists
async function isOldSchemaFor(probe) {
  const res = await probe.execute('PRAGMA table_info(users)');
  return res.rows.length > 0 && res.rows.some((row) => row.name === 'city');
}

async function createTables() {
  // Accounts. Only a bcrypt HASH of the password is stored, never the password.
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Login sessions (the browser keeps a random token in a cookie; we store its hash)
  await run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // One-time password reset links
  await run(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Junction table: users <-> skills (many-to-many)
  await run(`CREATE TABLE IF NOT EXISTS user_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('teach','learn')),
    level TEXT NOT NULL CHECK (level IN ('Beginner','Intermediate','Expert')),
    UNIQUE (user_id, skill_id, type)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offered_skill_id INTEGER REFERENCES skills(id),
    wanted_skill_id INTEGER NOT NULL REFERENCES skills(id),
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','accepted','declined','completed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (from_user_id != to_user_id)
  )`);

  // Ratings given after a swap is completed (one per person per swap)
  await run(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (request_id, reviewer_id)
  )`);

  // Who has blocked whom
  await run(`CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
  )`);

  // ---- Messaging ----
  // A conversation is either a 'direct' chat (2 people) or a 'room' (many people).
  // 'room' = a group chat for one skill (for example the Guitar room), anyone can join.
  await run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('direct','room')),
    title TEXT,
    skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
    direct_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, id)');
  // Only one group room per skill
  await run("CREATE UNIQUE INDEX IF NOT EXISTS uq_room_skill ON conversations (skill_id) WHERE type = 'room'");
}

// ---- Sample data (only when the tables are empty) ----
async function seed() {
  await tx(async () => {
    if ((await get('SELECT COUNT(*) AS n FROM skills')).n > 0) return;

    const skills = ['Guitar', 'Excel', 'Cooking', 'Python', 'Photography', 'Yoga', 'Spanish',
      'Tamil', 'Drawing', 'Public Speaking', 'Video Editing', 'Chess', 'Baking', 'Piano', 'Web Design'];
    for (const s of skills) {
      await run('INSERT OR IGNORE INTO skills (name) VALUES (?)', [s]);
    }

    const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
    const users = [
      ['Priya', 'priya@skillswap.local'],
      ['Arun', 'arun@skillswap.local'],
      ['Meera', 'meera@skillswap.local'],
      ['Divya', 'divya@skillswap.local'],
      ['Karthik', 'karthik@skillswap.local'],
      ['Ravi', 'ravi@skillswap.local'],
    ];
    for (const u of users) {
      await run('INSERT OR IGNORE INTO users (name, email, password_hash) VALUES (?,?,?)', [u[0], u[1], hash]);
    }

    // [email, skill, type, level]
    const links = [
      ['priya@skillswap.local', 'Guitar', 'teach', 'Expert'],        // Priya <-> Arun = perfect pair
      ['priya@skillswap.local', 'Excel', 'learn', 'Intermediate'],
      ['arun@skillswap.local', 'Excel', 'teach', 'Intermediate'],
      ['arun@skillswap.local', 'Guitar', 'learn', 'Beginner'],
      ['meera@skillswap.local', 'Cooking', 'teach', 'Expert'],       // Meera <-> Divya = perfect pair
      ['meera@skillswap.local', 'Yoga', 'learn', 'Beginner'],
      ['divya@skillswap.local', 'Yoga', 'teach', 'Intermediate'],
      ['divya@skillswap.local', 'Cooking', 'learn', 'Beginner'],
      ['divya@skillswap.local', 'Guitar', 'learn', 'Beginner'],      // only a partial match for Priya
      ['karthik@skillswap.local', 'Python', 'teach', 'Expert'],
      ['karthik@skillswap.local', 'Web Design', 'learn', 'Intermediate'],
      ['ravi@skillswap.local', 'Photography', 'teach', 'Intermediate'],
      ['ravi@skillswap.local', 'Spanish', 'learn', 'Beginner'],
    ];
    for (const [email, skill, type, level] of links) {
      await run(
        `INSERT OR IGNORE INTO user_skills (user_id, skill_id, type, level)
         VALUES ((SELECT id FROM users WHERE email = ?), (SELECT id FROM skills WHERE name = ?), ?, ?)`,
        [email, skill, type, level]
      );
    }

    const uid = async (email) => (await get('SELECT id FROM users WHERE email = ?', [email])).id;
    const sid = async (name) => (await get('SELECT id FROM skills WHERE name = ?', [name])).id;

    // A pending request so the Requests page is not empty: Ravi -> Priya
    await run(
      `INSERT INTO requests (from_user_id, to_user_id, offered_skill_id, wanted_skill_id, message)
       VALUES (?,?,?,?,?)`,
      [await uid('ravi@skillswap.local'), await uid('priya@skillswap.local'),
        await sid('Photography'), await sid('Guitar'),
        'Hi Priya, I can teach photography if you can show me guitar.']);

    // An accepted swap with a small chat so Messages is not empty: Divya <-> Meera
    const divya = await uid('divya@skillswap.local');
    const meera = await uid('meera@skillswap.local');
    await run(
      `INSERT INTO requests (from_user_id, to_user_id, offered_skill_id, wanted_skill_id, message, status)
       VALUES (?,?,?,?,?, 'accepted')`,
      [divya, meera, await sid('Yoga'), await sid('Cooking'), 'I would love to learn cooking from you!']);
    const key = Math.min(divya, meera) + '-' + Math.max(divya, meera);
    await run("INSERT INTO conversations (type, direct_key) VALUES ('direct', ?)", [key]);
    const conv = (await get('SELECT id FROM conversations WHERE direct_key = ?', [key])).id;
    const say = async (sender, body, ago) => {
      await run("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?, datetime('now', ?))",
        [conv, sender, body, ago]);
      return (await get('SELECT last_insert_rowid() AS id')).id;
    };
    await say(divya, 'Hi Meera! Excited to learn cooking from you.', '-3 hours');
    const second = await say(meera, 'Hi Divya! Happy to. When are you free?', '-2 hours');
    const third = await say(divya, 'How about Saturday morning? I can start your yoga basics after.', '-1 hours');
    await run('INSERT INTO conversation_members (conversation_id, user_id, last_read_id) VALUES (?,?,?)', [conv, divya, third]);
    await run('INSERT INTO conversation_members (conversation_id, user_id, last_read_id) VALUES (?,?,?)', [conv, meera, second]);

    // Two skill rooms with a little conversation, so the Rooms page is not empty
    const room = async (skill, members, lines) => {
      await run("INSERT INTO conversations (type, title, skill_id) VALUES ('room', ?, ?)", [skill + ' room', await sid(skill)]);
      const roomId = (await get('SELECT last_insert_rowid() AS id')).id;
      let last = 0;
      for (const [who, body, ago] of lines) {
        await run("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?, datetime('now', ?))",
          [roomId, await uid(who + '@skillswap.local'), body, ago]);
        last = (await get('SELECT last_insert_rowid() AS id')).id;
      }
      for (const who of members) {
        await run(
          'INSERT INTO conversation_members (conversation_id, user_id, last_read_id) VALUES (?,?,?)',
          [roomId, await uid(who + '@skillswap.local'), last]);
      }
    };
    await room('Guitar', ['priya', 'arun', 'divya'], [
      ['priya', 'Welcome to the Guitar room! Share tips and ask questions here.', '-2 days'],
      ['arun', 'Any easy first songs for a total beginner?', '-5 hours'],
      ['priya', 'Start with songs that use only 3 chords. Practise 10 minutes every day.', '-4 hours'],
    ]);
    await room('Excel', ['arun', 'priya'], [
      ['arun', 'Tip: learn VLOOKUP, then move to XLOOKUP. It saves a lot of time.', '-1 days'],
    ]);

    console.log('Sample accounts (password for all: ' + DEMO_PASSWORD + '):');
    for (const u of users) console.log('  ' + u[1] + '  (' + u[0] + ')');
  });
}

module.exports = { init, all, get, run, tx, DEMO_PASSWORD, isRemote: Boolean(REMOTE_URL) };
