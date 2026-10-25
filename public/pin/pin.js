'use strict';
// Page /pin : connecter une app Jellyfin avec Quick Connect (code a 6 chiffres affiche par l'app).

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefill = (new URLSearchParams(location.search).get('code') || '').replace(/\D/g, '').slice(0, 6);

async function api(method, path, body) {
  const r = await fetch('/stremfin/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Stremfin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data?.error || `Erreur ${r.status}`);
  return data;
}

function setBusy(btn, on) {
  btn.disabled = on;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.innerHTML = on ? '<span class="spinner"></span>' + esc(btn.dataset.label) : esc(btn.dataset.label);
}

async function start() {
  let s;
  try {
    s = await api('GET', '/auth/status');
  } catch (e) {
    $('#view').innerHTML = `<p class="lead">${esc(e.message)}</p>`;
    return;
  }
  if (!s.authenticated) return loginView();
  codeView(s);
}

function loginView() {
  $('#view').innerHTML = `<form class="stack" id="f" novalidate>
    <h1>Connecter un appareil</h1>
    <p class="lead">Identifie-toi avec ton compte Stremfin, puis saisis le code affiché par l'app.</p>
    <div class="field"><label for="u">Nom d'utilisateur</label><input id="u" type="text" autocomplete="username" required></div>
    <div class="field"><label for="p">Mot de passe</label><input id="p" type="password" autocomplete="current-password" required></div>
    <div class="error" id="err"></div>
    <button class="btn primary" type="submit">Continuer</button>
  </form>`;
  $('#u').focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#f button');
    setBusy(btn, true);
    $('#err').textContent = '';
    try {
      await api('POST', '/auth/login', { username: $('#u').value.trim(), password: $('#p').value });
      start();
    } catch (ex) {
      $('#err').textContent = ex.message;
      setBusy(btn, false);
    }
  };
}

async function codeView(s) {
  let profiles = [];
  if (s.role === 'admin') {
    try { profiles = await api('GET', '/profiles'); } catch {}
  }
  $('#view').innerHTML = `<form class="stack" id="f" novalidate>
    <h1>Connecter un appareil</h1>
    <p class="lead">Dans l'app Jellyfin, choisis <b>Quick Connect</b> et saisis ici le code à 6 chiffres affiché.</p>
    <div class="who"><span class="small muted">Connecté : <b style="color:var(--text)">${esc(s.username)}</b></span><button type="button" class="btn ghost sm" id="out">Changer</button></div>
    ${s.role === 'admin' ? `<div class="field"><label for="prof">Pour le profil</label><select id="prof">${profiles.filter((p) => !p.disabled).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label for="code">Code Quick Connect</label><input id="code" class="pin-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" value="${esc(prefill)}"></div>
    <div class="error" id="err"></div>
    <button class="btn primary" type="submit">Autoriser l'appareil</button>
  </form>`;
  $('#code').focus();
  $('#code').oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6));
  $('#out').onclick = async () => {
    await api('POST', '/auth/logout').catch(() => {});
    loginView();
  };
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#code').value;
    if (!/^\d{6}$/.test(code)) return ($('#err').textContent = 'Le code fait 6 chiffres');
    const btn = $('#f button[type=submit]');
    setBusy(btn, true);
    $('#err').textContent = '';
    try {
      await api('POST', '/quickconnect', { code, profileId: $('#prof')?.value });
      $('#view').innerHTML = `<div class="done stack"><div class="check"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div>
        <h1>Appareil autorisé</h1><p class="lead">L'app se connecte d'elle-même dans quelques secondes.</p>
        <button class="btn" id="again">Autoriser un autre appareil</button></div>`;
      $('#again').onclick = () => codeView(s);
    } catch (ex) {
      $('#err').textContent = ex.message;
      setBusy(btn, false);
    }
  };
}

start();
