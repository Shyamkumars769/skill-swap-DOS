// chat.js - small helpers shared by the requests and messages routes
const db = require('./db');

// Has either person blocked the other?
async function isBlocked(a, b) {
  return !!(await db.get(
    `SELECT 1 AS x FROM blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    [a, b, b, a]));
}

// One direct chat per pair of people. The key looks like "3-7" (smaller id first).
function directKey(a, b) {
  return Math.min(a, b) + '-' + Math.max(a, b);
}

// Find the direct chat between two people, or create it. Returns the conversation id.
async function ensureDirectConversation(a, b) {
  const key = directKey(a, b);
  const found = await db.get('SELECT id FROM conversations WHERE direct_key = ?', [key]);
  if (found) return found.id;
  const id = (await db.run("INSERT INTO conversations (type, direct_key) VALUES ('direct', ?)", [key])).id;
  await db.run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [id, a]);
  await db.run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [id, b]);
  return id;
}

module.exports = { isBlocked, directKey, ensureDirectConversation };
