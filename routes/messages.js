// routes/messages.js - in-app chat
// A chat opens automatically when a swap request is accepted.
// The page checks for new messages every few seconds ("polling").
const router = require('express').Router();
const db = require('../db');
const { isBlocked } = require('../chat');
const { wrap } = require('../auth');

const MAX_LENGTH = 500;          // longest message allowed
const MAX_PER_MINUTE = 20;       // slow down message floods
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// Is this person a member of the conversation? Returns the conversation or undefined.
async function myConversation(conversationId, userId) {
  return db.get(
    `SELECT c.id, c.type, c.title, c.skill_id AS skillId, cm.last_read_id
     FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.id = ? AND cm.user_id = ?`, [conversationId, userId]);
}

// The other person in a direct chat
async function otherPerson(conversationId, userId) {
  return db.get(
    `SELECT u.id, u.name FROM conversation_members m JOIN users u ON u.id = m.user_id
     WHERE m.conversation_id = ? AND m.user_id != ?`, [conversationId, userId]);
}

// GET /api/conversations -> my chats, newest first, with unread counts
router.get('/conversations', wrap(async (req, res) => {
  const me = req.user.id;
  const rows = await db.all(
    `SELECT c.id, c.type, c.title, c.created_at AS createdAt,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.id > cm.last_read_id
           AND (m.sender_id IS NULL OR m.sender_id != ?)) AS unread,
        (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastBody,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS lastAt
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
     ORDER BY COALESCE(lastAt, c.created_at) DESC, c.id DESC`, [me, me]);

  const out = [];
  for (const c of rows) {
    const other = c.type === 'direct' ? await otherPerson(c.id, me) : null;
    out.push({
      id: c.id, type: c.type,
      title: other ? other.name : c.title,
      otherUserId: other ? other.id : null,
      blocked: other ? await isBlocked(me, other.id) : false,
      unread: c.unread, lastBody: c.lastBody, lastAt: c.lastAt,
    });
  }
  res.json(out);
}));

// GET /api/conversations/:id/messages?after=ID -> messages (only the new ones if "after" is given)
router.get('/conversations/:id/messages', wrap(async (req, res) => {
  const me = req.user.id;
  const id = toId(req.params.id);
  const conv = id && await myConversation(id, me);
  if (!conv) return res.status(404).json({ error: 'Chat not found' });

  const after = toId(req.query.after) || 0;
  // In group rooms, messages from people I blocked are hidden from me
  const hideBlocked = conv.type === 'room'
    ? ` AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ${me}))`
    : '';
  const select = `SELECT m.id, m.sender_id AS senderId, u.name AS senderName, m.body, m.created_at AS createdAt
                  FROM messages m LEFT JOIN users u ON u.id = m.sender_id`;
  const messages = after
    ? await db.all(`${select} WHERE m.conversation_id = ? AND m.id > ?${hideBlocked} ORDER BY m.id ASC LIMIT 200`, [id, after])
    : await db.all(`SELECT * FROM (${select} WHERE m.conversation_id = ?${hideBlocked} ORDER BY m.id DESC LIMIT 100) ORDER BY id ASC`, [id]);

  // Opening the chat marks everything as read (we only write when something changed)
  const newest = (await db.get('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?', [id])).id || 0;
  if (newest > conv.last_read_id) {
    await db.run('UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', [newest, id, me]);
  }

  const other = conv.type === 'direct' ? await otherPerson(id, me) : null;
  res.json({
    title: other ? other.name : conv.title,
    type: conv.type,
    otherUserId: other ? other.id : null,
    blocked: other ? await isBlocked(me, other.id) : false,
    skillId: conv.skillId || null,
    members: conv.type === 'room'
      ? (await db.get('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?', [id])).n : 2,
    maxLength: MAX_LENGTH,
    messages: messages.map((m) => ({ ...m, mine: m.senderId === me })),
  });
}));

// POST /api/conversations/:id/messages  { body } -> send a message (1 to 500 characters)
router.post('/conversations/:id/messages', wrap(async (req, res) => {
  const me = req.user.id;
  const id = toId(req.params.id);
  const conv = id && await myConversation(id, me);
  if (!conv) return res.status(404).json({ error: 'Chat not found' });

  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 1 || body.length > MAX_LENGTH)
    return res.status(400).json({ error: `Message must be 1 to ${MAX_LENGTH} characters` });

  if (conv.type === 'direct') {
    const other = await otherPerson(id, me);
    if (!other || await isBlocked(me, other.id)) return res.status(403).json({ error: "You can't message this person" });
  }

  const recent = (await db.get(
    `SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at > datetime('now', '-1 minute')`, [me])).n;
  if (recent >= MAX_PER_MINUTE) return res.status(429).json({ error: 'You are sending messages too fast. Wait a moment.' });

  const messageId = await db.tx(async () => {
    const newId = (await db.run('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)', [id, me, body])).id;
    // my own message counts as read for me
    await db.run('UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', [newId, id, me]);
    return newId;
  });
  res.status(201).json({ id: messageId });
}));

module.exports = router;
