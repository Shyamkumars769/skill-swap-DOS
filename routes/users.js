// routes/users.js - my profile, my skills, browse, matches, public profiles, blocks
// Every route here needs a logged-in user (req.user comes from requireAuth).
const router = require('express').Router();
const db = require('../db');
const { isBlocked } = require('../chat');
const { wrap } = require('../auth');

const LEVELS = ['Beginner', 'Intermediate', 'Expert'];
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// SQL piece: leaves out people who blocked me or whom I blocked (needs params: me, me)
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM blocks bl
  WHERE (bl.blocker_id = ? AND bl.blocked_id = u.id) OR (bl.blocker_id = u.id AND bl.blocked_id = ?))`;

// Average rating and number of reviews for everyone
async function ratingMap() {
  const map = new Map();
  (await db.all('SELECT reviewee_id AS id, ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM reviews GROUP BY reviewee_id'))
    .forEach((r) => map.set(r.id, { avg: r.avg, count: r.n }));
  return map;
}
const ratingOf = (map, id) => map.get(id) || { avg: null, count: 0 };

async function skillLists(userId) {
  const rows = await db.all(
    `SELECT us.id AS userSkillId, s.id AS skillId, s.name, us.type, us.level
     FROM user_skills us JOIN skills s ON s.id = us.skill_id
     WHERE us.user_id = ? ORDER BY s.name`, [userId]);
  return { teach: rows.filter((r) => r.type === 'teach'), learn: rows.filter((r) => r.type === 'learn') };
}

// GET /api/me/profile
router.get('/me/profile', wrap(async (req, res) => {
  res.json({
    user: req.user,
    ...(await skillLists(req.user.id)),
    rating: ratingOf(await ratingMap(), req.user.id),
  });
}));

// PUT /api/me  { name }
router.put('/me', wrap(async (req, res) => {
  const name = clean(req.body.name);
  if (name.length < 2 || name.length > 50) return res.status(400).json({ error: 'Name must be 2 to 50 characters' });
  await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  res.json({ name });
}));

// GET /api/me/counts  -> numbers for the navbar badges
router.get('/me/counts', wrap(async (req, res) => {
  const me = req.user.id;
  const unread = (await db.get(
    `SELECT COUNT(*) AS n FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     WHERE m.id > cm.last_read_id AND (m.sender_id IS NULL OR m.sender_id != ?)`, [me, me])).n;
  const pending = (await db.get("SELECT COUNT(*) AS n FROM requests WHERE to_user_id = ? AND status = 'pending'", [me])).n;
  res.json({ unreadMessages: unread, pendingRequests: pending });
}));

// GET /api/me/teach-skills  -> skills I teach (for the request pop-up)
router.get('/me/teach-skills', wrap(async (req, res) => {
  res.json(await db.all(
    `SELECT s.id, s.name FROM user_skills us JOIN skills s ON s.id = us.skill_id
     WHERE us.user_id = ? AND us.type = 'teach' ORDER BY s.name`, [req.user.id]));
}));

// POST /api/me/skills  { skillId | skillName, type, level }
router.post('/me/skills', wrap(async (req, res) => {
  const userId = req.user.id;
  const { type, level } = req.body;
  if (type !== 'teach' && type !== 'learn') return res.status(400).json({ error: 'Pick teach or learn' });
  if (!LEVELS.includes(level)) return res.status(400).json({ error: 'Pick a level' });

  // Use the chosen skill, or create a new one if the user typed a new name
  let skillId = toId(req.body.skillId);
  if (!skillId) {
    const name = clean(req.body.skillName);
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Skill name must be 2 to 40 characters' });
    const found = await db.get('SELECT id FROM skills WHERE name = ? COLLATE NOCASE', [name]);
    skillId = found ? found.id : (await db.run('INSERT INTO skills (name) VALUES (?)', [name])).id;
  }
  if (!(await db.get('SELECT id FROM skills WHERE id = ?', [skillId]))) return res.status(404).json({ error: 'Skill not found' });

  const opposite = type === 'teach' ? 'learn' : 'teach';
  if (await db.get('SELECT id FROM user_skills WHERE user_id=? AND skill_id=? AND type=?', [userId, skillId, opposite]))
    return res.status(400).json({ error: "You can't teach and learn the same skill" });
  if (await db.get('SELECT id FROM user_skills WHERE user_id=? AND skill_id=? AND type=?', [userId, skillId, type]))
    return res.status(409).json({ error: 'That skill is already on this list' });

  await db.run('INSERT INTO user_skills (user_id, skill_id, type, level) VALUES (?,?,?,?)', [userId, skillId, type, level]);
  res.status(201).json({ skillId });
}));

// DELETE /api/me/skills/:usId
router.delete('/me/skills/:usId', wrap(async (req, res) => {
  const usId = toId(req.params.usId);
  if (!(await db.get('SELECT id FROM user_skills WHERE id = ? AND user_id = ?', [usId, req.user.id])))
    return res.status(404).json({ error: 'Skill not found' });
  await db.run('DELETE FROM user_skills WHERE id = ?', [usId]);
  res.json({ removed: true });
}));

// Group flat rows (one per skill) into one object per person
function groupPeople(rows, ratings) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.id)) map.set(r.id, { id: r.id, name: r.name, rating: ratingOf(ratings, r.id), teaches: [], learns: [] });
    map.get(r.id)[r.type === 'teach' ? 'teaches' : 'learns'].push({ id: r.skill_id, name: r.skill_name, level: r.level });
  });
  return [...map.values()];
}

// GET /api/browse?skill=&level=  -> search people by what they TEACH
router.get('/browse', wrap(async (req, res) => {
  const me = req.user.id;
  const skill = clean(req.query.skill);
  const level = clean(req.query.level);
  if (level && !LEVELS.includes(level)) return res.status(400).json({ error: 'Unknown level' });

  const rows = await db.all(
    `SELECT u.id, u.name, us.type, us.level, s.id AS skill_id, s.name AS skill_name
     FROM users u
     JOIN user_skills us ON us.user_id = u.id
     JOIN skills s ON s.id = us.skill_id
     WHERE u.id != ?
       AND ${NOT_BLOCKED}
       AND ((? = '' AND ? = '') OR EXISTS (
            SELECT 1 FROM user_skills ut JOIN skills st ON st.id = ut.skill_id
            WHERE ut.user_id = u.id AND ut.type = 'teach'
              AND (? = '' OR st.name LIKE ?) AND (? = '' OR ut.level = ?)))
     ORDER BY u.name, us.type, s.name`,
    [me, me, me, skill, level, skill, '%' + skill + '%', level, level]);
  res.json(groupPeople(rows, await ratingMap()));
}));

// GET /api/matches  -> perfect and partial matches
router.get('/matches', wrap(async (req, res) => {
  const me = req.user.id;
  const counts = await db.get(
    `SELECT SUM(type='teach') AS teach, SUM(type='learn') AS learn FROM user_skills WHERE user_id = ?`, [me]);
  if (!counts.teach || !counts.learn) return res.json({ needsSkills: true, perfect: [], partial: [] });
  const ratings = await ratingMap();

  // PERFECT MATCH (self-join): they teach what I want to learn AND they want to learn what I teach
  const perfectRows = await db.all(
    `SELECT DISTINCT u.id, u.name,
            s1.id AS they_teach_id, s1.name AS they_teach_you,
            s2.id AS you_teach_id,  s2.name AS you_teach_them
     FROM user_skills a_learn
     JOIN user_skills b_teach ON b_teach.skill_id = a_learn.skill_id
          AND b_teach.type = 'teach' AND b_teach.user_id != a_learn.user_id
     JOIN user_skills a_teach ON a_teach.user_id = a_learn.user_id
          AND a_teach.type = 'teach'
     JOIN user_skills b_learn ON b_learn.user_id = b_teach.user_id
          AND b_learn.type = 'learn' AND b_learn.skill_id = a_teach.skill_id
     JOIN users u ON u.id = b_teach.user_id
     JOIN skills s1 ON s1.id = a_learn.skill_id
     JOIN skills s2 ON s2.id = a_teach.skill_id
     WHERE a_learn.type = 'learn' AND a_learn.user_id = ?
       AND ${NOT_BLOCKED}
     ORDER BY u.name`, [me, me, me]);

  const perfectMap = new Map();
  perfectRows.forEach((r) => {
    if (!perfectMap.has(r.id)) perfectMap.set(r.id, { id: r.id, name: r.name, rating: ratingOf(ratings, r.id), pairs: [] });
    perfectMap.get(r.id).pairs.push({
      theyTeachId: r.they_teach_id, theyTeach: r.they_teach_you,
      youTeachId: r.you_teach_id, youTeach: r.you_teach_them,
    });
  });

  // PARTIAL MATCH: they teach something I want to learn (people already "perfect" are skipped)
  const partialRows = await db.all(
    `SELECT DISTINCT u.id, u.name, s.id AS skill_id, s.name AS skill_name
     FROM user_skills a_learn
     JOIN user_skills b_teach ON b_teach.skill_id = a_learn.skill_id
          AND b_teach.type = 'teach' AND b_teach.user_id != a_learn.user_id
     JOIN users u ON u.id = b_teach.user_id
     JOIN skills s ON s.id = b_teach.skill_id
     WHERE a_learn.type = 'learn' AND a_learn.user_id = ?
       AND ${NOT_BLOCKED}
     ORDER BY u.name, s.name`, [me, me, me]);

  const partialMap = new Map();
  partialRows.forEach((r) => {
    if (perfectMap.has(r.id)) return;
    if (!partialMap.has(r.id)) partialMap.set(r.id, { id: r.id, name: r.name, rating: ratingOf(ratings, r.id), teaches: [] });
    partialMap.get(r.id).teaches.push({ id: r.skill_id, name: r.skill_name });
  });

  res.json({ needsSkills: false, perfect: [...perfectMap.values()], partial: [...partialMap.values()] });
}));

// GET /api/users/:id/public  -> someone's skills, rating and reviews (never their email)
router.get('/users/:id/public', wrap(async (req, res) => {
  const id = toId(req.params.id);
  const user = id && await db.get('SELECT id, name FROM users WHERE id = ?', [id]);
  if (!user || (id !== req.user.id && await isBlocked(req.user.id, id))) return res.status(404).json({ error: 'Person not found' });
  const reviews = await db.all(
    `SELECT r.rating, r.comment, r.created_at AS createdAt, u.name AS reviewerName
     FROM reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.reviewee_id = ? ORDER BY r.id DESC LIMIT 10`, [id]);
  res.json({
    id: user.id, name: user.name,
    ...(await skillLists(id)),
    rating: ratingOf(await ratingMap(), id),
    reviews,
  });
}));

// ---- Blocking ----
// GET /api/blocks -> people I blocked
router.get('/blocks', wrap(async (req, res) => {
  res.json(await db.all(
    `SELECT u.id, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY u.name`, [req.user.id]));
}));

// POST /api/blocks  { userId }
router.post('/blocks', wrap(async (req, res) => {
  const me = req.user.id;
  const other = toId(req.body.userId);
  if (!other || !(await db.get('SELECT id FROM users WHERE id = ?', [other]))) return res.status(404).json({ error: 'Person not found' });
  if (other === me) return res.status(400).json({ error: "You can't block yourself" });
  await db.tx(async () => {
    await db.run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [me, other]);
    // pending requests between the two are removed (accepted swaps stay, but chat is switched off)
    await db.run(
      `DELETE FROM requests WHERE status = 'pending'
         AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
      [me, other, other, me]);
  });
  res.json({ blocked: true });
}));

// DELETE /api/blocks/:userId  -> unblock
router.delete('/blocks/:userId', wrap(async (req, res) => {
  await db.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, toId(req.params.userId)]);
  res.json({ unblocked: true });
}));

module.exports = router;
