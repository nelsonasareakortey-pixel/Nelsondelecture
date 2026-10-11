const $ = s => document.querySelector(s);
const token = localStorage.getItem('t');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
if (!token) location.href = '/';
async function api(path, opts = {}) {
  const h = { Authorization: 'Bearer ' + token };
  if (opts.body && !(opts.body instanceof FormData)) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  const r = await fetch('/api' + path, { ...opts, headers: h });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 || r.status === 403) location.href = '/'; throw new Error(j.error || 'Error'); }
  return j;
}
const date = t => t ? new Date(t).toLocaleString() : '—';
async function stats() {
  const s = await api('/admin/stats');
  $('#stats').innerHTML = [['Users', s.users], ['Active subs', s.active], ['Pending payments', s.pending], ['Notes made', s.generations]]
    .map(([a, b]) => `<div class="card" style="text-align:center"><div class="price">${b}</div><small>${a}</small></div>`).join('');
}
const views = {
  async payments() {
    const p = await api('/admin/payments');
    $('#pane').innerHTML = `<div class="card scroll"><table><tr><th>User</th><th>MoMo no.</th><th>Ref</th><th>Date</th><th>Status</th><th></th></tr>` +
      p.map(x => `<tr><td>${esc(x.name)}<br><small>${esc(x.email)}</small></td><td>${esc(x.payer_number)}</td><td>${esc(x.reference)}</td><td>${date(x.created_at)}</td>
      <td><span class="badge ${x.status}">${x.status}</span></td><td>${x.status === 'pending' ?
        `<button class="ok" onclick="act(${x.id},'approve')">Approve</button> <button class="bad" onclick="act(${x.id},'reject')">Reject</button>` : ''}</td></tr>`).join('') + '</table></div>';
  },
  async users() {
    const u = await api('/admin/users');
    $('#pane').innerHTML = `<div class="card scroll"><table><tr><th>User</th><th>Subscription</th><th>Free used</th><th>Action</th></tr>` +
      u.map(x => `<tr><td>${esc(x.name)}${x.is_admin ? ' ⭐' : ''}<br><small>${esc(x.email)}</small></td>
      <td>${x.sub_until > Date.now() ? '<span class="badge on">until ' + new Date(x.sub_until).toLocaleDateString() + '</span>' : 'None'}</td><td>${x.free_used}</td>
      <td><button class="ghost" onclick="grant(${x.id},30)">+30d</button> <button class="ghost" onclick="grant(${x.id},0)">Cancel</button></td></tr>`).join('') + '</table></div>';
  },
  async materials() {
    const m = await api('/materials');
    $('#pane').innerHTML = `<div class="card"><h3>Add textbook / study material</h3>
      <label>Title</label><input id="mt"><label>Category</label>
      <select id="mc"><option>Textbook</option><option>Past questions</option><option>Study guide</option><option>Notes</option><option>Other</option></select>
      <label>Description</label><textarea id="md" rows="2"></textarea>
      <label>Upload file (PDF, DOCX, etc.)</label><input type="file" id="mf">
      <label>…or external link (optional)</label><input id="ml" placeholder="https://">
      <button onclick="addMat()">Add to library</button><div id="msg" class="err"></div></div>
      <div class="card"><h3>Library (${m.length})</h3>` + m.map(x => `<div class="hist"><span><b>${esc(x.title)}</b> <span class="badge">${esc(x.category)}</span><br><small>${esc(x.description)}</small></span>
      <button class="ghost" onclick='editMat(${JSON.stringify(x).replace(/'/g, "&#39;")})'>Edit</button> <button class="bad" onclick="delMat(${x.id})">Delete</button></div>`).join('') + '</div>';
  },
  async settings() {
    const s = await api('/settings');
    const f = (k, l, t = 'text') => `<label>${l}</label><input id="s_${k}" type="${t}" value="${esc(s[k])}">`;
    $('#pane').innerHTML = `<div class="card"><h3>Edit site</h3>` + f('site_name', 'Site name') + f('tagline', 'Tagline') +
      f('price', 'Monthly price (GH₵)', 'number') + f('momo_number', 'MoMo number for payments') + f('momo_name', 'MoMo account name (shown to customers)') +
      f('free_trials', 'Free videos per new user', 'number') +
      `<label>Announcement banner (leave empty to hide)</label><textarea id="s_announcement" rows="2">${esc(s.announcement)}</textarea>
      <button onclick="saveSettings()">Save</button> <span id="msg"></span></div>`;
  },
};
function T(v, btn) {
  if (btn) { document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('on')); btn.classList.add('on'); }
  views[v]();
}
async function act(id, a) { await api(`/admin/payments/${id}/${a}`, { method: 'POST' }); stats(); views.payments(); }
async function grant(id, days) { if (confirm(days ? 'Add 30 days?' : 'Cancel subscription?')) { await api(`/admin/users/${id}/grant`, { method: 'POST', body: { days } }); stats(); views.users(); } }
async function addMat() {
  const fd = new FormData();
  fd.append('title', $('#mt').value); fd.append('category', $('#mc').value); fd.append('description', $('#md').value); fd.append('link', $('#ml').value);
  if ($('#mf').files[0]) fd.append('file', $('#mf').files[0]);
  try { await api('/admin/materials', { method: 'POST', body: fd }); views.materials(); } catch (e) { $('#msg').textContent = e.message; }
}
async function editMat(m) {
  const title = prompt('Title', m.title); if (title === null) return;
  const category = prompt('Category', m.category); if (category === null) return;
  const description = prompt('Description', m.description); if (description === null) return;
  const link = prompt('Link (optional)', m.link || '');
  await api('/admin/materials/' + m.id, { method: 'PUT', body: { title, category, description, link } }); views.materials();
}
async function delMat(id) { if (confirm('Delete this material?')) { await api('/admin/materials/' + id, { method: 'DELETE' }); views.materials(); } }
async function saveSettings() {
  const body = {};
  document.querySelectorAll('[id^=s_]').forEach(e => body[e.id.slice(2)] = e.value);
  await api('/admin/settings', { method: 'PUT', body }); $('#msg').textContent = '✅ Saved';
}
stats(); views.payments();
