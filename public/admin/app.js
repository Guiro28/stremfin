'use strict';
// Interface d'administration de Stremfin (application d'une page, sans dependance).
// Textes : t('texte francais') (voir prefs.js) ; le francais sert de cle de traduction.

// ---- Utilitaires ------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString(UI.locale);

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17.5 14.5c2 .4 3.5 2 4 4.5"/>',
  devices: '<rect x="2" y="4" width="15" height="11" rx="1.5"/><path d="M6 19h7"/><rect x="18" y="8" width="4" height="12" rx="1"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  tv: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5.2 5.2L21 13l-8 8-3-3 8-8-1.3-1.3a4 4 0 0 0-5.2-5.2l2.8 2.8-2 2-2.8-2.8"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  puzzle: '<path d="M9 3h4v3a2 2 0 1 0 4 0V3h4v6h-3a2 2 0 1 0 0 4h3v8h-6v-3a2 2 0 1 0-4 0v3H3v-8h3a2 2 0 1 0 0-4H3V3z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>'
};

/** Taille lisible : "12,3 Mo". */
function fmtSize(bytes) {
  if (bytes >= 1e9) return t('{n} Go', { n: (bytes / 1e9).toLocaleString(UI.locale, { maximumFractionDigits: 1 }) });
  if (bytes >= 1e6) return t('{n} Mo', { n: (bytes / 1e6).toLocaleString(UI.locale, { maximumFractionDigits: 1 }) });
  return t('{n} Ko', { n: Math.max(1, Math.round(bytes / 1e3)) });
}

/** Date et heure dans la langue de l'interface. */
const fmtDate = (ts) => new Date(ts).toLocaleString(UI.locale, { dateStyle: 'medium', timeStyle: 'short' });

function icon(name, extra = '') {
  return `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const LOGO = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';

function ago(ts) {
  if (!ts) return t('jamais');
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t("à l'instant");
  if (s < 3600) return t('il y a {n} min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('il y a {n} h', { n: Math.floor(s / 3600) });
  if (s < 30 * 86400) return t('il y a {n} j', { n: Math.floor(s / 86400) });
  return new Date(ts).toLocaleDateString(UI.locale);
}

function duration(ms) {
  const h = Math.floor(ms / 3600e3);
  if (h >= 24) return t('{d} j {h} h', { d: Math.floor(h / 24), h: h % 24 });
  return t('{h} h {m} min', { h, m: Math.floor((ms % 3600e3) / 60e3) });
}

function hue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function avatar(p, size = 'm') {
  if (p.avatarUrl) return `<div class="avatar ${size}"><img src="${esc(p.avatarUrl)}" alt=""></div>`;
  const initials = String(p.name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="avatar ${size}" style="background:hsl(${hue(p.name)} 55% 42%)">${esc(initials)}</div>`;
}

function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), error ? 5000 : 2600);
}

async function api(method, path, body) {
  const init = { method, headers: { 'X-Stremfin': '1' }, credentials: 'same-origin' };
  if (body instanceof Blob) {
    init.body = body;
    init.headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch('/stremfin/api' + path, init);
  let data = null;
  try { data = await r.json(); } catch {}
  // Messages du serveur (en francais) traduits ici : ils servent de cle.
  if (r.status === 401 && !path.startsWith('/auth/')) {
    state.authed = false;
    render();
    throw new Error(t(data?.error || 'Session expirée'));
  }
  if (!r.ok) throw new Error(data?.error ? t(data.error) : t('Erreur {n}', { n: r.status }));
  return data;
}

/** Execute une action asynchrone en desactivant le bouton et en affichant les erreurs. */
async function busy(btn, fn, okMsg) {
  const label = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + label;
  }
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
}

// ---- Fenetres modales -----------------------------------------------------------------------

function modal({ title, lead = '', body = '', okLabel = t('Valider'), okClass = 'primary', cancelLabel = t('Annuler'), onOk, wide = false }) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'backdrop';
    bd.innerHTML = `<form class="modal" style="${wide ? 'width:min(720px,100%)' : ''}" novalidate>
      <h2>${esc(title)}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}
      <div class="modal-body">${body}</div>
      <div class="foot">${cancelLabel ? `<button type="button" class="btn ghost" data-close>${esc(cancelLabel)}</button>` : ''}
        ${okLabel ? `<button type="submit" class="btn ${okClass}">${esc(okLabel)}</button>` : ''}</div>
    </form>`;
    const close = (v) => {
      bd.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && close(null);
    document.addEventListener('keydown', onKey);
    bd.addEventListener('mousedown', (e) => e.target === bd && close(null));
    $('[data-close]', bd)?.addEventListener('click', () => close(null));
    const form = $('form', bd);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      if (!onOk) return close(true);
      const r = await busy(btn, () => onOk(form));
      if (r !== undefined && r !== false) close(r);
    });
    document.body.appendChild(bd);
    ($('input:not([type=hidden]), select', form) || $('button[type=submit]', form))?.focus();
  });
}

function confirmDialog(title, lead, okLabel = t('Confirmer'), danger = false) {
  return modal({ title, lead, okLabel, okClass: danger ? 'danger solid' : 'primary' });
}

// ---- Listes reordonnables (souris, tactile et clavier) ----------------------------------------

function sortable(list, onChange) {
  const keys = () => $$('.item', list).map((i) => i.dataset.key);
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle || !list.contains(handle) || handle.disabled) return;
    const item = handle.closest('.item');
    e.preventDefault();
    const before = keys().join('|');
    item.classList.add('dragging');
    // Suivi sur toute la fenetre : le pointeur peut quitter la poignee pendant le glisser.
    const move = (ev) => {
      const others = $$('.item:not(.dragging)', list);
      const next = others.find((o) => {
        const r = o.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      if (next) list.insertBefore(item, next);
      else list.appendChild(item);
    };
    const up = () => {
      item.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (keys().join('|') !== before) onChange(keys());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  list.addEventListener('keydown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle || handle.disabled || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const item = handle.closest('.item');
    if (e.key === 'ArrowUp' && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
    else if (e.key === 'ArrowDown' && item.nextElementSibling) list.insertBefore(item.nextElementSibling, item);
    else return;
    handle.focus();
    onChange(keys());
  });
}

const handleBtn = (disabled = false) =>
  `<button type="button" class="handle" title="${esc(t('Glisser pour réordonner (ou flèches haut/bas)'))}" aria-label="${esc(t('Déplacer'))}" ${disabled ? 'disabled style="visibility:hidden"' : ''}>${icon('grip')}</button>`;

const toggle = (attrs, checked, disabled = false) =>
  `<label class="switch"><input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span></span></label>`;

/** Bouton clair / sombre (theme garde dans le navigateur). */
const themeBtn = (id) => {
  const light = UI.theme() === 'light';
  return `<button type="button" class="btn ghost icon-only" id="${id}" title="${esc(light ? t('Passer en mode sombre') : t('Passer en mode clair'))}" aria-label="${esc(light ? t('Passer en mode sombre') : t('Passer en mode clair'))}">${icon(light ? 'moon' : 'sun')}</button>`;
};
function bindTheme(id) {
  const b = $('#' + id);
  if (!b) return;
  b.onclick = () => {
    UI.toggleTheme();
    b.outerHTML = themeBtn(id);
    bindTheme(id);
  };
}

// ---- Etat et navigation ------------------------------------------------------------------------

const state = { authed: false, setup: false, role: null, username: '', profileId: null, info: null, settings: null, profiles: [], profile: null };

// Libelles en francais (cles de traduction), traduits a l'affichage.
const NAV_ADMIN = [
  { group: null, items: [{ id: 'dashboard', label: 'Tableau de bord', icon: 'dashboard' }] },
  { group: 'Utilisateurs', items: [{ id: 'profiles', label: 'Profils', icon: 'users' }, { id: 'devices', label: 'Appareils', icon: 'devices' }] },
  {
    group: 'Réglages',
    items: [
      { id: 'settings/server', label: 'Serveur', icon: 'server' },
      { id: 'settings/playback', label: 'Lecture et réseau', icon: 'play' },
      { id: 'settings/metadata', label: 'Métadonnées', icon: 'film' },
      { id: 'settings/platforms', label: 'Plateformes', icon: 'tv' },
      { id: 'settings/web', label: 'Client web', icon: 'globe' }
    ]
  },
  { group: 'Système', items: [{ id: 'backups', label: 'Sauvegardes', icon: 'archive' }, { id: 'maintenance', label: 'Maintenance', icon: 'wrench' }, { id: 'security', label: 'Sécurité', icon: 'shield' }] }
];

/** Un utilisateur ne voit que les onglets de son propre profil. */
function navFor() {
  if (state.role === 'admin') return NAV_ADMIN;
  return [{ group: 'Mon compte', items: PROFILE_TABS.map((x) => ({ id: `me/${x.id}`, label: x.label, icon: x.icon })) }];
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (state.role !== 'admin') return { page: 'me', parts: ['me', parts[0] === 'me' ? parts[1] || 'login' : 'login'] };
  if (!parts.length) return { page: 'dashboard', parts: [] };
  if (parts[0] === 'settings') return { page: `settings/${parts[1] || 'server'}`, parts };
  return { page: parts[0], parts };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => render());

async function boot() {
  await UI.ready;
  try {
    const s = await api('GET', '/auth/status');
    state.setup = s.setup;
    state.authed = s.authenticated;
    state.username = s.username || '';
    state.role = s.role;
    state.profileId = s.profileId;
    state.web = s.web;
  } catch (e) {
    $('#app').innerHTML = `<div class="auth"><div class="card"><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  render();
}

async function render() {
  if (!state.authed) return renderAuth();
  if (!$('.shell')) renderShell();
  const r = route();
  const here = r.page === 'me' ? `me/${r.parts[1]}` : r.page;
  $$('.nav-item[data-nav]').forEach((a) => a.classList.toggle('active', here === a.dataset.nav || here.startsWith(a.dataset.nav + '/')));
  $('.shell').classList.remove('menu-open');
  const main = $('#main');
  try {
    if (!state.info) state.info = await api('GET', '/server-info');
    if (state.role === 'admin' && !state.settings) state.settings = await api('GET', '/settings');
    const page = PAGES[r.page] || (state.role === 'admin' ? PAGES.dashboard : PAGES.me);
    await page(main, r.parts);
  } catch (e) {
    if (state.authed) main.innerHTML = `<div class="card empty">${icon('alert')}<p>${esc(e.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
}

function renderShell() {
  document.title = state.role === 'admin' ? t('Stremfin · Administration') : t('Stremfin · Mon espace');
  $('#app').innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-logo">${LOGO}</div><div><div class="brand-name">Stremfin</div><div class="brand-sub">${state.role === 'admin' ? t('Administration') : t('Mon espace')}</div></div></div>
      ${navFor().map((g) => `${g.group ? `<div class="nav-group">${esc(t(g.group))}</div>` : ''}${g.items
        .map((i) => `<a class="nav-item" data-nav="${i.id}" href="#/${i.id}">${icon(i.icon)}<span>${esc(t(i.label))}</span></a>`)
        .join('')}`).join('')}
      ${state.web ? `<a class="nav-item" href="/web/" target="_blank" rel="noopener">${icon('play')}<span>${t('Regarder')}</span></a>` : ''}
      <div class="sidebar-tools">${UI.langSelect('langSel')}${themeBtn('themeBtn')}</div>
      <div class="sidebar-foot">
        <div class="avatar s" style="background:hsl(${hue(state.username)} 55% 42%)">${esc(state.username.slice(0, 1).toUpperCase())}</div>
        <div class="who"><b>${esc(state.username)}</b><span class="small muted">${state.role === 'admin' ? t('Administrateur') : t('Utilisateur')}</span></div>
        <button class="btn ghost icon-only" id="logout" title="${esc(t('Se déconnecter'))}" aria-label="${esc(t('Se déconnecter'))}">${icon('logout')}</button>
      </div>
    </aside>
    <div>
      <div class="topbar"><button class="btn ghost icon-only" id="menu" aria-label="${esc(t('Menu'))}">${icon('menu')}</button><b>Stremfin</b></div>
      <main class="main" id="main"></main>
    </div>
  </div>`;
  $('#logout').onclick = async () => {
    await api('POST', '/auth/logout').catch(() => {});
    Object.assign(state, { authed: false, role: null, profileId: null, info: null, settings: null });
    render();
  };
  $('#menu').onclick = () => $('.shell').classList.toggle('menu-open');
  UI.bindLang($('#langSel'));
  bindTheme('themeBtn');
}

// ---- Connexion / premier lancement -----------------------------------------------------------------

function renderAuth() {
  const setup = state.setup;
  document.title = 'Stremfin';
  $('#app').innerHTML = `<div class="auth"><form class="card stack" id="authForm" novalidate>
    <div class="brand"><div class="brand-logo">${LOGO}</div><div class="brand-name">Stremfin</div></div>
    <h1>${setup ? t('Bienvenue') : t('Connexion')}</h1>
    <p class="lead">${setup ? t('Crée le compte administrateur. Il protège cette interface.') : t('Administrateur ou utilisateur : connecte-toi avec ton compte Stremfin.')}</p>
    <div class="field"><label for="u">${t("Nom d'utilisateur")}</label><input id="u" type="text" autocomplete="username" required></div>
    <div class="field"><label for="p">${t('Mot de passe')}</label><input id="p" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
      ${setup ? `<span class="help">${t('8 caractères minimum.')}</span>` : ''}</div>
    ${setup ? `<div class="field"><label for="p2">${t('Confirmer le mot de passe')}</label><input id="p2" type="password" autocomplete="new-password" required></div>` : ''}
    <div class="error" id="authError"></div>
    <button class="btn primary" type="submit">${setup ? t('Créer le compte') : t('Se connecter')}</button>
    ${setup ? '' : `<p class="small muted" style="text-align:center">${t('Connecter une app avec Quick Connect : <a href="/pin">page /pin</a>')}</p>
      ${state.web ? `<a class="btn ghost" href="/web/">${icon('play')}${t('Regarder dans le navigateur')}</a>` : ''}`}
    <div class="auth-tools">${UI.langSelect('authLang')}${themeBtn('authTheme')}</div>
  </form></div>`;
  $('#u').focus();
  UI.bindLang($('#authLang'));
  bindTheme('authTheme');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#authError');
    err.textContent = '';
    const username = $('#u').value.trim();
    const password = $('#p').value;
    if (setup && password !== $('#p2').value) return (err.textContent = t('Les mots de passe ne correspondent pas'));
    const r = await busy($('#authForm button[type=submit]'), async () => {
      try {
        return await api('POST', setup ? '/auth/setup' : '/auth/login', { username, password });
      } catch (ex) {
        err.textContent = ex.message;
        return false;
      }
    });
    if (r) {
      Object.assign(state, { authed: true, setup: false, username, role: r.role || 'admin', profileId: r.profileId || null, info: null, settings: null });
      if (location.hash && state.role !== 'admin') location.hash = '';
      render();
    }
  };
}

// ---- Pages -----------------------------------------------------------------------------------------

const PAGES = {};

function head(title, sub = '', actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
}

function serverAddress() {
  return (state.info?.publicUrl || location.origin).replace(/\/+$/, '');
}

// Tableau de bord
PAGES.dashboard = async (main) => {
  const o = await api('GET', '/overview');
  main.innerHTML = `${head(t('Tableau de bord'), t('{name} · version {version} · en ligne depuis {uptime}', { name: esc(o.serverName), version: esc(o.version), uptime: duration(o.uptime) }))}
    <div class="grid grid-4">
      <div class="stat"><div class="label">${icon('users')} ${t('Profils')}</div><div class="value">${o.profiles}</div></div>
      <div class="stat"><div class="label">${icon('devices')} ${t('Appareils actifs')}</div><div class="value">${o.activeDevices}</div><div class="hint">${t('sur {n} connecté(s) · 24 h', { n: o.devices })}</div></div>
      <div class="stat"><div class="label">${icon('layers')} ${t('Titres indexés')}</div><div class="value">${num(o.indexedItems)}</div></div>
      <div class="stat"><div class="label">${icon('refresh')} ${t('Entrées en cache')}</div><div class="value">${num(o.cacheEntries)}</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div><h2>${t('Activité récente')}</h2><p>${t('Derniers titres lancés, tous profils confondus.')}</p></div></div>
        ${o.recent.length ? o.recent.map((r) => `<div class="recent">
            ${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
            <div class="grow"><b>${esc(r.title)}</b><div class="small muted">${esc(r.profile)} · ${ago(r.at)}${r.played ? ` · ${t('vu')}` : ''}</div></div>
          </div>`).join('') : `<div class="empty">${icon('clock')}<p>${t("Rien de lancé pour l'instant.")}</p></div>`}
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h2>${t('État')}</h2></div></div>
          <div class="setting"><div class="text"><b>TMDB</b><span>${t('Fiches traduites, Mes médias, plateformes, sagas.')}</span></div>
            <div class="control">${o.tmdb ? `<span class="badge ok">${t('Actif')}</span>` : `<a class="btn sm" href="#/settings/metadata">${t('Configurer')}</a>`}</div></div>
          <div class="setting"><div class="text"><b>${t("Passer l'intro")}</b><span>${t('Timestamps de TheIntroDB.')}</span></div>
            <div class="control">${o.introSkip ? `<span class="badge ok">${t('Actif')}</span>` : `<span class="badge">${t('Désactivé')}</span>`}</div></div>
          <div class="setting"><div class="text"><b>${t('Addons')}</b><span>${o.brokenAddons.length ? t('{n} addon(s) injoignable(s)', { n: o.brokenAddons.length }) : t('Tous les manifests répondent.')}</span></div>
            <div class="control">${o.brokenAddons.length ? `<a class="btn sm" href="#/maintenance">${t('Voir')}</a>` : `<span class="badge ok">${t('OK')}</span>`}</div></div>
        </div>
        <div class="howto">
          <h3>${t('Connecter une app Jellyfin')}</h3>
          <ol>
            <li>${t("Dans l'app : <b>Ajouter un serveur</b>, adresse {address}", { address: `<code>${esc(serverAddress())}</code>` })}</li>
            <li>${t("Nom d'utilisateur et mot de passe du profil")}</li>
            <li>${t('Ou <b>Quick Connect</b> : code à saisir sur {link}', { link: `<a href="/pin" target="_blank">${esc(serverAddress())}/pin</a>` })}</li>
          </ol>
        </div>
      </div>
    </div>`;
};

// Liste des profils
PAGES.profiles = async (main, parts) => {
  if (parts[1]) return profilePage(main, parts[1], parts[2] || 'login', false);
  state.profiles = await api('GET', '/profiles');
  main.innerHTML = `${head(t('Profils'), t('Chaque profil a ses identifiants, ses addons, ses bibliothèques, son accueil et sa progression.'), `<button class="btn primary" id="newProfile">${icon('plus')}${t('Nouveau profil')}</button>`)}
    <div class="profile-grid">
      ${state.profiles.map((p) => `<a class="card profile-card ${p.disabled ? 'disabled' : ''}" href="#/profiles/${p.id}">
        <div class="top">${avatar(p)}<div class="grow"><div class="name">${esc(p.name)}</div>
          <div class="row" style="gap:5px;margin-top:4px">
            ${p.disabled ? `<span class="badge bad">${t('Désactivé')}</span>` : ''}
            ${p.hasPassword ? '' : `<span class="badge warn">${t('Sans mot de passe')}</span>`}
            ${p.showOnLogin ? `<span class="badge accent">${t('Visible')}</span>` : ''}
          </div></div></div>
        <div class="stats">
          <div><b>${p.addonsCount}</b><span>${t('addons')}</span></div>
          <div><b>${p.librariesCount}</b><span>${t('biblio.')}</span></div>
          <div><b>${p.devicesCount}</b><span>${t('appareils')}</span></div>
          <div><b>${p.watchedCount}</b><span>${t('vus')}</span></div>
        </div>
        <div class="small muted">${t('Dernière activité : {when}', { when: ago(p.lastSeen) })}</div>
      </a>`).join('')}
      <button class="card profile-card new" id="newProfile2">${icon('plus')}<span>${t('Ajouter un profil')}</span></button>
    </div>`;
  $('#newProfile').onclick = newProfileDialog;
  $('#newProfile2').onclick = newProfileDialog;
};

async function newProfileDialog() {
  const others = state.profiles.length ? state.profiles : await api('GET', '/profiles');
  const p = await modal({
    title: t('Nouveau profil'),
    lead: t("L'utilisateur se connectera aux apps et à son espace avec ce nom et ce mot de passe."),
    okLabel: t('Créer'),
    body: `<div class="stack">
      <div class="field"><label>${t("Nom d'utilisateur")}</label><input name="name" type="text" maxlength="40" required></div>
      <div class="field"><label>${t('Mot de passe')}</label><input name="password" type="password" autocomplete="new-password" required><span class="help">${t('8 caractères minimum.')}</span></div>
      <div class="field"><label>${t('Partir de')}</label><select name="from"><option value="">${t('Profil par défaut (Mes médias TMDB, plateformes, sagas)')}</option>
        ${others.map((o) => `<option value="${o.id}">${t('Copie de {name} (addons, bibliothèques, accueil, préférences)', { name: esc(o.name) })}</option>`).join('')}</select></div>
    </div>`,
    onOk: async (f) => {
      const body = { name: f.name.value.trim(), password: f.password.value };
      return f.from.value ? api('POST', `/profiles/${f.from.value}/duplicate`, body) : api('POST', '/profiles', body);
    }
  });
  if (p) {
    toast(t('Profil « {name} » créé', { name: p.name }));
    go(`#/profiles/${p.id}`);
  }
}

// Fiche d'un profil (admin) ou "Mon compte" (utilisateur)
const PROFILE_TABS = [
  { id: 'login', label: 'Connexion', icon: 'key' },
  { id: 'prefs', label: 'Préférences', icon: 'sliders' },
  { id: 'home', label: 'Accueil', icon: 'dashboard' },
  { id: 'addons', label: 'Addons', icon: 'puzzle' },
  { id: 'libraries', label: 'Bibliothèques', icon: 'layers' },
  { id: 'devices', label: 'Appareils', icon: 'devices' }
];

PAGES.me = (main, parts) => profilePage(main, state.profileId, parts[1] || 'login', true);

async function profilePage(main, id, tab, self) {
  const p = (state.profile = await api('GET', `/profiles/${id}`));
  p.self = self;
  const base = self ? '#/me/' : `#/profiles/${p.id}/`;
  const counts = { addons: p.addons.length, libraries: p.catalogs.filter((c) => c.enabled && c.browsable).length, devices: p.devices.length };
  main.innerHTML = `${self ? '' : `<div class="row" style="margin-bottom:14px"><a class="btn ghost sm" href="#/profiles">${t('← Profils')}</a></div>`}
    <div class="profile-hero">
      <button class="avatar-edit" id="avatarBtn" title="${esc(t("Changer l'avatar"))}" aria-label="${esc(t("Changer l'avatar"))}">${avatar(p, 'l')}<span class="overlay">${icon('camera')}</span></button>
      <input type="file" id="avatarFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      <div class="info"><h1>${esc(p.name)}
        ${p.disabled ? `<span class="badge bad">${t('Désactivé')}</span>` : `<span class="badge ok">${t('Actif')}</span>`}
        ${p.hasPassword ? '' : `<span class="badge warn">${t('Sans mot de passe')}</span>`}</h1>
        <p class="muted" style="margin-top:4px">${t('Créé {created} · dernière activité {last} · {n} titre(s) en cours ou vus', { created: ago(p.createdAt), last: ago(p.lastSeen), n: p.watchedCount })}</p></div>
      <div class="row">
        ${p.avatarUrl ? `<button class="btn sm" id="avatarDel">${icon('trash')}${t("Retirer l'avatar")}</button>` : ''}
        ${self ? '' : `<button class="btn sm" id="dupProfile">${icon('copy')}${t('Dupliquer')}</button><button class="btn sm danger" id="delProfile">${icon('trash')}${t('Supprimer')}</button>`}
      </div>
    </div>
    <nav class="tabs">${PROFILE_TABS.map((x) => `<a class="tab ${x.id === tab ? 'active' : ''}" href="${base}${x.id}">${icon(x.icon)}${esc(t(x.label))}${counts[x.id] !== undefined ? `<span class="count">${counts[x.id]}</span>` : ''}</a>`).join('')}</nav>
    <div id="tab"></div>`;

  $('#avatarBtn').onclick = () => $('#avatarFile').click();
  $('#avatarFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return toast(t('Image trop lourde (3 Mo max.)'), true);
    if (await busy(null, () => api('PUT', `/profiles/${p.id}/avatar`, file), t('Avatar mis à jour'))) render();
  };
  if ($('#avatarDel')) $('#avatarDel').onclick = async () => (await busy(null, () => api('DELETE', `/profiles/${p.id}/avatar`), t('Avatar retiré'))) && render();
  if (!self) {
    $('#dupProfile').onclick = async () => {
      const copy = await modal({
        title: t('Dupliquer « {name} »', { name: p.name }),
        lead: t("Le nouveau profil reprend les addons, les bibliothèques, l'accueil et les préférences, sans progression."),
        okLabel: t('Dupliquer'),
        body: `<div class="stack"><div class="field"><label>${t('Nom du nouveau profil')}</label><input name="name" type="text" maxlength="40" value="${esc(t('{name} (copie)', { name: p.name }))}" required></div>
          <div class="field"><label>${t('Mot de passe')}</label><input name="password" type="password" autocomplete="new-password" required><span class="help">${t('8 caractères minimum.')}</span></div></div>`,
        onOk: (f) => api('POST', `/profiles/${p.id}/duplicate`, { name: f.name.value, password: f.password.value })
      });
      if (copy) {
        toast(t('Profil dupliqué'));
        go(`#/profiles/${copy.id}`);
      }
    };
    $('#delProfile').onclick = async () => {
      const ok = await confirmDialog(t('Supprimer « {name} » ?', { name: p.name }), t('Ses appareils seront déconnectés et sa progression (reprise, vus, favoris) effacée. Action irréversible.'), t('Supprimer'), true);
      if (ok && (await busy(null, () => api('DELETE', `/profiles/${p.id}`), t('Profil supprimé')))) go('#/profiles');
    };
  }
  const tabs = { login: tabLogin, prefs: tabPrefs, home: tabHome, addons: tabAddons, libraries: tabLibraries, devices: tabDevices };
  (tabs[tab] || tabLogin)($('#tab'), p);
}

async function patchProfile(p, body, msg = t('Enregistré')) {
  const r = await busy(null, () => api('PATCH', `/profiles/${p.id}`, body), msg);
  if (r) {
    r.self = p.self;
    state.profile = r;
  }
  return r;
}

function passwordDialog(p) {
  return modal({
    title: p.hasPassword ? t('Changer le mot de passe') : t('Définir un mot de passe'),
    lead: t('Les apps connectées à ce profil devront se reconnecter.'),
    okLabel: t('Enregistrer'),
    body: `<div class="stack">
      ${p.self ? `<div class="field"><label>${t('Mot de passe actuel')}</label><input name="cur" type="password" autocomplete="current-password" required></div>` : ''}
      <div class="field"><label>${t('Nouveau mot de passe')}</label><input name="pw" type="password" autocomplete="new-password" required><span class="help">${t('8 caractères minimum.')}</span></div>
      <div class="field"><label>${t('Confirmer')}</label><input name="pw2" type="password" autocomplete="new-password" required></div></div>`,
    onOk: async (f) => {
      if (f.pw.value !== f.pw2.value) throw new Error(t('Les mots de passe ne correspondent pas'));
      return api('PATCH', `/profiles/${p.id}`, { password: f.pw.value, currentPassword: f.cur?.value });
    }
  });
}

function tabLogin(el, p) {
  el.innerHTML = `<div class="grid grid-2">
    <div class="stack">
      <div class="card">
        <div class="card-head"><div><h2>${t('Identifiants')}</h2><p>${p.self ? t('Pour les apps Jellyfin et pour cet espace.') : t("Pour les apps Jellyfin et pour l'espace utilisateur du profil.")}</p></div></div>
        ${p.self
          ? `<div class="field"><label>${t("Nom d'utilisateur")}</label><input type="text" value="${esc(p.name)}" disabled><span class="help">${t("Modifiable par l'administrateur.")}</span></div>`
          : `<form class="field" id="nameForm"><label>${t("Nom d'utilisateur")}</label>
              <div class="row"><input class="grow" name="name" type="text" maxlength="40" value="${esc(p.name)}" required style="width:auto"><button class="btn" type="submit">${t('Renommer')}</button></div></form>`}
        <div class="divider"></div>
        <div class="row between"><div><b>${t('Mot de passe')}</b><div class="small ${p.hasPassword ? 'muted' : ''}" style="${p.hasPassword ? '' : 'color:var(--warn)'}">${p.hasPassword ? t('Défini.') : t('Aucun : ce profil ne peut pas se connecter.')}</div></div>
          <button class="btn sm ${p.hasPassword ? '' : 'primary'}" id="pwSet">${p.hasPassword ? t('Changer') : t('Définir')}</button></div>
      </div>
      ${p.self ? '' : `<div class="card">
        <div class="card-head"><div><h2>${t('Accès')}</h2></div></div>
        <div class="setting"><div class="text"><b>${t('Visible à la connexion')}</b><span>${t("Le profil apparaît sur l'écran « Qui regarde ? » de tous les appareils (sinon, seulement sur ceux déjà connectés).")}</span></div>
          <div class="control">${toggle('id="showOnLogin"', p.showOnLogin)}</div></div>
        <div class="setting"><div class="text"><b>${t('Profil désactivé')}</b><span>${t("Plus aucune connexion possible ; les appareils et l'espace utilisateur sont déconnectés.")}</span></div>
          <div class="control">${toggle('id="disabled"', p.disabled)}</div></div>
      </div>`}
    </div>
    <div class="howto">
      <h3>${t('Se connecter depuis une app')}</h3>
      <ol><li>${t('Adresse du serveur : {address}', { address: `<code>${esc(serverAddress())}</code>` })}</li>
        <li>${t('Nom {name} + son mot de passe', { name: `<b>${esc(p.name)}</b>` })}</li>
        <li>${t("Ou <b>Quick Connect</b> : l'app affiche un code à 6 chiffres, à saisir sur {link} ou ici :", { link: `<a href="/pin" target="_blank">${esc(serverAddress())}/pin</a>` })}</li></ol>
      <form class="row" id="qcForm" style="margin-top:12px"><input class="grow" name="code" type="text" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000" style="width:auto;font-family:var(--mono);letter-spacing:.2em">
        <button class="btn primary" type="submit">${t('Approuver')}</button></form>
    </div>
  </div>`;

  if ($('#nameForm')) $('#nameForm').onsubmit = async (e) => {
    e.preventDefault();
    if (await patchProfile(p, { name: e.target.name.value }, t('Profil renommé'))) render();
  };
  $('#pwSet').onclick = async () => (await passwordDialog(p)) && (toast(t('Mot de passe enregistré')), render());
  if ($('#showOnLogin')) $('#showOnLogin').onchange = async (e) => {
    if (!(await patchProfile(p, { showOnLogin: e.target.checked }))) e.target.checked = !e.target.checked;
  };
  if ($('#disabled')) $('#disabled').onchange = async (e) => {
    if (e.target.checked && !(await confirmDialog(t('Désactiver « {name} » ?', { name: p.name }), t('Ses appareils seront déconnectés et il ne pourra plus se connecter.'), t('Désactiver'), true))) {
      e.target.checked = false;
      return;
    }
    if (await patchProfile(p, { disabled: e.target.checked }, e.target.checked ? t('Profil désactivé') : t('Profil réactivé'))) render();
  };
  $('#qcForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    if (!/^\d{6}$/.test(code)) return toast(t('Le code fait 6 chiffres'), true);
    if (await busy($('#qcForm button'), () => api('POST', '/quickconnect', { code, profileId: p.id }), t('Appareil approuvé'))) e.target.reset();
  };
}

// Langues audio (libelles traduits a l'affichage).
const LANGS = [
  ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien']
];

function tabPrefs(el, p) {
  const tmdbOn = !!state.info?.tmdb;
  el.innerHTML = `<div class="card">
    <div class="setting"><div class="text"><b>${t('Langues audio prioritaires')}</b><span>${t("Les sources dans ces langues passent en premier, avant la qualité (dans l'ordre de sélection).")}</span></div>
      <div class="control"><div class="chips" id="langs">${LANGS.map(([v, l]) => `<button type="button" class="chip ${p.preferredLanguages.includes(v) ? 'on' : ''}" data-lang="${v}">${t(l)}${p.preferredLanguages.includes(v) ? ` <span class="faint">${p.preferredLanguages.indexOf(v) + 1}</span>` : ''}</button>`).join('')}</div></div></div>
    <div class="setting"><div class="text"><b>${t('Qualité par défaut')}</b><span>${t('Lancée sans choix explicite ; à défaut, la plus proche disponible.')}</span></div>
      <div class="control"><div class="segmented" id="quality">${[['2160', '4K'], ['1080', '1080p'], ['720', '720p']].map(([v, l]) => `<button type="button" data-q="${v}" class="${p.defaultQuality === v ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
    <div class="setting"><div class="text"><b>${t('Versions proposées')}</b><span>${t("Sur la fiche d'un film ou d'un épisode : 3 qualités, ou les 5 meilleures releases de chaque qualité trouvées par les addons (jusqu'à 15).")}</span></div>
      <div class="control"><div class="segmented" id="versionMode">${[['quality', '3 qualités'], ['releases', '5 releases par qualité']].map(([v, l]) => `<button type="button" data-v="${v}" class="${p.versionMode === v ? 'on' : ''}">${t(l)}</button>`).join('')}</div></div></div>
    <div class="setting"><div class="text"><b>${t('Masquer les films déjà vus')}</b><span>${t('Ils disparaissent des bibliothèques une fois terminés.')}</span></div>
      <div class="control">${toggle('id="hideWatched"', p.hideWatched)}</div></div>
    <div class="setting"><div class="text"><b>${t('Seulement ce qui est sorti')}</b><span>${t('Masque films et séries pas encore disponibles en VOD, DVD ou à la TV.')}${tmdbOn ? '' : ` ${t('Nécessite une clé TMDB.')}`}</span></div>
      <div class="control">${toggle('id="onlyReleased"', p.onlyReleased, !tmdbOn)}</div></div>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="card-head"><div><h2>${t('CSS du client web')}</h2><p>${t("Personnalise l'apparence de Jellyfin web pour ce profil : navigateur, Jellyfin Media Player, app Android pour téléphone. Les apps natives (Android TV, Wholphin…) ne l'utilisent pas.")}</p></div></div>
    <textarea id="customCss" rows="12" spellcheck="false" placeholder="/* ${esc(t('Exemple'))} */&#10;.skinHeader { background: #101820; }" style="width:100%;font-family:var(--mono);font-size:13px;resize:vertical">${esc(p.customCss)}</textarea>
    <div class="row" style="margin-top:10px;justify-content:space-between"><span class="small faint">${t("S'applique au prochain chargement de la page dans Jellyfin web.")}</span><button class="btn primary" id="cssSave">${t('Enregistrer le CSS')}</button></div>
  </div>`;
  $('#cssSave').onclick = async (e) => {
    const r = await busy(e.currentTarget, () => api('PATCH', `/profiles/${p.id}`, { customCss: $('#customCss').value }), t('CSS enregistré'));
    if (r) {
      r.self = p.self;
      state.profile = r;
    }
  };
  $('#langs').onclick = async (e) => {
    const chip = e.target.closest('[data-lang]');
    if (!chip) return;
    const v = chip.dataset.lang;
    const langs = p.preferredLanguages.includes(v) ? p.preferredLanguages.filter((x) => x !== v) : [...p.preferredLanguages, v];
    if (await patchProfile(p, { preferredLanguages: langs })) tabPrefs(el, state.profile);
  };
  $('#quality').onclick = async (e) => {
    const b = e.target.closest('[data-q]');
    if (b && (await patchProfile(p, { defaultQuality: b.dataset.q }))) tabPrefs(el, state.profile);
  };
  $('#versionMode').onclick = async (e) => {
    const b = e.target.closest('[data-v]');
    if (b && (await patchProfile(p, { versionMode: b.dataset.v }))) tabPrefs(el, state.profile);
  };
  for (const k of ['hideWatched', 'onlyReleased']) {
    $('#' + k).onchange = async (e) => {
      if (!(await patchProfile(p, { [k]: e.target.checked }))) e.target.checked = !e.target.checked;
    };
  }
}

// Accueil des apps Jellyfin : sections (homesection0..9) et rangees "ajouts recents" par bibliotheque.
const SECTIONS = [
  ['smalllibrarytiles', 'Mes médias (grandes vignettes)'],
  ['librarybuttons', 'Mes médias (boutons)'],
  ['resume', 'Continuer à regarder'],
  ['nextup', 'À suivre (épisodes)'],
  ['latestmedia', 'Rangées des bibliothèques (« ajouts récents »)']
];
const RECOMMENDED_HOME = ['smalllibrarytiles', 'resume', 'latestmedia', 'nextup'];

function tabHome(el, p) {
  let sections = p.homeSections ? [...p.homeSections] : null;
  const original = JSON.stringify(sections);
  const dirty = () => JSON.stringify(sections) !== original;
  const excluded = new Set(p.latestExcludes);

  /** Applique une reponse du serveur (profil a jour) en gardant les sections non enregistrees. */
  const apply = (r) => {
    if (!r) return;
    r.self = p.self;
    state.profile = r;
    p.libraries = r.libraries;
    p.latestExcludes = r.latestExcludes;
    excluded.clear();
    r.latestExcludes.forEach((k) => excluded.add(k));
    draw();
  };

  const draw = () => {
    el.innerHTML = `<div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><h2>${t("Sections de l'accueil")}</h2><p>${t("Ordre des blocs sur la page d'accueil des apps Jellyfin.")}</p></div></div>
        <div class="segmented" id="mode" style="margin-bottom:14px"><button type="button" data-m="app" class="${sections ? '' : 'on'}">${t("Laisser l'app décider")}</button><button type="button" data-m="custom" class="${sections ? 'on' : ''}">${t('Personnaliser')}</button></div>
        ${sections ? `<div class="list" id="secList">${sections.map((s, i) => `<div class="item" data-key="${i}">${handleBtn(sections.length < 2)}
            <div class="body"><select data-sec="${i}">${SECTIONS.map(([v, l]) => `<option value="${v}" ${v === s ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select></div>
            <div class="actions"><button class="btn ghost icon-only" data-rmsec="${i}" title="${esc(t('Retirer'))}">${icon('trash')}</button></div></div>`).join('')}</div>
          <div class="row" style="margin-top:10px">${sections.length < 10 ? `<button class="btn sm" id="addSec">${icon('plus')}${t('Ajouter une section')}</button>` : ''}<button class="btn sm ghost" id="preset">${t('Disposition recommandée')}</button></div>`
        : `<p class="muted">${t("Chaque app garde sa propre disposition (réglable dans l'app : Paramètres → Accueil).")}</p>`}
        <p class="small faint" style="margin-top:12px">${t("Les apps appliquent la disposition au prochain chargement de l'accueil. Si l'utilisateur la change dans l'app, elle est reprise ici.")}</p>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>${t('Mes médias et rangées')}</h2><p>${t("Tuiles de « Mes médias » et rangées de l'accueil, dans cet ordre (Jellyfin utilise le même ordre pour les deux).")}</p></div></div>
        ${p.libraries.length ? `<div class="list" id="libOrder">${p.libraries.map((l) => `<div class="item" data-key="${esc(l.key)}">${handleBtn(p.libraries.length < 2)}
            <div style="width:96px;height:54px;border-radius:6px;overflow:hidden;flex:none;background:var(--input);display:grid;place-items:center">${l.preview ? `<img src="${esc(l.preview)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : icon('layers')}</div>
            <div class="body"><div class="title">${esc(l.name)}</div><div class="meta"><span class="badge">${esc(typeLabel(l.type))}</span>${l.image ? `<span class="badge accent">${t('image perso')}</span>` : ''}</div></div>
            <div class="actions"><button class="btn ghost icon-only" data-img="${esc(l.key)}" title="${esc(t("Changer l'image de la tuile"))}" aria-label="${esc(t("Changer l'image"))}">${icon('camera')}</button>
              <label class="row small muted" style="gap:6px" title="${esc(t("Rangée « ajouts récents » sur l'accueil"))}">${t('Rangée')} ${toggle(`data-latest="${esc(l.key)}" aria-label="${esc(t("Rangée sur l'accueil"))}"`, !excluded.has(l.key))}</label></div></div>`).join('')}</div>`
          : `<div class="empty">${icon('layers')}<p>${t('Aucune bibliothèque active.')}</p></div>`}
        <input type="file" id="libImgFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div>
    </div>
    <div class="savebar ${dirty() ? '' : 'hidden'}" id="homeSave"><span>${t('Sections non enregistrées')}</span><div class="row"><button class="btn ghost" id="homeCancel">${t('Annuler')}</button><button class="btn primary" id="homeDo">${t('Enregistrer')}</button></div></div>`;

    // ---- Sections ----
    $('#mode').onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      sections = b.dataset.m === 'custom' ? sections || [...RECOMMENDED_HOME] : null;
      draw();
    };
    const list = $('#secList');
    if (list) {
      sortable(list, (keys) => {
        sections = keys.map((k) => sections[Number(k)]);
        draw();
      });
      list.addEventListener('change', (e) => {
        const i = e.target.dataset.sec;
        if (i !== undefined) {
          sections[Number(i)] = e.target.value;
          draw();
        }
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-rmsec]');
        if (!b) return;
        sections.splice(Number(b.dataset.rmsec), 1);
        draw();
      });
    }
    if ($('#addSec')) $('#addSec').onclick = () => {
      sections.push(SECTIONS.find(([v]) => !sections.includes(v))?.[0] || 'latestmedia');
      draw();
    };
    if ($('#preset')) $('#preset').onclick = () => {
      sections = [...RECOMMENDED_HOME];
      draw();
    };
    $('#homeCancel').onclick = () => {
      sections = original === 'null' ? null : JSON.parse(original);
      draw();
    };
    $('#homeDo').onclick = async (e) => {
      const r = await busy(e.currentTarget, () => api('PATCH', `/profiles/${p.id}`, { homeSections: sections }), t('Accueil enregistré'));
      if (r) {
        r.self = p.self;
        state.profile = r;
        tabHome(el, r);
      }
    };

    // ---- Mes medias et rangees (enregistre aussitot) ----
    const libs = $('#libOrder');
    if (!libs) return;
    sortable(libs, async (keys) => apply(await busy(null, () => api('PUT', `/profiles/${p.id}/libraries/order`, { keys }), t('Ordre enregistré'))));
    libs.addEventListener('change', async (e) => {
      const key = e.target.dataset.latest;
      if (!key) return;
      if (e.target.checked) excluded.delete(key);
      else excluded.add(key);
      const r = await busy(null, () => api('PATCH', `/profiles/${p.id}`, { latestExcludes: [...excluded] }), e.target.checked ? t('Rangée affichée') : t('Rangée masquée'));
      if (r) apply(r);
      else draw();
    });
    libs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-img]');
      if (b) imageDialog(p.libraries.find((l) => l.key === b.dataset.img));
    });
  };

  /** Image d'une tuile : fichier, adresse, ou retour a l'image automatique. */
  const imageDialog = async (lib) => {
    const enc = encodeURIComponent(lib.key);
    const done = modal({
      title: t('Image de « {name} »', { name: lib.name }),
      lead: t('Format conseillé : paysage 16:9 (par exemple 1280 × 720). PNG, JPEG, WebP ou GIF, 3 Mo max.'),
      okLabel: t("Enregistrer l'adresse"),
      body: `<div class="stack">
        ${lib.preview ? `<img src="${esc(lib.preview)}" alt="" style="width:100%;aspect-ratio:16/9;border-radius:10px;object-fit:cover;background:var(--input)">` : ''}
        <div class="row"><button type="button" class="btn" id="imgUpload">${icon('camera')}${t('Envoyer une image')}</button>
          ${lib.image ? `<button type="button" class="btn ghost" id="imgAuto">${t("Revenir à l'image automatique")}</button>` : ''}</div>
        <div class="field"><label>${t("Ou adresse d'une image")}</label><input name="url" type="url" placeholder="https://…/image.jpg" value="${esc(lib.image && /^https?:/.test(lib.image) ? lib.image : '')}"></div>
      </div>`,
      onOk: async (f) => {
        if (!f.url.value.trim()) throw new Error(t('Indique une adresse, ou envoie une image'));
        return api('PUT', `/profiles/${p.id}/library-image?key=${enc}`, { url: f.url.value.trim() });
      }
    });
    const close = () => $('.backdrop [data-close]')?.click();
    $('#imgUpload').onclick = () => $('#libImgFile').click();
    $('#libImgFile').onchange = async (ev) => {
      const file = ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) return toast(t('Image trop lourde (3 Mo max.)'), true);
      const r = await busy($('#imgUpload'), () => api('PUT', `/profiles/${p.id}/library-image?key=${enc}`, file), t('Image enregistrée'));
      if (r) {
        close();
        apply(r);
      }
    };
    if ($('#imgAuto')) $('#imgAuto').onclick = async () => {
      const r = await busy($('#imgAuto'), () => api('DELETE', `/profiles/${p.id}/library-image?key=${enc}`), t('Image automatique'));
      if (r) {
        close();
        apply(r);
      }
    };
    const r = await done;
    if (r && r !== true) {
      toast(t('Image enregistrée'));
      apply(r);
    }
  };

  draw();
}

function tabAddons(el, p) {
  el.innerHTML = `<div class="card">
    <div class="card-head"><div><h2>${t('Addons Stremio')}</h2><p>${t("L'ordre compte : pour une fiche, le premier addon capable de la fournir est utilisé (après TMDB).")}</p></div>
      <div class="row">${p.self ? '' : `<button class="btn sm" id="copyAddons">${icon('copy')}${t('Copier depuis…')}</button>`}<button class="btn sm" id="refreshAddons">${icon('refresh')}${t('Recharger')}</button></div></div>
    <form class="row" id="addAddon" style="margin-bottom:16px"><input class="grow" name="url" type="url" placeholder="${esc(t('https://…/manifest.json ou stremio://…'))}" style="width:auto" required>
      <button class="btn primary" type="submit">${icon('plus')}${t('Ajouter')}</button></form>
    ${p.addons.length ? `<div class="list" id="addonList">${p.addons.map((a) => `<div class="item ${a.enabled ? '' : 'off'}" data-key="${esc(a.url)}">
        ${handleBtn(p.addons.length < 2)}
        <div class="logo">${a.logo ? `<img src="${esc(a.logo)}" alt="" loading="lazy" onerror="this.remove()">` : icon('puzzle')}</div>
        <div class="body"><div class="title">${esc(a.name)} ${a.version ? `<span class="faint small">v${esc(a.version)}</span>` : ''} ${a.ok ? '' : `<span class="badge bad">${t('Injoignable')}</span>`}</div>
          <div class="meta">${a.resources.map((r) => `<span class="badge">${esc(r)}</span>`).join('')}${a.description ? `<span class="small">${esc(a.description.slice(0, 120))}</span>` : ''}</div></div>
        <div class="actions">
          ${a.catalogCount ? `<button class="btn sm ${a.catalogsHidden ? '' : 'ghost'}" data-cats="${a.index}" title="${esc(a.catalogsHidden ? t('Ses catalogues ne sont pas proposés comme bibliothèques') : t('Ses catalogues sont proposés dans Bibliothèques'))}">${icon('layers')}${a.catalogsHidden ? t('Catalogues masqués') : t('{n} catalogue(s)', { n: a.catalogCount })}</button>` : ''}
          ${a.configureUrl ? `<a class="btn ghost icon-only" href="${esc(a.configureUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(t("Configurer l'addon"))}">${icon('settings')}</a>` : ''}
          ${toggle(`data-enable="${a.index}" aria-label="${esc(t('Activer'))}"`, a.enabled)}
          <button class="btn ghost icon-only" data-del="${a.index}" title="${esc(t('Retirer'))}">${icon('trash')}</button>
        </div></div>`).join('')}</div>
      <p class="small faint" style="margin-top:10px">${t("« Catalogues » : cliquer pour garder l'addon seulement pour ses sources et ses fiches, sans proposer ses catalogues.")}</p>`
      : `<div class="empty">${icon('puzzle')}<p>${t('Aucun addon. Ajoute au moins un addon de sources pour pouvoir lire.')}</p></div>`}
  </div>`;

  const refresh = (r) => {
    if (!r) return;
    r.self = p.self;
    state.profile = r;
    tabAddons(el, r);
  };
  $('#addAddon').onsubmit = async (e) => {
    e.preventDefault();
    refresh(await busy($('#addAddon button'), () => api('POST', `/profiles/${p.id}/addons`, { url: e.target.url.value }), t('Addon ajouté')));
  };
  $('#refreshAddons').onclick = async (e) => refresh(await busy(e.currentTarget, () => api('POST', `/profiles/${p.id}/addons/refresh`), t('Manifests rechargés')));
  if ($('#copyAddons')) $('#copyAddons').onclick = async () => {
    const others = (await api('GET', '/profiles')).filter((o) => o.id !== p.id);
    if (!others.length) return toast(t("Il n'y a pas d'autre profil"), true);
    const r = await modal({
      title: t('Copier des addons'),
      okLabel: t('Copier'),
      body: `<div class="stack"><div class="field"><label>${t('Depuis le profil')}</label><select name="from">${others.map((o) => `<option value="${o.id}">${t('{name} ({n} addons)', { name: esc(o.name), n: o.addonsCount })}</option>`).join('')}</select></div>
        <div class="field"><label>${t('Mode')}</label><select name="mode"><option value="merge">${t('Ajouter ceux qui manquent')}</option><option value="replace">${t('Remplacer tous les addons de ce profil')}</option></select></div></div>`,
      onOk: (f) => api('POST', `/profiles/${p.id}/addons/copy`, { from: f.from.value, mode: f.mode.value })
    });
    if (r) {
      toast(t('Addons copiés'));
      refresh(r);
    }
  };
  const list = $('#addonList');
  if (!list) return;
  const addonUrl = (idx) => `/profiles/${p.id}/addons/${idx}?url=${encodeURIComponent(p.addons[Number(idx)].url)}`;
  sortable(list, async (urls) => refresh(await busy(null, () => api('PUT', `/profiles/${p.id}/addons/order`, { urls }), t('Ordre enregistré'))));
  list.addEventListener('change', async (e) => {
    const idx = e.target.dataset.enable;
    if (idx === undefined) return;
    const r = await busy(null, () => api('PATCH', addonUrl(idx), { enabled: e.target.checked }), e.target.checked ? t('Addon activé') : t('Addon désactivé'));
    if (r) refresh(r);
    else e.target.checked = !e.target.checked;
  });
  list.addEventListener('click', async (e) => {
    const cats = e.target.closest('[data-cats]');
    if (cats) {
      const a = p.addons[Number(cats.dataset.cats)];
      refresh(await busy(cats, () => api('PATCH', addonUrl(cats.dataset.cats), { catalogsHidden: !a.catalogsHidden }), a.catalogsHidden ? t('Catalogues proposés') : t('Catalogues masqués')));
      return;
    }
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const a = p.addons[Number(del.dataset.del)];
    if (await confirmDialog(t('Retirer « {name} » ?', { name: a.name }), t('Ses catalogues disparaîtront des bibliothèques de ce profil.'), t('Retirer'), true)) {
      refresh(await busy(null, () => api('DELETE', addonUrl(del.dataset.del)), t('Addon retiré')));
    }
  });
}

const TYPE_LABEL = { movie: 'Films', series: 'Séries', collection: 'Sagas', platforms: 'Plateformes' };
const typeLabel = (type) => (TYPE_LABEL[type] ? t(TYPE_LABEL[type]) : type);

function tabLibraries(el, p) {
  // Copie de travail : rien n'est envoye avant "Enregistrer".
  let rows = p.catalogs.map((c) => ({ ...c }));
  const original = JSON.stringify(rows.map((r) => [r.key, r.enabled, r.name]));
  let filter = { q: '', status: 'all', source: '' };
  const sourceOf = (r) => (r.builtin ? t('TMDB intégré') : r.addonName);
  const sources = [...new Set(rows.map(sourceOf))];

  const dirty = () => JSON.stringify(rows.map((r) => [r.key, r.enabled, r.name])) !== original;
  const visible = (r) =>
    (filter.status === 'all' || (filter.status === 'on' ? r.enabled : !r.enabled)) &&
    (!filter.source || sourceOf(r) === filter.source) &&
    (!filter.q || `${r.name || r.defaultName} ${r.addonName}`.toLowerCase().includes(filter.q.toLowerCase()));
  const filtered = () => filter.q || filter.status !== 'all' || filter.source;

  el.innerHTML = `<div class="card">
    <div class="card-head"><div><h2>${t('Bibliothèques')}</h2><p>${t('Catalogues affichés comme bibliothèques dans les apps, dans cet ordre. Les catalogues « recherche » servent seulement à la recherche.')}</p></div></div>
    <div class="toolbar">
      <input type="search" id="libSearch" placeholder="${esc(t('Rechercher…'))}">
      <div class="segmented" id="libStatus"><button type="button" data-s="all" class="on">${t('Toutes')}</button><button type="button" data-s="on">${t('Actives')}</button><button type="button" data-s="off">${t('Inactives')}</button></div>
      <select id="libSource" style="width:auto"><option value="">${t('Toutes les sources')}</option>${sources.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
      <span class="grow"></span>
      <button class="btn sm" id="libAllOn">${t('Tout activer')}</button><button class="btn sm" id="libAllOff">${t('Tout désactiver')}</button>
    </div>
    <p class="small faint" id="libHint" style="margin:-4px 0 10px"></p>
    <div class="list" id="libList"></div>
    <div id="libEmpty"></div>
  </div>
  <div class="savebar hidden" id="libSave"><span>${t('Modifications non enregistrées')}</span><div class="row"><button class="btn ghost" id="libCancel">${t('Annuler')}</button><button class="btn primary" id="libDo">${t('Enregistrer')}</button></div></div>`;

  const draw = () => {
    const list = $('#libList');
    const shown = rows.filter(visible);
    list.innerHTML = shown.map((r) => `<div class="item ${r.enabled ? '' : 'off'}" data-key="${esc(r.key)}">
        ${handleBtn(filtered())}
        ${toggle(`data-on="${esc(r.key)}" aria-label="${esc(t('Activer'))}"`, r.enabled)}
        <div class="body"><input class="inline-name" data-name="${esc(r.key)}" value="${esc(r.name)}" placeholder="${esc(r.defaultName)}" maxlength="60" aria-label="${esc(t('Nom affiché'))}">
          <div class="meta"><span class="badge ${r.builtin ? 'accent' : ''}">${esc(sourceOf(r))}</span><span class="badge">${esc(typeLabel(r.type))}</span>${r.browsable ? '' : `<span class="badge warn">${t('Recherche')}</span>`}</div></div>
      </div>`).join('');
    $('#libEmpty').innerHTML = shown.length ? '' : `<div class="empty">${icon('layers')}<p>${t('Aucun catalogue ne correspond.')}</p></div>`;
    $('#libHint').textContent = filtered() ? t('Retire les filtres pour réordonner par glisser-déposer.') : t("Glisse les poignées pour changer l'ordre. Clique sur un nom pour le renommer.");
    $('#libSave').classList.toggle('hidden', !dirty());
  };
  draw();

  sortable($('#libList'), (keys) => {
    rows.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    draw();
  });
  $('#libList').addEventListener('change', (e) => {
    const key = e.target.dataset.on;
    if (key) {
      rows.find((r) => r.key === key).enabled = e.target.checked;
      draw();
    }
  });
  $('#libList').addEventListener('input', (e) => {
    const key = e.target.dataset.name;
    if (key) {
      rows.find((r) => r.key === key).name = e.target.value;
      $('#libSave').classList.toggle('hidden', !dirty());
    }
  });
  $('#libSearch').oninput = (e) => {
    filter.q = e.target.value;
    draw();
  };
  $('#libStatus').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    filter.status = b.dataset.s;
    $$('#libStatus button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  $('#libSource').onchange = (e) => {
    filter.source = e.target.value;
    draw();
  };
  const setAll = (v) => {
    rows.filter(visible).forEach((r) => (r.enabled = v));
    draw();
  };
  $('#libAllOn').onclick = () => setAll(true);
  $('#libAllOff').onclick = () => setAll(false);
  $('#libCancel').onclick = () => tabLibraries(el, state.profile);
  $('#libDo').onclick = async (e) => {
    const catalogs = {};
    for (const r of rows) {
      catalogs[r.key] = { enabled: r.enabled };
      if (r.name.trim()) catalogs[r.key].name = r.name.trim();
    }
    const res = await busy(e.currentTarget, () => api('PATCH', `/profiles/${p.id}`, { catalogs, catalogOrder: rows.map((r) => r.key) }), t('Bibliothèques enregistrées'));
    if (res) {
      res.self = p.self;
      state.profile = res;
      tabLibraries(el, res);
      const count = res.catalogs.filter((c) => c.enabled && c.browsable).length;
      const badge = $('.tab.active .count');
      if (badge) badge.textContent = count;
    }
  };
}

function deviceRows(devices, withProfile) {
  return `<div class="table-wrap"><table class="table"><thead><tr>
      <th>${t('Appareil')}</th><th>${t('Application')}</th>${withProfile ? `<th>${t('Profil')}</th>` : ''}<th>${t('Dernière activité')}</th><th></th></tr></thead><tbody>
      ${devices.map((d) => `<tr><td><b>${esc(d.device || t('Inconnu'))}</b><div class="small faint">${t('connecté {when}', { when: ago(d.created) })}</div></td>
        <td>${esc(d.client || '?')} <span class="faint small">${esc(d.version || '')}</span></td>
        ${withProfile ? `<td><a href="#/profiles/${d.profileId}">${esc(d.profileName)}</a></td>` : ''}
        <td>${ago(d.lastSeen)}</td>
        <td class="actions"><button class="btn sm danger" data-revoke="${d.id}">${t('Déconnecter')}</button></td></tr>`).join('')}
    </tbody></table></div>`;
}

function bindRevoke(root, after) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    if (await busy(b, () => api('DELETE', `/devices/${b.dataset.revoke}`), t('Appareil déconnecté'))) after();
  });
}

function tabDevices(el, p) {
  el.innerHTML = `<div class="card">
    <div class="card-head"><div><h2>${t('Appareils connectés')}</h2><p>${t('Applications ayant une session ouverte sur ce profil.')}</p></div>
      ${p.devices.length ? `<button class="btn sm danger" id="revokeAll">${t('Tout déconnecter')}</button>` : ''}</div>
    ${p.devices.length ? deviceRows(p.devices, false) : `<div class="empty">${icon('devices')}<p>${t('Aucun appareil connecté.')}</p></div>`}
  </div>`;
  bindRevoke(el, () => render());
  if ($('#revokeAll')) $('#revokeAll').onclick = async () => {
    if (await confirmDialog(t('Déconnecter tous les appareils ?'), t('Il faudra se reconnecter sur chacun.'), t('Déconnecter'), true)) {
      if (await busy(null, () => api('DELETE', `/profiles/${p.id}/devices`), t('Appareils déconnectés'))) render();
    }
  };
}

// Tous les appareils
PAGES.devices = async (main) => {
  const devices = await api('GET', '/devices');
  main.innerHTML = `${head(t('Appareils'), t('Toutes les applications connectées, tous profils confondus.'))}
    <div class="card">${devices.length ? deviceRows(devices, true) : `<div class="empty">${icon('devices')}<p>${t('Aucun appareil connecté.')}</p></div>`}</div>`;
  bindRevoke(main, () => render());
};

// ---- Reglages ------------------------------------------------------------------------------------

/** Enregistre une partie des reglages et met a jour l'etat local. */
async function saveSettings(btn, patch) {
  const s = await busy(btn, () => api('PUT', '/settings', patch), t('Réglages enregistrés'));
  if (s) state.settings = s;
  return s;
}

PAGES['settings/server'] = async (main) => {
  const s = state.settings;
  main.innerHTML = `${head(t('Serveur'), t('Identité du serveur et adresse donnée aux apps.'))}
    <form class="card" id="f">
      <div class="setting"><div class="text"><b>${t('Nom du serveur')}</b><span>${t('Affiché dans les apps et la découverte réseau.')}</span></div>
        <div class="control wide"><input name="serverName" type="text" maxlength="60" value="${esc(s.serverName)}" required></div></div>
      <div class="setting"><div class="text"><b>${t('URL publique')}</b><span>${t('Adresse HTTPS si le serveur est derrière un reverse-proxy. Vide : déduite de chaque requête.')}</span></div>
        <div class="control wide"><input name="publicUrl" type="url" placeholder="https://jelly.mondomaine.com" value="${esc(s.publicUrl)}"></div></div>
      <div class="setting"><div class="text"><b>${t('Langue des libellés')}</b><span>${t('Noms générés par le serveur pour les apps (Saison, Films, Séries…).')}</span></div>
        <div class="control"><select name="language">${UI.languages.map((l) => `<option value="${l.code}" ${s.language === l.code ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div></div>
      <div class="setting"><div class="text"><b>${t('Tri des bibliothèques dans les apps Emby')}</b><span>${t("Les apps Emby demandent toujours un tri par nom. <b>Ordre du catalogue</b> : populaires, tendances… comme prévu par le catalogue, et ouverture plus rapide (déjà prêt en cache). Les autres tris choisis dans l'app (date, note) restent respectés.")}</span></div>
        <div class="control"><div class="segmented" id="embySort"><button type="button" data-v="catalog" class="${s.embySort !== 'name' ? 'on' : ''}">${t('Ordre du catalogue')}</button><button type="button" data-v="name" class="${s.embySort === 'name' ? 'on' : ''}">${t('Par nom')}</button></div></div></div>
      <div class="row end" style="margin-top:8px"><button class="btn primary" type="submit">${t('Enregistrer')}</button></div>
    </form>`;
  let embySort = s.embySort === 'name' ? 'name' : 'catalog';
  $('#embySort').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    embySort = b.dataset.v;
    $$('#embySort button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    saveSettings($('button[type=submit]', f), { serverName: f.serverName.value, publicUrl: f.publicUrl.value, language: f.language.value, embySort });
  };
};

PAGES['settings/playback'] = async (main) => {
  const s = state.settings;
  main.innerHTML = `${head(t('Lecture et réseau'), t('Comment les vidéos et les addons sont joints.'))}
    <form class="card" id="f">
      <div class="setting"><div class="text"><b>${t('Lecture des vidéos')}</b><span>${t("<b>Via le serveur</b> : la vidéo passe par ce serveur (IP du serveur ou WARP). <b>Directe</b> : l'app lit la source elle-même.")}</span></div>
        <div class="control"><div class="segmented" id="mode"><button type="button" data-v="proxy" class="${s.streamMode === 'proxy' ? 'on' : ''}">${t('Via le serveur')}</button><button type="button" data-v="redirect" class="${s.streamMode === 'redirect' ? 'on' : ''}">${t('Directe')}</button></div></div></div>
      <div class="setting"><div class="text"><b>${t('Sortie réseau')}</b><span>${t('Pour joindre les addons et les vidéos (ex. Cloudflare WARP en SOCKS5).')}</span></div>
        <div class="control"><select name="upMode"><option value="direct">${t('Directe')}</option><option value="socks">SOCKS5</option><option value="http">${t('Proxy HTTP')}</option></select></div></div>
      <div class="setting" id="upUrlRow"><div class="text"><b>${t('Adresse du proxy de sortie')}</b><span>${t('Ex. {a} ou {b}.', { a: '<code>socks5://127.0.0.1:40000</code>', b: '<code>http://user:pass@hote:port</code>' })}</span></div>
        <div class="control wide"><input name="upUrl" type="text" value="${esc(s.upstream.url)}" placeholder="socks5://127.0.0.1:40000"></div></div>
      <div class="setting"><div class="text"><b>${t('Serveur de streaming Stremio')}</b><span>${t('Pour lire les sources torrent sans débrideur. Vide : torrents ignorés.')}</span></div>
        <div class="control wide"><input name="torrentServer" type="url" value="${esc(s.torrentServer)}" placeholder="http://stremio-server:11470"></div></div>
      <div class="setting"><div class="text"><b>${t('Attente max des addons de sources')}</b><span>${t('Au-delà, un addon trop lent est ignoré pour cette recherche.')}</span></div>
        <div class="control"><div class="row"><input name="timeout" type="number" min="3" max="60" step="1" value="${Math.round(s.streamTimeout / 1000)}" style="width:90px"><span class="muted">${t('secondes')}</span></div></div></div>
      <div class="row end" style="margin-top:8px"><button class="btn primary" type="submit">${t('Enregistrer')}</button></div>
    </form>`;
  const f = $('#f');
  let mode = s.streamMode;
  f.upMode.value = s.upstream.mode;
  const syncUp = () => $('#upUrlRow').classList.toggle('hidden', f.upMode.value === 'direct');
  syncUp();
  f.upMode.onchange = syncUp;
  $('#mode').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    mode = b.dataset.v;
    $$('#mode button').forEach((x) => x.classList.toggle('on', x === b));
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const secs = Number(f.timeout.value);
    if (!(secs >= 3 && secs <= 60)) return toast(t("L'attente doit être entre 3 et 60 secondes"), true);
    saveSettings($('button[type=submit]', f), {
      streamMode: mode,
      upstream: { mode: f.upMode.value, url: f.upMode.value === 'direct' ? '' : f.upUrl.value },
      torrentServer: f.torrentServer.value,
      streamTimeout: secs * 1000
    });
  };
};

PAGES['settings/metadata'] = async (main) => {
  const s = state.settings;
  const LANG_OPTS = [['fr-FR', 'Français (France)'], ['fr-CA', 'Français (Canada)'], ['en-US', 'English (US)'], ['es-ES', 'Español'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano']];
  main.innerHTML = `${head(t('Métadonnées'), t("Fiches, langue, épisodes et saut d'intro."))}
    <form class="card" id="f">
      <div class="setting"><div class="text"><b>${t('Clé API TMDB')}</b><span>${t('Fiches traduites pour tous les titres, tendances, plateformes, sagas, « Similaires ». Clé v3 gratuite sur {link}. Vérifiée avant l\'enregistrement.', { link: '<a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">themoviedb.org</a>' })}</span></div>
        <div class="control wide"><input name="key" type="text" autocomplete="off" spellcheck="false" value="${esc(s.tmdbApiKey)}" placeholder="${esc(t('Clé v3 (32 caractères)'))}"></div></div>
      <div class="setting"><div class="text"><b>${t('Langue des fiches')}</b><span>${t('Titres, résumés, genres. Le pays sert aussi aux plateformes et aux classifications.')}</span></div>
        <div class="control"><select name="lang">${LANG_OPTS.map(([v, l]) => `<option value="${v}" ${s.metadataLanguage === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="setting"><div class="text"><b>${t('Masquer les épisodes pas encore sortis')}</b><span>${t("Les épisodes annoncés mais pas encore diffusés n'apparaissent pas.")}</span></div>
        <div class="control">${toggle('name="hideUnreleased"', s.hideUnreleased)}</div></div>
      <div class="setting"><div class="text"><b>${t("Passer l'intro et le générique")}</b><span>${t("Boutons dans les apps Jellyfin, d'après la base communautaire TheIntroDB.")}</span></div>
        <div class="control">${toggle('name="introSkip"', s.introSkip)}</div></div>
      <div class="row end" style="margin-top:8px">${s.tmdbApiKey ? `<button class="btn danger" type="button" id="keyDel">${t('Retirer la clé')}</button>` : ''}<button class="btn primary" type="submit">${t('Enregistrer')}</button></div>
    </form>`;
  const f = $('#f');
  f.onsubmit = (e) => {
    e.preventDefault();
    saveSettings($('button[type=submit]', f), {
      tmdbApiKey: f.key.value.trim(),
      metadataLanguage: f.lang.value,
      hideUnreleased: f.hideUnreleased.checked,
      introSkip: f.introSkip.checked
    }).then((r) => r && render());
  };
  if ($('#keyDel')) $('#keyDel').onclick = async () => {
    if (await confirmDialog(t('Retirer la clé TMDB ?'), t('Les fiches reviendront aux addons (souvent en anglais) et les catalogues TMDB intégrés disparaîtront.'), t('Retirer'), true)) {
      if (await saveSettings(null, { tmdbApiKey: '' })) render();
    }
  };
};

PAGES['settings/web'] = async (main) => {
  const s = state.settings;
  let theme = s.webTheme === 'none' ? 'none' : 'abyss';
  let source = s.webSpotlightSource === 'resume' ? 'resume' : 'trending';
  main.innerHTML = `${head(t('Client web'), t('Apparence de Jellyfin web servi par Stremfin (navigateur, Jellyfin Media Player, app Android pour téléphone).'))}
    <form class="card" id="f">
      <div class="setting"><div class="text"><b>${t('Thème')}</b><span>${t('<b>Abyss</b> : thème sombre minimaliste, surfaces en verre dépoli, police Google Sans ({link}, licence MIT). Polices et fichiers servis par Stremfin, sans appel externe.', { link: '<a href="https://github.com/AumGupta/abyss-jellyfin" target="_blank" rel="noopener noreferrer">AumGupta/abyss-jellyfin</a>' })}</span></div>
        <div class="control"><div class="segmented" id="theme"><button type="button" data-v="abyss" class="${theme === 'abyss' ? 'on' : ''}">Abyss</button><button type="button" data-v="none" class="${theme === 'none' ? 'on' : ''}">${t("Jellyfin d'origine")}</button></div></div></div>
      <div class="setting"><div class="text"><b>${t('Bannière Spotlight')}</b><span>${t("Grande bannière en haut de l'accueil, qui défile toute seule. Avec le thème Abyss seulement.")}</span></div>
        <div class="control">${toggle('name="spotlight"', s.webSpotlight !== false)}</div></div>
      <div class="setting"><div class="text"><b>${t('Contenu de Spotlight')}</b><span>${t('<b>Films tendance</b> : tendances du jour sur TMDB, même hors de tes bibliothèques, avec année et note. <b>Mes reprises</b> : reprises en cours, épisodes à suivre, puis derniers ajouts.')}${state.info?.tmdb ? '' : ` ${t('Les films tendance nécessitent une clé TMDB.')}`}</span></div>
        <div class="control"><div class="segmented" id="source"><button type="button" data-v="trending" class="${source === 'trending' ? 'on' : ''}">${t('Films tendance')}</button><button type="button" data-v="resume" class="${source === 'resume' ? 'on' : ''}">${t('Mes reprises')}</button></div></div></div>
      <p class="small faint">${t("Chaque profil peut ajouter son propre CSS (onglet Préférences du profil) : il s'applique après le thème. Les changements s'appliquent au prochain chargement de Jellyfin web.")}</p>
      <div class="row end" style="margin-top:8px">${state.web ? `<a class="btn ghost" href="/web/" target="_blank" rel="noopener">${icon('play')}${t('Ouvrir Jellyfin web')}</a>` : ''}<button class="btn primary" type="submit">${t('Enregistrer')}</button></div>
    </form>`;
  const f = $('#f');
  $('#theme').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    theme = b.dataset.v;
    $$('#theme button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#source').onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    source = b.dataset.v;
    $$('#source button').forEach((x) => x.classList.toggle('on', x === b));
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    saveSettings($('button[type=submit]', f), { webTheme: theme, webSpotlight: f.spotlight.checked, webSpotlightSource: source });
  };
};

PAGES['settings/platforms'] = async (main) => {
  const s = state.settings;
  let list = await api('GET', '/providers');
  const strip = (arr) => arr.map(({ id, name, color, card }) => ({ id, name, ...(color ? { color } : {}), ...(card ? { card } : {}) }));

  const persist = async (msg = t('Plateformes enregistrées')) => {
    const r = await busy(null, () => api('PUT', '/settings', { providers: strip(list) }), msg);
    if (r) {
      state.settings = r;
      list = await api('GET', '/providers');
    }
    draw();
  };

  const draw = () => {
    main.innerHTML = `${head(t('Plateformes'), t('Bibliothèque « Plateformes » : une carte large par service, puis ses rayons (populaires, nouveautés, mieux notés).'), s.tmdbApiKey ? `<button class="btn primary" id="addProv">${icon('plus')}${t('Ajouter')}</button>` : '')}
      ${s.tmdbApiKey ? '' : `<div class="card" style="margin-bottom:16px"><p>${t('Les plateformes nécessitent une {link}.', { link: `<a href="#/settings/metadata">${t('clé TMDB')}</a>` })}</p></div>`}
      <div class="card">${list.length ? `<div class="list" id="provList">${list.map((p) => `<div class="item" data-key="${p.id}">${handleBtn(list.length < 2)}
          <div class="logo">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : icon('tv')}</div>
          <img src="${esc(p.cardUrl)}" alt="${esc(t('Carte {name}', { name: p.name }))}" loading="lazy" style="width:128px;height:72px;border-radius:8px;object-fit:cover;flex:none;background:var(--input)">
          <div class="body"><div class="title">${esc(p.name)}</div>
            <div class="meta"><span>${t('Fournisseur TMDB n° {id}', { id: p.id })}</span>${p.color ? `<span class="badge">${t('fond {color}', { color: esc(p.color) })}</span>` : ''}${p.card ? `<span class="badge accent">${t('image perso')}</span>` : ''}</div></div>
          <div class="actions"><button class="btn ghost sm" data-edit="${p.id}">${icon('settings')}${t('Carte')}</button><button class="btn ghost icon-only" data-rm="${p.id}" title="${esc(t('Retirer'))}">${icon('trash')}</button></div></div>`).join('')}</div>`
        : `<div class="empty">${icon('tv')}<p>${t('Aucune plateforme.')}</p></div>`}</div>`;
    const el = $('#provList');
    if (el) {
      sortable(el, async (keys) => {
        list.sort((a, b) => keys.indexOf(String(a.id)) - keys.indexOf(String(b.id)));
        await persist(t('Ordre enregistré'));
      });
      el.addEventListener('click', async (e) => {
        const rm = e.target.closest('[data-rm]');
        if (rm) {
          list = list.filter((p) => String(p.id) !== rm.dataset.rm);
          return persist(t('Plateforme retirée'));
        }
        const ed = e.target.closest('[data-edit]');
        if (ed) editCard(list.find((p) => String(p.id) === ed.dataset.edit));
      });
    }
    if ($('#addProv')) $('#addProv').onclick = addDialog;
  };

  /** Couleur de fond et image personnalisee de la carte d'une plateforme. */
  const editCard = async (p) => {
    const done = modal({
      title: t('Carte « {name} »', { name: p.name }),
      lead: t('Par défaut : le logo officiel centré, sur la couleur de ses bords.'),
      okLabel: t('Enregistrer'),
      body: `<div class="stack">
        <img src="${esc(p.cardUrl)}" alt="" style="width:100%;aspect-ratio:16/9;border-radius:10px;object-fit:cover;background:var(--input)">
        <div class="field"><label>${t('Nom affiché')}</label><input name="name" type="text" maxlength="40" value="${esc(p.name)}" required></div>
        <div class="field"><label>${t('Couleur de fond (facultatif)')}</label><div class="row"><input name="colorPick" type="color" value="${esc(p.color || '#000000')}" style="width:48px;height:38px;padding:2px">
          <input name="color" type="text" placeholder="${esc(t('automatique'))}" value="${esc(p.color || '')}" style="width:140px"><button type="button" class="btn sm ghost" id="autoColor">${t('Automatique')}</button></div></div>
        <div class="field"><label>${t('Image de carte personnalisée (facultatif)')}</label><input name="card" type="url" placeholder="https://…/carte.png (16:9)" value="${esc(p.card)}"><span class="help">${t('Remplace la carte générée.')}</span></div>
      </div>`,
      onOk: async (f) => {
        const color = f.color.value.trim();
        if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(t('Couleur invalide (format #rrggbb)'));
        Object.assign(p, { name: f.name.value.trim() || p.name, color, card: f.card.value.trim() });
        return true;
      }
    });
    // La fenetre est deja dans la page : selecteur de couleur et bouton "Automatique".
    const form = $('.modal');
    form.colorPick.oninput = () => (form.color.value = form.colorPick.value);
    $('#autoColor').onclick = () => (form.color.value = '');
    if (await done) await persist(t('Carte enregistrée'));
  };
  const addDialog = async () => {
    const avail = await busy(null, () => api('GET', '/providers/available'));
    if (!avail) return;
    const chosen = new Set(list.map((p) => p.id));
    const closed = modal({
      title: t('Ajouter des plateformes'),
      lead: t('Services de streaming connus de TMDB pour ton pays. Clique pour ajouter.'),
      okLabel: t('Terminé'),
      cancelLabel: '',
      wide: true,
      body: `<input type="search" id="provQ" placeholder="${esc(t('Rechercher…'))}" style="margin-bottom:12px"><div class="provider-pick" id="provPick">${avail.map((p) => `<button type="button" data-id="${p.id}" data-name="${esc(p.name)}" ${chosen.has(p.id) ? 'disabled' : ''}>${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></button>`).join('')}</div>`,
      onOk: () => true
    });
    $('#provPick').onclick = async (e) => {
      const b = e.target.closest('[data-id]');
      if (!b || b.disabled) return;
      b.disabled = true;
      list.push({ id: Number(b.dataset.id), name: b.dataset.name });
      const r = await busy(null, () => api('PUT', '/settings', { providers: strip(list) }));
      if (r) state.settings = r;
      else b.disabled = false;
    };
    $('#provQ').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      $$('#provPick [data-id]').forEach((b) => (b.style.display = b.dataset.name.toLowerCase().includes(q) ? '' : 'none'));
    };
    await closed;
    list = await api('GET', '/providers');
    draw();
  };
  draw();
};

// ---- Maintenance -----------------------------------------------------------------------------------

PAGES.maintenance = async (main) => {
  const o = await api('GET', '/overview');
  main.innerHTML = `${head(t('Maintenance'), t('Actions sans risque pour les données des profils.'))}
    <div class="grid grid-3">
      <div class="card stack"><h2>${t('Vider le cache')}</h2><p class="muted">${t('{n} entrées (catalogues, fiches, sources, TMDB, intros). Elles seront rechargées au besoin. La progression et les réglages ne sont pas touchés.', { n: num(o.cacheEntries) })}</p>
        <div class="row end"><button class="btn" id="mClear">${icon('trash')}${t('Vider')}</button></div></div>
      <div class="card stack"><h2>${t('Recharger les addons')}</h2><p class="muted">${t('Relit le manifest de chaque addon de chaque profil (nouveaux catalogues, nouvelle version).')}</p>
        <div class="row end"><button class="btn" id="mAddons">${icon('refresh')}${t('Recharger')}</button></div></div>
      <div class="card stack"><h2>${t('Réindexer TMDB')}</h2><p class="muted">${t('Recharge les genres et reconstruit la liste des sagas.')}</p>
        <div class="row end"><button class="btn" id="mTmdb" ${o.tmdb ? '' : 'disabled'}>${icon('refresh')}${t('Réindexer')}</button></div></div>
    </div>
    ${o.brokenAddons.length ? `<div class="card" style="margin-top:16px"><div class="card-head"><div><h2>${t('Addons injoignables')}</h2><p>${t('Leur manifest ne répond pas.')}</p></div></div>
      ${o.brokenAddons.map((b) => `<div class="recent"><span class="badge bad">${esc(b.profile)}</span><code class="grow" style="overflow:hidden;text-overflow:ellipsis">${esc(b.url.replace(/^(https?:\/\/[^/]+).*/, '$1/…'))}</code></div>`).join('')}</div>` : ''}`;
  $('#mClear').onclick = async (e) => (await busy(e.currentTarget, () => api('POST', '/maintenance/clear-cache'), t('Cache vidé'))) && render();
  $('#mAddons').onclick = async (e) => {
    const r = await busy(e.currentTarget, () => api('POST', '/maintenance/refresh-addons'));
    if (r) {
      toast(r.broken ? t('{n} addon(s) injoignable(s)', { n: r.broken }) : t('Tous les addons ont répondu'), !!r.broken);
      render();
    }
  };
  $('#mTmdb').onclick = (e) => busy(e.currentTarget, () => api('POST', '/maintenance/reindex-tmdb'), t('Réindexation lancée'));
};

// ---- Sauvegardes ------------------------------------------------------------------------------------

const BACKUP_KIND = { auto: 'Automatique', manual: 'Manuelle', upload: 'Envoyée' };

PAGES.backups = async (main) => {
  const data = await api('GET', '/backups');
  const s = data.settings;
  main.innerHTML = `${head(t('Sauvegardes'), t("Base de données, réglages, avatars et images des tuiles. Le cache n'est pas sauvegardé : il se reconstruit tout seul."),
    `<button class="btn" id="bUpload">${icon('upload')}${t('Envoyer une sauvegarde')}</button><button class="btn primary" id="bNow">${icon('archive')}${t('Sauvegarder maintenant')}</button>`)}
    <input type="file" id="bFile" accept=".gz,.tar.gz,application/gzip" hidden>
    <div class="grid backups-grid">
      <form class="card" id="bSet">
        <div class="card-head"><div><h2>${t('Sauvegarde automatique')}</h2><p>${t('Une par jour, gardée le nombre de jours choisi. Les sauvegardes manuelles et envoyées sont gardées jusqu\'à leur suppression.')}</p></div></div>
        <div class="setting"><div class="text"><b>${t('Activée')}</b></div><div class="control">${toggle('name="enabled"', s.backupEnabled)}</div></div>
        <div class="setting"><div class="text"><b>${t('Heure')}</b><span>${t('Heure du serveur.')}</span></div>
          <div class="control"><select name="hour" style="width:auto">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.backupHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div></div>
        <div class="setting"><div class="text"><b>${t('Garder')}</b></div>
          <div class="control"><div class="row"><input name="keep" type="number" min="1" max="365" value="${s.backupRetention}" style="width:80px"><span class="muted">${t('jours')}</span></div></div></div>
        <div class="row end" style="margin-top:8px"><button class="btn primary" type="submit">${t('Enregistrer')}</button></div>
      </form>
      <div class="card">
        <div class="card-head"><div><h2>${t('Sauvegardes disponibles')}</h2><p>${t('Dans le dossier data/backups du serveur.')}</p></div></div>
        ${data.backups.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${t('Date')}</th><th>${t('Type')}</th><th>${t('Taille')}</th><th></th></tr></thead><tbody>
          ${data.backups.map((b) => `<tr><td class="nowrap"><b>${esc(fmtDate(b.createdAt))}</b><div class="small faint">${ago(b.createdAt)}</div></td>
            <td><span class="badge ${b.kind === 'auto' ? '' : 'accent'}">${t(BACKUP_KIND[b.kind] || b.kind)}</span></td>
            <td class="nowrap">${fmtSize(b.size)}</td>
            <td class="actions"><a class="btn ghost icon-only" href="/stremfin/api/backups/${encodeURIComponent(b.name)}/download" download title="${esc(t('Télécharger'))}" aria-label="${esc(t('Télécharger'))}">${icon('download')}</a>
              <button class="btn sm" data-restore="${esc(b.name)}">${icon('restore')}${t('Restaurer')}</button>
              <button class="btn ghost icon-only" data-del="${esc(b.name)}" title="${esc(t('Supprimer'))}" aria-label="${esc(t('Supprimer'))}">${icon('trash')}</button></td></tr>`).join('')}
          </tbody></table></div>`
          : `<div class="empty">${icon('archive')}<p>${t('Aucune sauvegarde pour l\'instant.')}</p></div>`}
      </div>
    </div>`;

  $('#bNow').onclick = async (e) => (await busy(e.currentTarget, () => api('POST', '/backups'), t('Sauvegarde créée'))) && render();
  $('#bUpload').onclick = () => $('#bFile').click();
  $('#bFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (await busy($('#bUpload'), () => api('PUT', '/backups/upload', file), t('Sauvegarde ajoutée à la liste'))) render();
  };
  $('#bSet').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const keep = Number(f.keep.value);
    if (!(keep >= 1 && keep <= 365)) return toast(t('Entre 1 et 365 jours'), true);
    if (await saveSettings($('button[type=submit]', f), { backupEnabled: f.enabled.checked, backupHour: Number(f.hour.value), backupRetention: keep })) render();
  };
  main.querySelector('.table')?.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const b = data.backups.find((x) => x.name === del.dataset.del);
      if (await confirmDialog(t('Supprimer cette sauvegarde ?'), esc(fmtDate(b.createdAt)), t('Supprimer'), true)) {
        if (await busy(null, () => api('DELETE', `/backups/${encodeURIComponent(b.name)}`), t('Sauvegarde supprimée'))) render();
      }
      return;
    }
    const rest = e.target.closest('[data-restore]');
    if (!rest) return;
    const b = data.backups.find((x) => x.name === rest.dataset.restore);
    const ok = await confirmDialog(
      t('Restaurer la sauvegarde du {date} ?', { date: fmtDate(b.createdAt) }),
      t('Profils, réglages, progression, avatars et images reviennent à cette date. Les données actuelles sont gardées dans data/backups. Le serveur redémarre : sous Docker, il revient seul en quelques secondes. Reconnecte-toi ensuite.'),
      t('Restaurer'),
      true
    );
    if (!ok || !(await busy(rest, () => api('POST', `/backups/${encodeURIComponent(b.name)}/restore`)))) return;
    restartWait();
  });
};

/** Attend le redemarrage du serveur apres une restauration, puis recharge la page. */
function restartWait() {
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bd.innerHTML = `<div class="modal" style="text-align:center"><h2>${t('Redémarrage du serveur…')}</h2><p class="lead">${t('La page se rechargera dès que le serveur répondra.')}</p><span class="spinner" style="display:inline-block;width:28px;height:28px;border:3px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></span></div>`;
  document.body.appendChild(bd);
  const started = Date.now();
  const poll = async () => {
    try {
      // Le serveur redemarre : on attend qu'il ait coupe (2 s) puis qu'il reponde.
      if (Date.now() - started > 2000 && (await fetch('/System/Info/Public', { cache: 'no-store' })).ok) return location.reload();
    } catch {}
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1500);
}

// ---- Securite ---------------------------------------------------------------------------------------

PAGES.security = async (main) => {
  const sessions = await api('GET', '/auth/sessions');
  main.innerHTML = `${head(t('Sécurité'), t('Compte administrateur et sessions ouvertes sur cette interface.'))}
    <div class="grid grid-2">
      <form class="card stack" id="acc">
        <h2>${t('Compte administrateur')}</h2>
        <div class="field"><label>${t("Nom d'utilisateur")}</label><input name="username" type="text" autocomplete="username" value="${esc(state.username)}" required></div>
        <div class="field"><label>${t('Nouveau mot de passe')} <span class="faint">${t('(laisser vide pour ne pas changer)')}</span></label><input name="pw" type="password" autocomplete="new-password"></div>
        <div class="field"><label>${t('Confirmer le nouveau mot de passe')}</label><input name="pw2" type="password" autocomplete="new-password"></div>
        <div class="field"><label>${t('Mot de passe actuel')}</label><input name="current" type="password" autocomplete="current-password" required><span class="help">${t('Obligatoire pour toute modification. Un nouveau mot de passe ferme les autres sessions.')}</span></div>
        <div class="row end"><button class="btn primary" type="submit">${t('Enregistrer')}</button></div>
      </form>
      <div class="card">
        <div class="card-head"><div><h2>${t('Sessions admin')}</h2><p>${t('Navigateurs connectés à cette interface.')}</p></div>
          ${sessions.length > 1 ? `<button class="btn sm danger" id="killOthers">${t('Fermer les autres')}</button>` : ''}</div>
        ${sessions.map((s) => `<div class="recent"><div class="grow"><b>${esc((s.userAgent || t('Navigateur')).replace(/^Mozilla\/5\.0 \(([^)]*)\).*$/, '$1').slice(0, 70))}</b>
          <div class="small muted">${esc(s.ip || '?')} · ${t('ouverte {when}', { when: ago(s.created) })}</div></div>${s.current ? `<span class="badge ok">${t('Cette session')}</span>` : ''}</div>`).join('')}
      </div>
    </div>`;
  $('#acc').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.pw.value !== f.pw2.value) return toast(t('Les nouveaux mots de passe ne correspondent pas'), true);
    const r = await busy($('button[type=submit]', f), () => api('PUT', '/auth/account', { username: f.username.value.trim(), currentPassword: f.current.value, newPassword: f.pw.value || undefined }), t('Compte mis à jour'));
    if (r) {
      state.username = r.username;
      $('.sidebar-foot .who b').textContent = r.username;
      render();
    }
  };
  if ($('#killOthers')) $('#killOthers').onclick = async (e) => (await busy(e.currentTarget, () => api('DELETE', '/auth/sessions/others'), t('Autres sessions fermées'))) && render();
};

boot();
