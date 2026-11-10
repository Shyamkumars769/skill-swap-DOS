// routes/auth.js - sign up, log in, log out, change / reset password, delete account
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, createSession, destroySession, passwordError, hashToken, wrap } = require('../auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTEMPTS = 5;      // wrong passwords before a short lock
const LOCK_MINUTES = 5;
// In demo mode the reset link is shown on screen (we have no email server).
// Start the server with DEMO_MODE=off to hide it and the demo account list.
const DEMO = process.env.DEMO_MODE !== 'off';
// Used so that "unknown email" takes as long as "wrong password" (no timing clues)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', 10);

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

// POST /api/auth/signup
router.post('/auth/signup', wrap(async (req, res) => {
  const name = clean(req.body.name);
  const email = clean(req.body.email).toLowerCase();
  const password = req.body.password;
  if (name.length < 2 || name.length > 50) return res.status(400).json({ error: 'Name must be 2 to 50 characters' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  const pwError = passwordError(password);
  if (pwError) return res.status(400).json({ error: pwError });
  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  let id;
  try {
    id = (await db.run('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)', [name, email, hash])).id;
  } catch (e) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  await createSession(res, id);
  res.status(201).json({ id, name, email });
}));

// POST /api/auth/login
router.post('/auth/login', wrap(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!EMAIL_RE.test(email) || !password) return res.status(400).json({ error: 'Enter your email and password' });

  const user = await db.get(
    `SELECT *, (locked_until IS NOT NULL AND locked_until > datetime('now')) AS locked
     FROM users WHERE email = ?`, [email]);
  if (user && user.locked) {
    return res.status(429).json({ error: `Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes.` });
  }

  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.run(`UPDATE users SET failed_attempts = 0, locked_until = datetime('now', '+${LOCK_MINUTES} minutes') WHERE id = ?`, [user.id]);
      } else {
        await db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', [attempts, user.id]);
      }
    }
    // Same message for "no such email" and "wrong password" on purpose
    return res.status(400).json({ error: 'Wrong email or password' });
  }

  if (user.failed_attempts > 0 || user.locked_until) {
    await db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
  }
  await createSession(res, user.id);
  res.json({ id: user.id, name: user.name, email: user.email });
}));

// POST /api/auth/logout
router.post('/auth/logout', wrap(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

// GET /api/auth/me  -> who is logged in (401 if nobody)
router.get('/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// GET /api/auth/demo -> sample accounts for the login page (demo mode only)
router.get('/auth/demo', wrap(async (req, res) => {
  if (!DEMO) return res.json({ accounts: [] });
  res.json({
    password: db.DEMO_PASSWORD,
    accounts: await db.all("SELECT name, email FROM users WHERE email LIKE '%@skillswap.local' ORDER BY id"),
  });
}));

// POST /api/auth/change-password  { currentPassword, newPassword }
router.post('/auth/change-password', requireAuth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, user.password_hash)))
    return res.status(400).json({ error: 'Current password is wrong' });
  const pwError = passwordError(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  if (newPassword === currentPassword) return res.status(400).json({ error: 'New password must be different' });

  const hash = await bcrypt.hash(newPassword, 10);
  await db.tx(async () => {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    // log out every OTHER device, keep this one
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [req.user.id, req.sessionHash]);
  });
  res.json({ ok: true });
}));

// POST /api/auth/forgot  { email }  -> creates a reset link that works for 30 minutes
router.post('/auth/forgot', wrap(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });

  const out = { message: 'If that email is registered, a reset link has been created.' };
  const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.tx(async () => {
      await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);
      await db.run(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES (?, ?, datetime('now', '+30 minutes'))`, [user.id, hashToken(token)]);
    });
    const link = `${req.protocol}://${req.get('host')}/reset.html?token=${token}`;
    console.log('Password reset link for ' + email + ':\n  ' + link);
    if (DEMO) out.resetLink = link;
  }
  res.json(out);
}));

// POST /api/auth/reset  { token, password }
router.post('/auth/reset', wrap(async (req, res) => {
  const token = clean(req.body.token);
  const pwError = passwordError(req.body.password);
  if (pwError) return res.status(400).json({ error: pwError });

  const row = await db.get(
    `SELECT id, user_id FROM password_resets
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`, [hashToken(token)]);
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

  const hash = await bcrypt.hash(req.body.password, 10);
  await db.tx(async () => {
    await db.run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', [hash, row.user_id]);
    await db.run("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?", [row.id]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [row.user_id]); // log out everywhere
  });
  res.json({ ok: true });
}));

// DELETE /api/auth/account  { password }  -> permanently delete my account
router.delete('/auth/account', requireAuth, wrap(async (req, res) => {
  const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!(await bcrypt.compare(password, user.password_hash))) return res.status(400).json({ error: 'Password is wrong' });

  const me = req.user.id;
  await db.tx(async () => {
    // Remove this person's data explicitly, so the cleanup does not depend on
    // the database enforcing foreign keys (hosted libSQL connections can differ).
    const direct = await db.all(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
       WHERE c.type = 'direct' AND m.user_id = ?`, [me]);

    await db.run('UPDATE messages SET sender_id = NULL WHERE sender_id = ?', [me]); // keep room history
    await db.run('DELETE FROM reviews WHERE reviewer_id = ? OR reviewee_id = ?', [me, me]);
    await db.run('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?', [me, me]);
    await db.run('DELETE FROM requests WHERE from_user_id = ? OR to_user_id = ?', [me, me]);
    await db.run('DELETE FROM password_resets WHERE user_id = ?', [me]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [me]);
    await db.run('DELETE FROM user_skills WHERE user_id = ?', [me]);
    await db.run('DELETE FROM conversation_members WHERE user_id = ?', [me]);

    // A direct chat needs 2 people, so remove chats that lost one (their messages go too)
    for (const conv of direct) {
      await db.run('DELETE FROM messages WHERE conversation_id = ?', [conv.id]);
      await db.run('DELETE FROM conversation_members WHERE conversation_id = ?', [conv.id]);
      await db.run('DELETE FROM conversations WHERE id = ?', [conv.id]);
    }

    await db.run('DELETE FROM users WHERE id = ?', [me]);
  });
  await destroySession(req, res);
  res.json({ deleted: true });
}));

module.exports = router;
