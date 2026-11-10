// app.js - shared helpers used by every page

// Pages anyone can open without logging in
const PUBLIC_PAGES = ['', 'index.html', 'login.html', 'signup.html', 'forgot.html', 'reset.html'];
const PAGE = window.location.pathname.split('/').pop();

// Escape text before putting it into HTML (prevents XSS)
function esc(text) {
  const d = document.createElement('div');
  d.textContent = text == null ? '' : String(text);
  return d.innerHTML;
}

// A stable colour for a name: the same name always gets the same colour,
// picked from a hand-made palette so the avatars look varied and pleasant.
const HUES = [8, 24, 150, 175, 205, 232, 280, 330];
function hueFor(text) {
  let h = 2166136261;                       // FNV-1a hash
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return HUES[h % HUES.length];
}
function gradientFor(text) {
  return `hsl(${hueFor(text)} 22% 22%)`;   // flat plate colour
}

// Round avatar with the person's initials
function avatarHtml(name, size = 44) {
  const text = String(name || '?').trim();
  const words = text.split(/\s+/);
  const initials = ((words[0] || '?')[0] + (words.length > 1 ? words[1][0] : '')).toUpperCase();
  return `<span class="avatar" style="--s:${size}px;background:${gradientFor(text)}">${esc(initials)}</span>`;
}

// Skill chip: kind is 'teach' (green) or 'learn' (coral). level is optional.
function chipHtml(skill, kind, withLevel = true) {
  return `<span class="chip ${kind}">${esc(skill.name)}${withLevel && skill.level ? ` <span class="meta">${esc(skill.level)}</span>` : ''}</span>`;
}

// Call the backend. Returns the JSON, or throws an Error with the server's message.
// The login cookie is sent automatically. A 401 means "not logged in" -> go to login.
async function api(url, method = 'GET', body) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && !PUBLIC_PAGES.includes(PAGE)) {
    window.location.href = 'login.html';
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

// Success or error message. Lives in an aria-live region so screen readers announce it.
function showMessage(text, type = 'success') {
  let region = document.getElementById('toasts');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toasts';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  region.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'banner' + (type === 'error' ? ' error' : '');
  if (type === 'error') el.setAttribute('role', 'alert');
  el.textContent = text;
  region.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

// "2026-11-06 01:36:21" (UTC from the database) -> local time text
function parseTime(text) { return new Date(String(text).replace(' ', 'T') + 'Z'); }
function timeText(text) {
  return parseTime(text).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dateText(text) { return parseTime(text).toLocaleDateString(); }

// Rating shown as stars: "★ 4.5 (3)"
function ratingHtml(r) {
  return r && r.count
    ? `<span class="stars">★ ${esc(r.avg)}</span> <span class="meta">(${r.count})</span>`
    : '<span class="meta">No reviews yet</span>';
}

// List states: loading and error-with-retry, shared by every list page
function listLoading(el, text) { el.innerHTML = `<div class="empty" role="status">${esc(text)}</div>`; }
function listError(el, message, retry) {
  el.innerHTML = `<div class="empty" role="alert">${esc(message)}<br><button class="btn small ghost" type="button">Try again</button></div>`;
  el.querySelector('button').onclick = () => { listLoading(el, 'Loading...'); retry(); };
}

// The logged-in user. Call this first on every private page.
let ME = null;
async function requireLogin() {
  try { ME = await api('/api/auth/me'); return ME; }
  catch (e) { return null; }   // api() already redirected to login
}

async function logout() {
  try { await api('/api/auth/logout', 'POST'); } catch (e) { /* ignore */ }
  window.location.href = 'login.html';
}

// Navbar with live badges (new messages, pending requests), refreshed every 10 seconds
async function refreshBadges() {
  try {
    const c = await api('/api/me/counts');
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.innerHTML = n > 0 ? `<span class="badge">${n}<span class="sr"> new</span></span>` : ''; };
    set('badgeMessages', c.unreadMessages);
    set('badgeRequests', c.pendingRequests);
  } catch (e) { /* badges are optional */ }
}

function renderNavbar(active) {
  const pages = [
    ['browse.html', 'Browse', ''], ['matches.html', 'Matches', ''],
    ['messages.html', 'Messages', 'badgeMessages'], ['requests.html', 'Requests', 'badgeRequests'],
    ['rooms.html', 'Rooms', ''],
  ];
  const links = pages.map(([href, label, badge]) =>
    `<a class="link" href="${href}"${active === href ? ' aria-current="page"' : ''}>${label}${badge ? `<span id="${badge}"></span>` : ''}</a>`).join('');
  const main = document.querySelector('main');
  if (main) { main.id = 'main'; main.tabIndex = -1; }
  const skip = document.createElement('a');
  skip.className = 'skip'; skip.href = '#main'; skip.textContent = 'Skip to content';
  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = `<a class="brand" href="browse.html">Skill Swap</a><div class="links">${links}</div>
    <details class="menu"><summary aria-label="Account menu for ${esc(ME.name)}">${avatarHtml(ME.name, 36)}</summary>
      <div class="menu-pop">
        <div class="who"><strong>${esc(ME.name)}</strong><div class="meta">${esc(ME.email)}</div></div>
        <a href="profile.html">My profile &amp; settings</a>
        <button id="logoutBtn">Log out</button>
      </div></details>`;
  document.body.prepend(nav);
  document.body.prepend(skip);
  document.getElementById('logoutBtn').onclick = logout;
  const menu = nav.querySelector('.menu');
  // close the account menu on outside click or Escape
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.removeAttribute('open'); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.removeAttribute('open'); menu.querySelector('summary').focus(); } });
  refreshBadges();
  setInterval(refreshBadges, 10000);
}

// Small pop-up helper: real dialog semantics, Escape to close, focus trapped inside,
// focus returned to the opener. Callers can still just call overlay.remove().
function openOverlay(innerHtml) {
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1">${innerHtml}</div>`;
  const modal = overlay.firstElementChild;
  const heading = modal.querySelector('h1, h2, h3');
  if (heading) { heading.id = 'dlgTitle'; modal.setAttribute('aria-labelledby', 'dlgTitle'); }
  const focusables = () => [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); overlay.remove(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const nativeRemove = overlay.remove.bind(overlay);
  overlay.remove = () => {
    document.removeEventListener('keydown', onKey, true);
    document.body.style.overflow = '';
    nativeRemove();
    if (opener && opener.isConnected) opener.focus();
  };
  document.addEventListener('keydown', onKey, true);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  (focusables()[0] || modal).focus();
  return overlay;
}

// Pop-up form to send a swap request (used on Browse, Matches and profile pop-ups)
// options: { toUserId, toName, theirSkills: [{id,name}], wantedId?, offeredId? }
async function openSwapModal(options) {
  let mySkills = [];
  try { mySkills = await api('/api/me/teach-skills'); }
  catch (e) { return showMessage(e.message, 'error'); }

  const offerOptions = mySkills.map((s) => `<option value="${s.id}" ${s.id === options.offeredId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const wantOptions = options.theirSkills.map((s) => `<option value="${s.id}" ${s.id === options.wantedId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

  const overlay = openOverlay(`
      <h3>Request a swap with ${esc(options.toName)}</h3>
      <label class="field">You offer
        <select id="offerSel" ${mySkills.length ? '' : 'disabled'}>
          ${mySkills.length ? offerOptions : '<option value="">(You have no teach skills yet)</option>'}
        </select>
      </label>
      <label class="field">You want
        <select id="wantSel">${wantOptions}</select>
      </label>
      <label class="field">Message (optional, max 200 characters)
        <textarea id="msgBox" rows="3" maxlength="200"></textarea>
      </label>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" id="cancelBtn">Cancel</button>
        <button class="btn" id="sendBtn">Send</button>
      </div>`);
  document.getElementById('cancelBtn').onclick = () => overlay.remove();
  document.getElementById('sendBtn').onclick = async () => {
    try {
      await api('/api/requests', 'POST', {
        toUserId: options.toUserId,
        offeredSkillId: mySkills.length ? Number(document.getElementById('offerSel').value) : null,
        wantedSkillId: Number(document.getElementById('wantSel').value),
        message: document.getElementById('msgBox').value,
      });
      overlay.remove();
      showMessage('Request sent!');
    } catch (e) { showMessage(e.message, 'error'); }
  };
}

// Block a person (asks first). Returns true if blocked.
async function blockPerson(userId, name) {
  if (!window.confirm(`Block ${name}? They won't be able to find you, send requests or message you. You can unblock them later from My Profile.`)) return false;
  try {
    await api('/api/blocks', 'POST', { userId });
    showMessage(`${name} is blocked`);
    return true;
  } catch (e) { showMessage(e.message, 'error'); return false; }
}

// Pop-up with someone's skills, rating, reviews and a Block button
// onChange is called after the person was blocked, so the page can refresh its list
async function openProfileModal(userId, onChange) {
  let p;
  try { p = await api(`/api/users/${userId}/public`); }
  catch (e) { return showMessage(e.message, 'error'); }
  const chips = (list, kind) => list.length
    ? list.map((s) => chipHtml(s, kind)).join('')
    : '<span class="meta">Nothing listed</span>';
  const reviews = p.reviews.length
    ? p.reviews.map((r) => `<div class="review"><span class="stars">${'★'.repeat(r.rating)}</span> <span class="meta">by ${esc(r.reviewerName)}</span>${r.comment ? `<div>${esc(r.comment)}</div>` : ''}</div>`).join('')
    : '<div class="meta">No reviews yet.</div>';
  const isMe = ME && p.id === ME.id;
  const overlay = openOverlay(`
      <div class="person">${avatarHtml(p.name, 56)}<div class="info"><h3>${esc(p.name)}</h3><div>${ratingHtml(p.rating)}</div></div></div>
      <div><div class="kicker">Teaches</div><div class="row">${chips(p.teach, 'teach')}</div></div>
      <div><div class="kicker">Wants to learn</div><div class="row">${chips(p.learn, 'learn')}</div></div>
      <div><div class="kicker">Reviews</div>${reviews}</div>
      <div class="row" style="justify-content:flex-end">
        ${isMe ? '' : '<button class="btn danger small" id="blockBtn">Block</button>'}
        <button class="btn ghost small" id="closeBtn">Close</button>
      </div>`);
  document.getElementById('closeBtn').onclick = () => overlay.remove();
  const blockBtn = document.getElementById('blockBtn');
  if (blockBtn) blockBtn.onclick = async () => {
    if (await blockPerson(p.id, p.name)) { overlay.remove(); if (onChange) onChange(); }
  };
}
