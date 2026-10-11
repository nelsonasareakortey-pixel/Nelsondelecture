const $ = s => document.querySelector(s);
let token = localStorage.getItem('t'), me = null, S = {};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const h = {};
  if (token) h.Authorization = 'Bearer ' + token;
  if (opts.body && !(opts.body instanceof FormData)) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  const r = await fetch('/api' + path, { ...opts, headers: h });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
function md(t) {
  return esc(t).split('\n').map(l => {
    if (/^### /.test(l)) return '<h4>' + l.slice(4) + '</h4>';
    if (/^## /.test(l)) return '<h3>' + l.slice(3) + '</h3>';
    if (/^# /.test(l)) return '<h2>' + l.slice(2) + '</h2>';
    if (/^\s*[-*] /.test(l)) return '<li>' + l.replace(/^\s*[-*] /, '') + '</li>';
    return l.trim() ? '<p>' + l + '</p>' : '';
  }).join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(<li>.*?<\/li>)+/g, m => '<ul>' + m + '</ul>');
}

async function init() {
  S = await api('/settings');
  document.title = S.site_name;
  $('#logo').textContent = S.site_name;
  if (token) { try { me = await api('/me'); } catch { token = null; localStorage.removeItem('t'); } }
  renderNav(); go(me ? 'dash' : 'home');
}
function renderNav() {
  $('#nav').innerHTML = me
    ? `<button class="ghost" onclick="go('dash')">Create</button><button class="ghost" onclick="go('history')">My notes</button>
       <button class="ghost" onclick="go('library')">Library</button><button class="ghost" onclick="go('pricing')">Subscribe</button>
       ${me.is_admin ? '<a class="btn ghost" href="/admin.html" style="text-decoration:none">Admin</a>' : ''}
       <button class="ghost" onclick="logout()">Logout</button>`
    : `<button class="ghost" onclick="go('login')">Log in</button><button onclick="go('signup')">Sign up</button>`;
}
function logout() { localStorage.removeItem('t'); token = null; me = null; renderNav(); go('home'); }
function go(v, arg) { window.scrollTo(0, 0); (views[v] || views.home)(arg); }
function banner() {
  return S.announcement ? `<div class="notice">📢 ${esc(S.announcement)}</div>` : '';
}
function statusLine() {
  if (!me) return '';
  return me.active ? `<span class="badge on">Subscribed${me.is_admin ? ' (admin)' : ' until ' + new Date(me.sub_until).toLocaleDateString()}</span>`
    : `<span class="badge">${me.free_left} free ${me.free_left === 1 ? 'video' : 'videos'} left</span>`;
}

const views = {
  home() {
    $('#app').innerHTML = `${banner()}<div class="hero"><h1>${esc(S.site_name)}</h1><p>${esc(S.tagline)}</p>
      <p>Paste a YouTube link → get detailed notes, exam-style questions and flashcards in minutes.</p>
      <button onclick="go('signup')">Start free</button></div>
      <div class="card"><h3>What you get</h3><ul><li>📝 Structured study notes covering the whole video</li>
      <li>❓ Comprehensive MCQs, short-answer and essay questions with answers</li>
      <li>🃏 Flip-able flashcards for quick revision</li><li>📚 A library of textbooks and study materials</li></ul>
      <p>${esc(S.free_trials)} free videos, then <b>GH₵${esc(S.price)}/month</b>.</p></div>`;
  },
  login() { authForm(false); }, signup() { authForm(true); },
  dash() {
    if (!me) return go('login');
    $('#app').innerHTML = `${banner()}<div class="card"><div class="row"><h2 style="flex:3">Create study material</h2><div>${statusLine()}</div></div>
      <label>YouTube link</label><input id="yt" placeholder="https://www.youtube.com/watch?v=...">
      <button id="gen" onclick="generate()">Generate notes, quiz & flashcards</button>
      <div id="msg" class="err"></div><p style="color:var(--muted);font-size:.85rem">Works with videos that have captions. Long videos can take 1–2 minutes.</p></div><div id="result"></div>`;
  },
  async history() {
    $('#app').innerHTML = '<div class="card"><h2>My notes</h2><div id="h">Loading…</div></div>';
    const list = await api('/generations');
    $('#h').innerHTML = list.length ? list.map(g => `<div class="hist"><span onclick="openGen(${g.id})">${esc(g.title)}<br><small style="color:var(--muted)">${new Date(g.created_at).toLocaleDateString()}</small></span>
      <button class="ghost" onclick="delGen(${g.id})">🗑</button></div>`).join('') : 'Nothing yet.';
  },
  async library() {
    $('#app').innerHTML = '<div class="card"><h2>Library</h2><div id="l">Loading…</div></div>';
    const list = await api('/materials');
    $('#l').innerHTML = (me.active ? '' : '<div class="notice">Subscribe to download materials.</div>') +
      (list.length ? list.map(m => `<div class="q"><b>${esc(m.title)}</b> <span class="badge">${esc(m.category)}</span><br>
      <small style="color:var(--muted)">${esc(m.description)}</small><br>
      ${m.has_file ? `<a href="/api/materials/${m.id}/download?t=${token}">⬇ Download</a>` : ''}
      ${m.link ? ` <a href="${esc(m.link)}" target="_blank" rel="noopener">🔗 Open link</a>` : ''}</div>`).join('') : 'No materials yet.');
  },
  async pricing() {
    $('#app').innerHTML = `<div class="card"><h2>Subscribe</h2><div class="price">GH₵${esc(S.price)}<small style="font-size:1rem">/month</small></div>
      <p>Unlimited videos + full library access.</p>
      <ol><li>Send <b>GH₵${esc(S.price)}</b> by Mobile Money to <b>${esc(S.momo_number)}</b>${S.momo_name ? ' (' + esc(S.momo_name) + ')' : ''}.</li>
      <li>Enter the number you paid from and the transaction ID from the MoMo SMS below.</li>
      <li>We confirm and activate your 30 days (usually within a few hours).</li></ol>
      <label>Your MoMo number</label><input id="pn" placeholder="05xxxxxxxx">
      <label>Transaction ID / reference</label><input id="ref">
      <button onclick="pay()">I have paid</button><div id="msg" class="err"></div></div>
      <div class="card"><h3>My payments</h3><div id="pl"></div></div>`;
    const p = await api('/payments/mine');
    $('#pl').innerHTML = p.length ? p.map(x => `<div class="hist"><span>${esc(x.reference)} <small>${new Date(x.created_at).toLocaleDateString()}</small></span><span class="badge ${x.status}" style="flex:0">${x.status}</span></div>`).join('') : 'None yet.';
  },
};
function authForm(signup) {
  $('#app').innerHTML = `<div class="card" style="max-width:420px;margin:30px auto"><h2>${signup ? 'Create account' : 'Welcome back'}</h2>
    ${signup ? '<label>Name</label><input id="n">' : ''}<label>Email</label><input id="e" type="email">
    <label>Password</label><input id="p" type="password"><button onclick="doAuth(${signup})">${signup ? 'Sign up' : 'Log in'}</button>
    <div id="msg" class="err"></div></div>`;
}
async function doAuth(signup) {
  try {
    const r = await api(signup ? '/signup' : '/login', { method: 'POST', body: { name: $('#n')?.value, email: $('#e').value, password: $('#p').value } });
    token = r.token; localStorage.setItem('t', token); me = r.user; renderNav(); go('dash');
  } catch (e) { $('#msg').textContent = e.message; }
}
async function pay() {
  try {
    await api('/payments', { method: 'POST', body: { payer_number: $('#pn').value, reference: $('#ref').value } });
    alert('Thank you! We will confirm your payment shortly.'); go('pricing');
  } catch (e) { $('#msg').textContent = e.message; }
}
async function generate() {
  const b = $('#gen'); b.disabled = true; b.textContent = 'Working… this can take a minute'; $('#msg').textContent = '';
  try {
    const r = await api('/generate', { method: 'POST', body: { url: $('#yt').value } });
    me = r.user; renderNav(); show(r);
  } catch (e) {
    $('#msg').textContent = e.message; if (/subscribe/i.test(e.message)) setTimeout(() => go('pricing'), 1500);
  }
  b.disabled = false; b.textContent = 'Generate notes, quiz & flashcards';
}
async function openGen(id) { $('#app').innerHTML = '<div id="result"></div>'; show(await api('/generations/' + id)); }
async function delGen(id) { if (confirm('Delete this?')) { await api('/generations/' + id, { method: 'DELETE' }); go('history'); } }

let CUR, FC = { i: 0, cards: [] };
function show(r) {
  CUR = r.data;
  $('#result').innerHTML = `<div class="card"><h2>${esc(r.title)}</h2><p>${esc(CUR.summary)}</p>
    <div class="tabs">${['notes', 'quiz', 'cards', 'terms'].map((t, i) => `<button class="${i ? '' : 'on'}" onclick="tab('${t}',this)">${{ notes: '📝 Notes', quiz: '❓ Questions', cards: '🃏 Flashcards', terms: '🔑 Key terms' }[t]}</button>`).join('')}</div>
    <div id="pane"></div></div>`;
  tab('notes'); $('#result').scrollIntoView();
}
function tab(t, btn) {
  if (btn) { document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('on')); btn.classList.add('on'); }
  const p = $('#pane');
  if (t === 'notes') p.innerHTML = `<div class="notes">${md(CUR.notes)}</div>`;
  if (t === 'terms') p.innerHTML = (CUR.key_terms || []).map(k => `<div class="q"><b>${esc(k.term)}</b><br>${esc(k.definition)}</div>`).join('');
  if (t === 'quiz') {
    let n = 0;
    p.innerHTML = `<h3>Multiple choice</h3>` + (CUR.mcq || []).map((q, i) => `<div class="q"><b>${++n}. ${esc(q.question)}</b>
      ${q.options.map((o, j) => `<button class="opt" onclick="pick(this,${i},${j})">${'ABCD'[j]}. ${esc(o)}</button>`).join('')}<div class="ex" id="ex${i}"></div></div>`).join('') +
      `<h3>Short answer</h3>` + (CUR.short_answer || []).map(q => `<div class="q"><b>${esc(q.question)}</b><details><summary>Show answer</summary>${esc(q.answer)}</details></div>`).join('') +
      `<h3>Essay / application</h3>` + (CUR.essay || []).map(q => `<div class="q"><b>${esc(q.question)}</b><details><summary>Model answer</summary>${esc(q.answer)}</details></div>`).join('');
  }
  if (t === 'cards') { FC = { i: 0, cards: [...(CUR.flashcards || [])] }; drawCard(); }
}
function pick(btn, i, j) {
  const q = CUR.mcq[i], opts = btn.parentElement.querySelectorAll('.opt');
  opts.forEach((o, k) => { o.disabled = true; if (k === q.answer) o.classList.add('right'); });
  if (j !== q.answer) btn.classList.add('wrong');
  $('#ex' + i).innerHTML = `<small>💡 ${esc(q.explanation)}</small>`;
}
function drawCard() {
  const c = FC.cards[FC.i]; if (!c) return $('#pane').innerHTML = 'No flashcards.';
  $('#pane').innerHTML = `<p style="text-align:center;color:var(--muted)">Card ${FC.i + 1} / ${FC.cards.length} — tap to flip</p>
    <div class="fc" onclick="this.classList.toggle('flip')"><div class="fc-in"><div class="fc-f">${esc(c.front)}</div><div class="fc-b">${esc(c.back)}</div></div></div>
    <div class="row"><button class="ghost" onclick="FC.i=(FC.i-1+FC.cards.length)%FC.cards.length;drawCard()">◀ Prev</button>
    <button class="ghost" onclick="FC.cards.sort(()=>Math.random()-.5);FC.i=0;drawCard()">🔀 Shuffle</button>
    <button onclick="FC.i=(FC.i+1)%FC.cards.length;drawCard()">Next ▶</button></div>`;
}
init();
