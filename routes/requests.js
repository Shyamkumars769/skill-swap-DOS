// routes/requests.js - swap requests: send, list, accept/decline, complete, review, cancel
// Life of a request:  pending -> accepted -> completed   (or pending -> declined)
const router = require('express').Router();
const db = require('../db');
const { isBlocked, ensureDirectConversation } = require('../chat');
const { wrap } = require('../auth');

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// POST /api/requests  -> send a swap request
router.post('/requests', wrap(async (req, res) => {
  const fromUserId = req.user.id;
  const toUserId = toId(req.body.toUserId);
  const wantedSkillId = toId(req.body.wantedSkillId);
  const offeredRaw = req.body.offeredSkillId;
  const offeredSkillId = offeredRaw == null || offeredRaw === '' ? null : toId(offeredRaw);
  const message = clean(req.body.message);

  if (!toUserId || !wantedSkillId) return res.status(400).json({ error: 'Missing request details' });
  if (fromUserId === toUserId) return res.status(400).json({ error: "You can't send a request to yourself" });
  if (!(await db.get('SELECT id FROM users WHERE id = ?', [toUserId]))) return res.status(404).json({ error: 'Person not found' });
  if (await isBlocked(fromUserId, toUserId)) return res.status(403).json({ error: "You can't send a request to this person" });
  if (message.length > 200) return res.status(400).json({ error: 'Message must be 200 characters or fewer' });
  if (offeredRaw != null && offeredRaw !== '' && !offeredSkillId) return res.status(400).json({ error: 'Pick a skill you teach' });

  // The skill I want must really be taught by the other person
  if (!(await db.get(`SELECT id FROM user_skills WHERE user_id=? AND skill_id=? AND type='teach'`, [toUserId, wantedSkillId])))
    return res.status(400).json({ error: "They don't teach that skill" });
  // The skill I offer (if any) must really be taught by me
  if (offeredSkillId && !(await db.get(`SELECT id FROM user_skills WHERE user_id=? AND skill_id=? AND type='teach'`, [fromUserId, offeredSkillId])))
    return res.status(400).json({ error: "You don't teach that skill" });

  // No duplicate pending request (IS compares NULL safely in SQLite)
  if (await db.get(
    `SELECT id FROM requests WHERE from_user_id=? AND to_user_id=? AND wanted_skill_id=?
       AND offered_skill_id IS ? AND status='pending'`,
    [fromUserId, toUserId, wantedSkillId, offeredSkillId]))
    return res.status(409).json({ error: 'You already sent this request' });

  await db.run(
    `INSERT INTO requests (from_user_id, to_user_id, offered_skill_id, wanted_skill_id, message)
     VALUES (?,?,?,?,?)`, [fromUserId, toUserId, offeredSkillId, wantedSkillId, message]);
  res.status(201).json({ sent: true });
}));

// GET /api/requests  -> incoming and sent. Emails are never included.
router.get('/requests', wrap(async (req, res) => {
  const me = req.user.id;
  const sql = (otherCol, myCol) =>
    `SELECT r.id, r.status, r.message, r.created_at AS createdAt,
            u.id AS otherId, u.name AS otherName,
            offered.name AS offeredName, wanted.name AS wantedName,
            c.id AS conversationId,
            EXISTS (SELECT 1 FROM reviews rv WHERE rv.request_id = r.id AND rv.reviewer_id = ?) AS reviewed,
            EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ? AND bl.blocked_id = u.id)
                                               OR (bl.blocker_id = u.id AND bl.blocked_id = ?)) AS blocked
     FROM requests r
     JOIN users u ON u.id = r.${otherCol}
     JOIN skills wanted ON wanted.id = r.wanted_skill_id
     LEFT JOIN skills offered ON offered.id = r.offered_skill_id
     LEFT JOIN conversations c ON r.status IN ('accepted','completed') AND c.direct_key =
          (CASE WHEN r.from_user_id < r.to_user_id THEN r.from_user_id || '-' || r.to_user_id
                ELSE r.to_user_id || '-' || r.from_user_id END)
     WHERE r.${myCol} = ?
     ORDER BY r.created_at DESC, r.id DESC`;

  const incoming = await db.all(sql('from_user_id', 'to_user_id'), [me, me, me, me]);
  const sent = await db.all(sql('to_user_id', 'from_user_id'), [me, me, me, me]);
  res.json({ incoming, sent, pending: incoming.filter((r) => r.status === 'pending').length });
}));

// PUT /api/requests/:id  { status }
//   'accepted' / 'declined' -> only the receiver, only while pending
//   'completed'             -> either person, only while accepted
router.put('/requests/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  const me = req.user.id;
  const status = req.body.status;
  if (!id || !['accepted', 'declined', 'completed'].includes(status)) return res.status(400).json({ error: 'Missing request' });

  const r = await db.get('SELECT from_user_id, to_user_id, status FROM requests WHERE id = ?', [id]);
  if (!r || (r.from_user_id !== me && r.to_user_id !== me)) return res.status(404).json({ error: 'Request not found' });

  if (status === 'completed') {
    if (r.status !== 'accepted') return res.status(403).json({ error: 'Only an accepted swap can be completed' });
    await db.run("UPDATE requests SET status = 'completed' WHERE id = ?", [id]);
    return res.json({ status });
  }

  if (r.to_user_id !== me) return res.status(403).json({ error: 'Only the receiver can respond' });
  if (r.status !== 'pending') return res.status(403).json({ error: 'This request is no longer pending' });
  if (status === 'accepted' && await isBlocked(me, r.from_user_id)) return res.status(403).json({ error: "You can't accept this request" });

  await db.tx(async () => {
    await db.run('UPDATE requests SET status = ? WHERE id = ?', [status, id]);
    // Accepting opens a private chat between the two people
    if (status === 'accepted') await ensureDirectConversation(r.from_user_id, r.to_user_id);
  });
  res.json({ status });
}));

// POST /api/requests/:id/review  { rating 1-5, comment }  -> rate the other person after a completed swap
router.post('/requests/:id/review', wrap(async (req, res) => {
  const id = toId(req.params.id);
  const me = req.user.id;
  const rating = Number(req.body.rating);
  const comment = clean(req.body.comment);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Pick a rating from 1 to 5' });
  if (comment.length > 300) return res.status(400).json({ error: 'Comment must be 300 characters or fewer' });

  const r = await db.get('SELECT from_user_id, to_user_id, status FROM requests WHERE id = ?', [id]);
  if (!r || (r.from_user_id !== me && r.to_user_id !== me)) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'completed') return res.status(403).json({ error: 'You can review after the swap is completed' });
  if (await db.get('SELECT id FROM reviews WHERE request_id = ? AND reviewer_id = ?', [id, me]))
    return res.status(409).json({ error: 'You already reviewed this swap' });

  const other = r.from_user_id === me ? r.to_user_id : r.from_user_id;
  await db.run('INSERT INTO reviews (request_id, reviewer_id, reviewee_id, rating, comment) VALUES (?,?,?,?,?)',
    [id, me, other, rating, comment]);
  res.status(201).json({ reviewed: true });
}));

// DELETE /api/requests/:id  -> sender cancels (only while pending)
router.delete('/requests/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  const r = await db.get('SELECT from_user_id, status FROM requests WHERE id = ?', [id]);
  if (!r || r.from_user_id !== req.user.id) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'pending') return res.status(403).json({ error: 'This request is no longer pending' });
  await db.run('DELETE FROM requests WHERE id = ?', [id]);
  res.json({ cancelled: true });
}));

module.exports = router;
