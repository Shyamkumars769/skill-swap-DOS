// routes/rooms.js - group rooms: one chat room per skill (Guitar room, Excel room ...)
// Anyone can join or leave. Messages are sent with the same routes as direct chats.
const router = require('express').Router();
const db = require('../db');
const { wrap } = require('../auth');

const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// GET /api/rooms -> every skill with its room info.
// "mine" says whether I teach or want to learn that skill, so relevant rooms come first.
router.get('/rooms', wrap(async (req, res) => {
  const me = req.user.id;
  const rows = await db.all(
    `SELECT s.id AS skillId, s.name, c.id AS roomId,
            (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS members,
            EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?) AS joined,
            (SELECT group_concat(us.type) FROM user_skills us WHERE us.user_id = ? AND us.skill_id = s.id) AS mine
     FROM skills s
     LEFT JOIN conversations c ON c.skill_id = s.id AND c.type = 'room'`, [me, me]);
  rows.sort((a, b) =>
    (b.joined - a.joined) || ((b.mine ? 1 : 0) - (a.mine ? 1 : 0)) || (b.members - a.members) || a.name.localeCompare(b.name));
  res.json(rows.map((r) => ({ ...r, joined: !!r.joined })));
}));

// POST /api/rooms/:skillId/join -> join (the room is created the first time)
router.post('/rooms/:skillId/join', wrap(async (req, res) => {
  const me = req.user.id;
  const skillId = toId(req.params.skillId);
  const skill = skillId && await db.get('SELECT id, name FROM skills WHERE id = ?', [skillId]);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  const roomId = await db.tx(async () => {
    const room = await db.get("SELECT id FROM conversations WHERE type = 'room' AND skill_id = ?", [skillId]);
    const id = room ? room.id
      : (await db.run("INSERT INTO conversations (type, title, skill_id) VALUES ('room', ?, ?)", [skill.name + ' room', skillId])).id;
    // start "read up to now" so old messages are not counted as unread
    const newest = (await db.get('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?', [id])).id || 0;
    await db.run('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, last_read_id) VALUES (?,?,?)', [id, me, newest]);
    return id;
  });
  res.json({ conversationId: roomId });
}));

// POST /api/rooms/:skillId/leave
router.post('/rooms/:skillId/leave', wrap(async (req, res) => {
  const skillId = toId(req.params.skillId);
  await db.run(
    `DELETE FROM conversation_members WHERE user_id = ? AND conversation_id IN
       (SELECT id FROM conversations WHERE type = 'room' AND skill_id = ?)`, [req.user.id, skillId]);
  res.json({ left: true });
}));

module.exports = router;
