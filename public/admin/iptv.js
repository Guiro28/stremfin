'use strict';
// TV en direct (IPTV) : sources Xtream Codes et M3U, leurs groupes et leurs chaines, sur le modele
// de Polyfin (docs/iptv.md). Admin : page "TV en direct" (sources du serveur, attribuees aux
// profils, et sources privees des utilisateurs). Utilisateur : onglet "TV en direct" de son compte
// (ses propres sources, privees). esc, $, $$, api, busy, modal, toast, icon, toggle, handleBtn,
// sortable, head, ago, num, t, state, go, render, PAGES : app.js.
(() => {
const MODE_LABELS = [
  ['direct', 'Via le serveur (IP du serveur)'],
  ['warp', 'Via le proxy externe (WARP, SOCKS ou HTTP)'],
  ['none', "Lu à la source par l'app (identifiants visibles par l'app)"]
];
const modeOptions = (selected) => MODE_LABELS.map(([m, l]) => `<option value="${m}" ${m === selected ? 'selected' : ''}>${esc(t(l))}</option>`).join('');
const kindLabel = (k) => (k === 'xtream' ? t('Compte Xtream') : t('Liste M3U'));

/** Adresse de base d'une source dans l'interface : admin (#/iptv) ou utilisateur (#/me/iptv). */
const baseHash = () => (state.role === 'admin' ? '#/iptv' : '#/me/iptv');

function dateOnly(ts) {
  return ts ? new Date(ts).toLocaleDateString(UI.locale, { dateStyle: 'medium' }) : '';
}

function accountLine(s) {
  const a = s.account;
  if (!a) return '';
  const parts = [];
  if (a.expires) parts.push(t('expire le {date}', { date: dateOnly(a.expires) }));
  if (a.maxConnections) parts.push(t('{n} connexion(s) simultanée(s)', { n: a.maxConnections }));
  if (a.trial) parts.push(t("compte d'essai"));
  return parts.join(' · ');
}

function sourceCard(s, admin) {
  const err = s.error ? `<p class="small" style="color:var(--bad)">${icon('alert')} ${esc(t(s.error))}</p>` : '';
  return `<article class="card iptv-source">
    <div class="iptv-source-top">
      <div class="iptv-source-icon">${icon('tv')}</div>
      <div class="grow" style="min-width:0">
        <div class="iptv-source-name">${esc(s.name)} <span class="badge neutral">${esc(kindLabel(s.kind))}</span>
          ${s.private ? `<span class="badge accent" title="${esc(t('Ajoutée par un utilisateur : seul son profil l’utilise'))}">${esc(s.ownerName ? t('Privée · {name}', { name: s.ownerName }) : t('Privée'))}</span>` : ''}
          ${s.refreshing ? `<span class="badge warn">${esc(t('Téléchargement…'))}</span>` : ''}</div>
        <p class="small muted">${esc(s.host)}${s.username ? ' · ' + esc(s.username) : ''}${accountLine(s) ? ' · ' + esc(accountLine(s)) : ''}</p>
        <p class="small muted">${t('{shown} chaîne(s) affichée(s) sur {total}', { shown: num(s.counts.shown), total: num(s.counts.channels) })}${s.counts.archive ? ' · ' + t('{n} avec replay', { n: num(s.counts.archive) }) : ''} · ${t('mise à jour {when}', { when: ago(s.lastRefresh) })}</p>
        ${err}
      </div>
      <div class="iptv-source-actions">
        ${admin && !s.private ? `<span class="badge neutral">${esc(s.users.length === 1 ? t('1 profil') : t('{n} profils', { n: s.users.length }))}</span>` : ''}
        <a class="btn sm primary" href="${baseHash()}/${s.id}">${esc(t('Gérer'))}</a>
        <button class="btn sm" data-refresh="${s.id}" title="${esc(t('Télécharger à nouveau la liste'))}">${icon('refresh')}</button>
        ${admin && !s.private ? `<button class="btn sm" data-assign="${s.id}">${esc(t('Attribuer'))}</button>` : ''}
        <button class="btn sm ghost" data-remove="${s.id}" title="${esc(t('Retirer'))}">${icon('trash')}</button>
      </div>
    </div></article>`;
}

/** Fenetre d'ajout en deux etapes : le compte, puis ce qu'on importe et les groupes. */
async function addSourceDialog(view) {
  const admin = state.role === 'admin';
  const step1 = await modal({
    title: t('Ajouter une source IPTV'),
    lead: admin ? t('La source rejoint le serveur ; attribue-la ensuite aux profils.') : t('La source est privée : seul ton profil l’utilise.'),
    okLabel: t('Continuer'),
    wide: true,
    body: `<div class="stack">
      <div class="field"><label>${t('Type de source')}</label><select name="kind"><option value="xtream">${t('Compte Xtream Codes')}</option><option value="m3u">${t('Liste M3U')}</option></select></div>
      <div class="field"><label>${t('Nom')}</label><input name="name" maxlength="80" required placeholder="${esc(t('Mon fournisseur'))}"></div>
      <div data-kind="xtream" class="stack">
        <div class="field"><label>${t('Adresse du serveur')}</label><input name="server" placeholder="http://exemple.com:8080"></div>
        <div class="row" style="gap:12px"><div class="field grow"><label>${t('Identifiant')}</label><input name="username" autocomplete="off"></div>
          <div class="field grow"><label>${t('Mot de passe')}</label><input name="password" type="password" autocomplete="new-password"></div></div>
      </div>
      <div data-kind="m3u" class="stack" hidden>
        <div class="field"><label>${t('Adresse de la liste M3U')}</label><input name="url" placeholder="https://…/liste.m3u"></div>
      </div>
      <details><summary class="small">${t('Options avancées')}</summary><div class="stack" style="margin-top:10px">
        <div class="field"><label>${t('User agent (optionnel)')}</label><input name="userAgent" placeholder="VLC/3.0.20"><span class="help">${t('Certains fournisseurs n’acceptent que leur app ou VLC.')}</span></div>
        <div class="field"><label>${t('Téléchargement des listes')}</label><select name="network"><option value="direct">${t('Par l’IP du serveur')}</option><option value="warp">${t('Par le proxy externe')}</option></select></div>
      </div></details>
    </div>`,
    onOk: async (f) => {
      const kind = f.kind.value;
      const body = { kind, name: f.name.value.trim(), userAgent: f.userAgent.value.trim(), network: f.network.value };
      if (kind === 'xtream') Object.assign(body, { server: f.server.value.trim(), username: f.username.value.trim(), password: f.password.value });
      else body.url = f.url.value.trim();
      return { body, preview: await api('POST', '/iptv/preview', body) };
    }
  });
  if (!step1) return null;
  return importDialog(step1.body, step1.preview);
}

// Bascule des champs Xtream / M3U dans la fenetre d'ajout.
document.addEventListener('change', (e) => {
  if (e.target.name !== 'kind' || !e.target.closest('.modal')) return;
  const form = e.target.closest('form');
  $$('[data-kind]', form).forEach((el) => (el.hidden = el.dataset.kind !== e.target.value));
});

/** Onglets Chaines TV / Films / Series (fenetre d'import et page Groupes). */
const KIND_TABS = [
  ['live', 'Chaînes TV', 'tv'],
  ['movie', 'Films', 'film'],
  ['series', 'Séries', 'layers']
];
const kindTabs = (current, counts, attr) =>
  `<div class="segmented iptv-kind-tabs">${KIND_TABS.map(([k, l]) => `<button type="button" ${attr}="${k}" class="${k === current ? 'on' : ''}">${esc(t(l))} <span class="iptv-tab-count">${num(counts[k] || 0)}</span></button>`).join('')}</div>`;

/** 2e etape : ce qu'on importe et les groupes a garder (decoches = masques), un onglet par type. */
async function importDialog(account, pv) {
  const groups = pv.groups;
  const vodGroups = { movie: pv.movieGroups || [], series: pv.seriesGroups || [] };
  const pick = (kind, value, name, count) =>
    `<label class="check-label iptv-group-pick" data-name="${esc(String(name || '').toLowerCase())}"><input type="checkbox" data-kind="${kind}" value="${esc(value)}" checked><span class="grow">${esc(name || (kind === 'live' ? t('Sans groupe') : t('Sans catégorie')))}</span><span class="badge neutral">${num(count)}</span></label>`;
  const list = (items, empty) => `<div class="iptv-group-list">${items.join('') || `<p class="muted">${empty}</p>`}</div>`;
  const acc = pv.account;
  const vodHelp = `<p class="small muted">${t('Même sans bibliothèque, les films et séries de la source servent de secours quand les addons ne trouvent rien. Une catégorie décochée n’apparaît nulle part.')}</p>`;
  const r = await modal({
    title: t('Ce qu’on importe'),
    lead: `${esc(t('{n} chaîne(s) dans {g} groupe(s).', { n: num(pv.channels), g: num(groups.length) }))}${acc?.expires ? ' ' + esc(t('Compte valable jusqu’au {date}.', { date: dateOnly(acc.expires) })) : ''}${acc?.maxConnections ? ' ' + esc(t('{n} connexion(s) simultanée(s).', { n: acc.maxConnections })) : ''}`,
    okLabel: t('Ajouter la source'),
    wide: true,
    body: `<div class="stack">
      ${kindTabs('live', { live: groups.length, movie: vodGroups.movie.length, series: vodGroups.series.length }, 'data-imp-tab')}
      <div class="row" style="gap:8px"><input type="search" id="grpSearch" class="grow" placeholder="${esc(t('Rechercher un groupe…'))}" style="width:auto">
        <button type="button" class="btn sm ghost" id="grpAll">${t('Tout inclure')}</button><button type="button" class="btn sm ghost" id="grpNone">${t('Tout exclure')}</button></div>
      <div class="stack" data-pane="live">
        <label class="check-label"><input type="checkbox" name="live" checked> ${t('Chaînes en direct')} <span class="faint small">${num(pv.channels)}</span></label>
        ${list(groups.map((g, i) => pick('live', i, g.name, g.channels)), t('Aucun groupe'))}
      </div>
      <div class="stack" data-pane="movie" hidden>
        <label class="check-label"><input type="checkbox" name="movies"> ${t('Films (une bibliothèque)')} <span class="faint small">${num(pv.movies || 0)}</span></label>
        ${list(vodGroups.movie.map((g) => pick('movie', g.key, g.name, g.count)), t('Aucun film chez ce fournisseur.'))}
        ${vodHelp}
      </div>
      <div class="stack" data-pane="series" hidden>
        <label class="check-label"><input type="checkbox" name="series"> ${t('Séries (une bibliothèque)')} <span class="faint small">${num(pv.series || 0)}</span></label>
        ${list(vodGroups.series.map((g) => pick('series', g.key, g.name, g.count)), t('Aucune série chez ce fournisseur.'))}
        ${vodHelp}
      </div>
      <label class="check-label"><input type="checkbox" name="newEnabled" checked> ${t('Activer les nouvelles chaînes et les nouveaux groupes trouvés aux prochaines mises à jour')}</label>
      ${state.role === 'admin' ? '' : `<div class="field"><label>${t('Lecture des chaînes')}</label><select name="mode">${modeOptions('direct')}</select></div>`}
    </div>`,
    onOk: (f) => {
      const off = (kind) => $$(`.iptv-group-pick input[data-kind="${kind}"]`, f).filter((b) => !b.checked).map((b) => b.value);
      const excluded = off('live').map((i) => groups[Number(i)].key);
      return api('POST', '/iptv', { token: pv.token, options: { live: f.live.checked, movies: f.movies.checked, series: f.series.checked, newEnabled: f.newEnabled.checked, excluded, excludedMovies: off('movie'), excludedSeries: off('series') }, mode: f.mode?.value });
    }
  });
  return r;
}

// Fenetre d'import : onglets, recherche et "tout inclure / exclure" sur l'onglet affiche.
const visiblePane = (form) => $('[data-pane]:not([hidden])', form) || form;
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-imp-tab]');
  if (!tab) return;
  const form = tab.closest('form');
  $$('[data-imp-tab]', form).forEach((b) => b.classList.toggle('on', b === tab));
  $$('[data-pane]', form).forEach((p) => (p.hidden = p.dataset.pane !== tab.dataset.impTab));
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'grpSearch') return;
  const q = e.target.value.trim().toLowerCase();
  $$('.iptv-group-pick', e.target.closest('form')).forEach((l) => (l.hidden = q && !l.dataset.name.includes(q)));
});
document.addEventListener('click', (e) => {
  const all = e.target.id === 'grpAll';
  if (!all && e.target.id !== 'grpNone') return;
  $$('.iptv-group-pick:not([hidden]) input', visiblePane(e.target.closest('form'))).forEach((b) => (b.checked = all));
});

async function assignDialog(s, view) {
  const profiles = view.profiles || [];
  const r = await modal({
    title: t('Attribuer « {name} »', { name: s.name }),
    okLabel: t('Attribuer'),
    body: `<div class="stack">
      <div class="iptv-group-list">${profiles.map((p) => `<label class="check-label"><input type="checkbox" value="${p.id}" ${s.users.some((u) => u.profileId === p.id) ? 'checked disabled' : ''}> ${esc(p.name)}</label>`).join('')}</div>
      <div class="field"><label>${t('Lecture des chaînes')}</label><select name="mode">${modeOptions(view.defaultMode === 'warp' && view.external ? 'warp' : 'direct')}</select>
        ${view.external ? '' : `<span class="help">${t('Proxy externe : à configurer dans Réglages → Lecture et réseau.')}</span>`}</div>
    </div>`,
    onOk: (f) => {
      const ids = $$('input[type=checkbox]:not(:disabled)', f).filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) throw new Error(t('Sélectionne au moins un profil.'));
      return api('POST', `/iptv/${s.id}/assign`, { profiles: ids, mode: f.mode.value });
    }
  });
  if (r) toast(t('{n} profil(s) mis à jour.', { n: r.applied }));
  return r;
}

function bindSourceList(root, view, rerender) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-refresh],[data-assign],[data-remove]');
    if (!b) return;
    const s = view.sources.find((x) => x.id === (b.dataset.refresh || b.dataset.assign || b.dataset.remove));
    if (!s) return;
    if (b.dataset.refresh) rerender(await busy(b, () => api('POST', `/iptv/${s.id}/refresh`), t('Liste téléchargée')));
    else if (b.dataset.assign) rerender(await assignDialog(s, view));
    else if (await confirmDialog(t('Retirer « {name} » ?', { name: s.name }), t('Ses chaînes, groupes et modifications disparaissent de tous les profils.'), t('Retirer'), true)) {
      rerender(await busy(null, () => api('DELETE', `/iptv/${s.id}`), t('Source retirée')));
    }
  });
}

// ---- Page "TV en direct" (admin) ----------------------------------------------------------

async function renderSources(main, view = null) {
  view = view || (await api('GET', '/iptv'));
  const rerender = (next) => next && renderSources(main, next.sources ? next : null);
  const server = view.sources.filter((s) => !s.private);
  const priv = view.sources.filter((s) => s.private);
  main.innerHTML = `${head(t('TV en direct'), t('Comptes Xtream Codes et listes M3U : leurs chaînes deviennent la TV en direct des apps Jellyfin, leurs films et séries des bibliothèques.'), `<button class="btn primary" id="iptvAdd">${icon('plus')}${t('Ajouter une source')}</button>`)}
    <div class="card"><div class="setting" style="border:0;padding:0"><div class="text"><b>${t('Mise à jour des listes et des guides')}</b><span>${t('Toutes les combien d’heures les listes, les guides et la VOD sont téléchargés à nouveau (1 à 168).')}</span></div>
      <div class="control"><div class="row"><input id="iptvHours" type="number" min="1" max="168" step="1" value="${view.refreshHours}" style="width:90px"><span class="muted">h</span></div></div></div></div>
    <div class="stack" id="iptvList">
      ${server.length ? server.map((s) => sourceCard(s, true)).join('') : `<div class="card empty">${icon('tv')}<p>${t('Aucune source IPTV. Ajoute un compte Xtream ou une liste M3U.')}</p></div>`}
      ${priv.length ? `<h2 style="margin-top:12px">${t('Sources privées des utilisateurs')}</h2><p class="small muted">${t('Ajoutées par les utilisateurs eux-mêmes : chacune ne sert qu’à son profil.')}</p>${priv.map((s) => sourceCard(s, true)).join('')}` : ''}
    </div>`;
  $('#iptvAdd').onclick = async () => {
    const r = await addSourceDialog(view);
    if (r) {
      toast(t('Source ajoutée'));
      go(`${baseHash()}/${r.added}`);
    }
  };
  bindSourceList($('#iptvList'), view, rerender);
  $('#iptvHours').onchange = async (e) => {
    const r = await busy(null, () => api('PUT', '/settings', { iptvRefreshHours: Number(e.target.value) }), t('Enregistré'));
    if (r) state.settings = r;
  };
}

// ---- Page d'une source ----------------------------------------------------------------------

const SECTIONS = [
  ['summary', 'Résumé'],
  ['groups', 'Groupes'],
  ['channels', 'Chaînes'],
  ['guides', 'Guides']
];

async function sourcePage(main, id, section = 'summary', back = '') {
  const view = await api('GET', '/iptv');
  const s = view.sources.find((x) => x.id === id);
  if (!s) {
    main.innerHTML = `<div class="card empty">${icon('alert')}<p>${t('Source introuvable')}</p></div>`;
    return;
  }
  const base = `${baseHash()}/${s.id}`;
  main.innerHTML = `<div class="row" style="margin-bottom:14px"><a class="btn ghost sm" href="${back || baseHash()}">${t('← TV en direct')}</a></div>
    ${head(`${esc(s.name)} <span class="badge neutral">${esc(kindLabel(s.kind))}</span>`, `${esc(s.host)}${s.username ? ' · ' + esc(s.username) : ''}`, `<button class="btn" id="srcRefresh">${icon('refresh')}${t('Télécharger à nouveau')}</button><button class="btn" id="srcEdit">${t('Modifier le compte')}</button>`)}
    <nav class="tabs">${SECTIONS.map(([k, l]) => `<a class="tab ${k === section ? 'active' : ''}" href="${base}/${k}">${esc(t(l))}</a>`).join('')}</nav>
    <div id="srcBody"></div>`;
  $('#srcRefresh').onclick = async (e) => (await busy(e.currentTarget, () => api('POST', `/iptv/${s.id}/refresh`), t('Liste téléchargée'))) && render();
  $('#srcEdit').onclick = async () => (await editAccount(s)) && render();
  const body = $('#srcBody');
  if (section === 'groups') return groupsSection(body, s);
  if (section === 'channels') return channelsSection(body, s);
  if (section === 'guides') return guidesSection(body, s);
  return summarySection(body, s, view);
}

async function editAccount(s) {
  return modal({
    title: t('Modifier le compte'),
    okLabel: t('Enregistrer'),
    body: `<div class="stack">
      <div class="field"><label>${t('Nom')}</label><input name="name" maxlength="80" value="${esc(s.name)}" required></div>
      ${s.kind === 'xtream'
        ? `<div class="field"><label>${t('Adresse du serveur')}</label><input name="server" placeholder="${esc(s.host)}"><span class="help">${t('Laisse vide pour garder l’adresse actuelle ({host}).', { host: esc(s.host) })}</span></div>
          <div class="row" style="gap:12px"><div class="field grow"><label>${t('Identifiant')}</label><input name="username" value="${esc(s.username || '')}" autocomplete="off"></div>
          <div class="field grow"><label>${t('Mot de passe')}</label><input name="password" type="password" autocomplete="new-password" placeholder="${esc(t('Inchangé'))}"></div></div>`
        : `<div class="field"><label>${t('Adresse de la liste M3U')}</label><input name="url" placeholder="${esc(s.host)}"><span class="help">${t('Laisse vide pour garder l’adresse actuelle ({host}).', { host: esc(s.host) })}</span></div>`}
      <div class="field"><label>${t('User agent (optionnel)')}</label><input name="userAgent" value="${esc(s.userAgent || '')}"></div>
      <div class="field"><label>${t('Téléchargement des listes')}</label><select name="network"><option value="direct" ${s.network !== 'warp' ? 'selected' : ''}>${t('Par l’IP du serveur')}</option><option value="warp" ${s.network === 'warp' ? 'selected' : ''}>${t('Par le proxy externe')}</option></select></div>
    </div>`,
    onOk: (f) => {
      const b = { name: f.name.value.trim(), userAgent: f.userAgent.value.trim(), network: f.network.value };
      if (s.kind === 'xtream') {
        if (f.server.value.trim()) b.server = f.server.value.trim();
        b.username = f.username.value.trim();
        if (f.password.value) b.password = f.password.value;
      } else if (f.url.value.trim()) b.url = f.url.value.trim();
      return api('PATCH', `/iptv/${s.id}`, b);
    }
  });
}

function summarySection(el, s, view) {
  const a = s.account;
  el.innerHTML = `${s.error ? `<div class="card" style="border-color:var(--bad)"><p>${icon('alert')} ${esc(t('Dernier téléchargement impossible : {e}', { e: t(s.error) }))}</p><p class="small muted">${t('Les chaînes déjà connues restent.')}</p></div>` : ''}
    <div class="grid-2">
      <div class="card"><h2>${t('Chaînes')}</h2>
        <p class="big-number">${num(s.counts.shown)} <span class="muted small">/ ${num(s.counts.channels)}</span></p>
        <p class="small muted">${t('affichées dans les apps (chaînes activées des groupes activés)')}</p>
        ${s.counts.archive ? `<p class="small">${t('{n} chaîne(s) gardent leurs programmes passés (replay).', { n: num(s.counts.archive) })}</p>` : ''}
        <p class="small"><a href="${baseHash()}/${s.id}/guides">${esc(t('{n} chaîne(s) associée(s) au guide sur {total}', { n: num(s.counts.mapped || 0), total: num(s.counts.channels) }))}</a></p>
        <p class="small muted">${t('Dernier téléchargement : {a} · prochain : {b}', { a: ago(s.lastRefresh), b: s.nextRefresh ? fmtDate(s.nextRefresh) : '—' })}</p></div>
      <div class="card"><h2>${t('Compte')}</h2>
        ${a ? `<p>${esc(t('État : {s}', { s: a.status }))}</p>
          ${a.expires ? `<p>${esc(t('Expire le {date}', { date: dateOnly(a.expires) }))}</p>` : `<p>${t('Sans date d’expiration')}</p>`}
          <p>${a.maxConnections ? esc(t('{n} connexion(s) simultanée(s) : Stremfin n’en ouvre jamais plus.', { n: a.maxConnections })) : t('Pas de limite de connexions annoncée')}</p>
          <p class="small muted">${esc(t('Formats : {f}', { f: (a.formats || []).join(', ') || '—' }))}</p>`
        : `<p class="muted">${t('Liste M3U : pas de compte à afficher.')}</p>`}</div>
    </div>
    <div class="card"><h2>${t('Options')}</h2>
      <div class="setting"><div class="text"><b>${t('Chaînes en direct')}</b><span>${t('Les chaînes de la source dans « TV en direct ».')}</span></div>
        <div class="control">${toggle('data-opt="live"', s.options.live !== false)}</div></div>
      <div class="setting"><div class="text"><b>${t('Bibliothèque de films')}</b><span>${esc(t('{n} film(s) chez le fournisseur.', { n: num(s.vod?.movies || 0) }))}</span></div>
        <div class="control">${toggle('data-opt="movies"', !!s.options.movies)}</div></div>
      <div class="setting"><div class="text"><b>${t('Bibliothèque de séries')}</b><span>${esc(t('{n} série(s) chez le fournisseur.', { n: num(s.vod?.series || 0) }))}</span></div>
        <div class="control">${toggle('data-opt="series"', !!s.options.series)}</div></div>
      <div class="setting"><div class="text"><b>${t('Nouvelles chaînes activées')}</b><span>${t('Les chaînes et groupes trouvés aux prochaines mises à jour arrivent activés. Sinon, ils arrivent masqués.')}</span></div>
        <div class="control">${toggle('id="optNew"', s.options.newEnabled !== false)}</div></div>
    </div>
    ${state.role === 'admin' && !s.private ? `<div class="card"><h2>${t('Profils')}</h2>${s.users.length ? `<div class="list">${s.users.map((u) => `<div class="item"><div class="body"><div class="title">${esc(u.name)}</div><div class="meta"><span class="badge neutral">${esc(t((MODE_LABELS.find((m) => m[0] === u.mode) || MODE_LABELS[0])[1]))}</span>${u.enabled ? '' : `<span class="badge warn">${t('Désactivée')}</span>`}</div></div><div class="actions"><a class="btn sm" href="#/profiles/${u.profileId}/iptv">${t('Ouvrir')}</a></div></div>`).join('')}</div>` : `<p class="muted">${t('Aucun profil.')}</p>`}
      <button class="btn sm" id="srcAssign" style="margin-top:10px">${t('Attribuer à des profils')}</button></div>` : ''}`;
  $$('[data-opt]', el).forEach(
    (b) =>
      (b.onchange = async (e) => (await busy(null, () => api('PATCH', `/iptv/${s.id}`, { options: { [b.dataset.opt]: e.target.checked } }), t('Enregistré'))) || (e.target.checked = !e.target.checked))
  );
  $('#optNew').onchange = async (e) => (await busy(null, () => api('PATCH', `/iptv/${s.id}`, { options: { newEnabled: e.target.checked } }), t('Enregistré'))) || (e.target.checked = !e.target.checked);
  if ($('#srcAssign')) $('#srcAssign').onclick = async () => (await assignDialog(s, view)) && render();
}

// ---- Guides ---------------------------------------------------------------------------------

async function guidesSection(el, s) {
  const g = await api('GET', `/iptv/${s.id}/guides`);
  el.innerHTML = `<div class="card">
    <div class="card-head"><div><h2>${t('Guides des programmes')}</h2><p>${t('Dans l’ordre : pour chaque chaîne, le premier guide qui la connaît donne ses programmes. Association par identifiant (tvg-id), sinon par nom.')}</p></div>
      <div class="row"><button class="btn sm" id="guideRefresh">${icon('refresh')}${t('Télécharger les guides')}</button></div></div>
    <div class="setting"><div class="text"><b>${s.kind === 'xtream' ? t('Guide du fournisseur') : t('Guides annoncés par la liste (url-tvg)')}</b><span>${t('Le guide que le fournisseur publie pour ce compte ou cette liste.')}</span></div>
      <div class="control">${toggle('id="guideProvider"', g.useProviderGuide)}</div></div>
    ${g.guides.length ? `<div class="list" style="margin-top:12px">${g.guides.map((x) => `<div class="item">
      <div class="logo">${icon('clock')}</div>
      <div class="body"><div class="title">${esc(x.host)} ${x.provider ? `<span class="badge neutral">${t('Fournisseur')}</span>` : `<span class="badge accent">${t('Ajouté')}</span>`} ${x.running ? `<span class="badge warn">${t('Téléchargement…')}</span>` : ''}</div>
        <div class="meta"><span class="small muted">${t('{c} chaîne(s), {p} programme(s) gardé(s) · {when}', { c: num(x.channels), p: num(x.programs), when: ago(x.at) })}</span>${x.error ? `<span class="badge bad">${esc(t(x.error))}</span>` : ''}</div></div>
      <div class="actions">${x.provider ? '' : `<button class="btn ghost icon-only" data-guide-del="${esc(x.id)}" title="${esc(t('Retirer'))}">${icon('trash')}</button>`}</div></div>`).join('')}</div>`
      : `<div class="empty">${icon('clock')}<p>${t('Aucun guide. Ajoute l’adresse d’un guide XMLTV.')}</p></div>`}
    <form class="row" id="guideAdd" style="margin-top:14px;gap:8px"><input class="grow" name="url" type="url" style="width:auto" placeholder="https://…/guide.xml.gz" required><button class="btn primary" type="submit">${icon('plus')}${t('Ajouter un guide')}</button></form>
  </div>
  <div class="card"><h2>${t('Association')}</h2>
    <p>${esc(t('{n} chaîne(s) associée(s) au guide sur {total}', { n: num(g.counts.mapped), total: num(g.counts.channels) }))}</p>
    <p class="small muted">${t('Pour associer une chaîne à la main : onglet Chaînes, « Modifier », puis cherche-la dans les guides.')}</p>
    <a class="btn sm" href="${baseHash()}/${s.id}/channels?epg=without">${t('Voir les chaînes sans guide')}</a></div>`;
  const again = () => guidesSection(el, s);
  $('#guideRefresh').onclick = async (e) => (await busy(e.currentTarget, () => api('POST', `/iptv/${s.id}/guides/refresh`), t('Guides téléchargés'))) && again();
  $('#guideProvider').onchange = async (e) => {
    if (await busy(null, () => api('PATCH', `/iptv/${s.id}`, { useProviderGuide: e.target.checked }), t('Enregistré'))) setTimeout(again, 1500);
    else e.target.checked = !e.target.checked;
  };
  $('#guideAdd').onsubmit = async (e) => {
    e.preventDefault();
    if (await busy($('#guideAdd button'), () => api('POST', `/iptv/${s.id}/guides`, { url: e.target.url.value.trim() }), t('Guide ajouté, téléchargement en cours'))) setTimeout(again, 1500);
  };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-guide-del]');
    if (!b) return;
    if (await confirmDialog(t('Retirer ce guide ?'), t('Ses programmes ne seront plus affichés.'), t('Retirer'), true)) {
      if (await busy(null, () => api('POST', `/iptv/${s.id}/guides/remove`, { id: b.dataset.guideDel }), t('Guide retiré'))) again();
    }
  };
}

// ---- Groupes --------------------------------------------------------------------------------

async function groupsSection(el, s) {
  const kind = new URLSearchParams(location.hash.split('?')[1] || '').get('kind') || 'live';
  const [{ groups }, vodGroups] = await Promise.all([api('GET', `/iptv/${s.id}/groups`), api('GET', `/iptv/${s.id}/vodgroups`)]);
  const tabs = kindTabs(kind, { live: groups.length, movie: vodGroups.movie.length, series: vodGroups.series.length }, 'data-grp-tab');
  const go = (k) => (location.hash = `${baseHash()}/${s.id}/groups${k === 'live' ? '' : `?kind=${k}`}`);
  if (kind !== 'live') {
    vodGroupsSection(el, s, kind, vodGroups[kind] || [], tabs);
    $$('[data-grp-tab]', el).forEach((b) => (b.onclick = () => go(b.dataset.grpTab)));
    return;
  }
  el.innerHTML = `${tabs}<div class="card" style="margin-top:14px">
    <div class="card-head"><div><h2>${t('Groupes')}</h2><p>${t('Glisse pour réordonner. Un groupe désactivé masque toutes ses chaînes dans les apps. Un nom vide reprend celui du fournisseur.')}</p></div>
      <div class="row"><button class="btn sm" id="grpOn">${t('Tout activer')}</button><button class="btn sm" id="grpOff">${t('Tout désactiver')}</button><button class="btn sm primary" id="grpAdd">${icon('plus')}${t('Nouveau groupe')}</button></div></div>
    ${groups.length ? `<div class="list" id="grpList">${groups.map((g) => `<div class="item ${g.enabled ? '' : 'off'}" data-key="${esc(g.key)}">
      ${handleBtn(groups.length < 2)}
      <div class="body"><div class="title">${esc(g.name || t('Sans groupe'))} ${g.customName ? `<span class="faint small">(${esc(g.providerName || t('Sans groupe'))})</span>` : ''} ${g.added ? `<span class="badge accent">${t('Ajouté')}</span>` : ''}</div>
        <div class="meta"><span class="small muted">${t('{on} / {n} chaîne(s) activée(s)', { on: num(g.enabledChannels), n: num(g.channels) })}</span></div></div>
      <div class="actions">
        <a class="btn sm ghost" href="${baseHash()}/${s.id}/channels?group=${encodeURIComponent(g.key)}">${t('Chaînes')}</a>
        <button class="btn sm ghost" data-rename="${esc(g.key)}">${t('Renommer')}</button>
        ${g.added ? `<button class="btn ghost icon-only" data-del="${esc(g.key)}" title="${esc(t('Supprimer'))}">${icon('trash')}</button>` : ''}
        ${toggle(`data-enable="${esc(g.key)}" aria-label="${esc(t('Activer'))}"`, g.enabled)}
      </div></div>`).join('')}</div>` : `<div class="empty">${icon('layers')}<p>${t('Aucun groupe')}</p></div>`}
  </div>`;
  $$('[data-grp-tab]', el).forEach((b) => (b.onclick = () => go(b.dataset.grpTab)));
  const again = () => groupsSection(el, s);
  const list = $('#grpList');
  const all = async (enabled) => (await busy(null, () => api('PATCH', `/iptv/${s.id}/groups`, { keys: groups.map((g) => g.key), enabled }), t('Enregistré'))) && again();
  $('#grpOn').onclick = () => all(true);
  $('#grpOff').onclick = () => all(false);
  $('#grpAdd').onclick = async () => {
    const r = await modal({ title: t('Nouveau groupe'), lead: t('Tu pourras y déplacer des chaînes depuis l’onglet Chaînes. Il reste quand la liste change.'), okLabel: t('Créer'), body: `<div class="field"><label>${t('Nom')}</label><input name="name" maxlength="120" required></div>`, onOk: (f) => api('POST', `/iptv/${s.id}/groups`, { name: f.name.value }) });
    if (r) again();
  };
  if (!list) return;
  sortable(list, async (keys) => (await busy(null, () => api('PUT', `/iptv/${s.id}/groups/order`, { keys }), t('Ordre enregistré'))) && again());
  list.addEventListener('change', async (e) => {
    const k = e.target.dataset.enable;
    if (k === undefined) return;
    if (await busy(null, () => api('PATCH', `/iptv/${s.id}/groups`, { key: k, enabled: e.target.checked }), e.target.checked ? t('Groupe activé') : t('Groupe désactivé'))) e.target.closest('.item').classList.toggle('off', !e.target.checked);
    else e.target.checked = !e.target.checked;
  });
  list.addEventListener('click', async (e) => {
    const ren = e.target.closest('[data-rename]');
    const del = e.target.closest('[data-del]');
    if (ren) {
      const g = groups.find((x) => x.key === ren.dataset.rename);
      const r = await modal({ title: t('Renommer le groupe'), okLabel: t('Enregistrer'), body: `<div class="field"><label>${t('Nom')}</label><input name="name" maxlength="120" value="${esc(g.customName)}" placeholder="${esc(g.providerName || '')}"><span class="help">${t('Vide : le nom du fournisseur ({name}).', { name: esc(g.providerName || t('Sans groupe')) })}</span></div>`, onOk: (f) => api('PATCH', `/iptv/${s.id}/groups`, { key: g.key, name: f.name.value }) });
      if (r) again();
    } else if (del && (await confirmDialog(t('Supprimer ce groupe ?'), t('Ses chaînes retournent dans leur groupe d’origine.'), t('Supprimer'), true))) {
      if (await busy(null, () => api('POST', `/iptv/${s.id}/groups/remove`, { key: del.dataset.del }), t('Groupe supprimé'))) again();
    }
  });
}

/** Onglet Films ou Series de la page Groupes : categories du fournisseur, activees ou masquees. */
function vodGroupsSection(el, s, kind, cats, tabs) {
  const lib = kind === 'movie' ? s.options?.movies : s.options?.series;
  const draw = () => {
    el.innerHTML = `${tabs}<div class="card" style="margin-top:14px">
      <div class="card-head"><div><h2>${kind === 'movie' ? t('Catégories de films') : t('Catégories de séries')}</h2><p>${t('Une catégorie désactivée disparaît de la bibliothèque et de la recherche de secours. Elle reste désactivée aux prochaines mises à jour.')}</p></div>
        <div class="row"><button class="btn sm" id="vgOn">${t('Tout activer')}</button><button class="btn sm" id="vgOff">${t('Tout désactiver')}</button></div></div>
      ${lib ? '' : `<p class="small muted" style="margin-top:0">${t('La bibliothèque n’est pas affichée dans les apps (onglet Résumé) : ces catégories servent seulement à la recherche de secours.')}</p>`}
      ${cats.length ? `<input type="search" id="vgSearch" placeholder="${esc(t('Rechercher un groupe…'))}" style="margin-bottom:10px">
      <div class="list" id="vgList">${cats.map((c) => `<div class="item ${c.enabled ? '' : 'off'}" data-name="${esc(c.name.toLowerCase())}">
        <div class="body"><div class="title">${esc(c.name || t('Sans catégorie'))}</div>
          <div class="meta"><span class="small muted">${esc(kind === 'movie' ? t('{n} film(s)', { n: num(c.count) }) : t('{n} série(s)', { n: num(c.count) }))}</span></div></div>
        <div class="actions">${toggle(`data-vg="${esc(c.key)}" aria-label="${esc(t('Activer'))}"`, c.enabled)}</div></div>`).join('')}</div>` : `<div class="empty">${icon('film')}<p>${kind === 'movie' ? t('Aucun film chez ce fournisseur.') : t('Aucune série chez ce fournisseur.')}</p></div>`}
    </div>`;
  };
  draw();
  const send = (keys, enabled) => busy(null, () => api('PATCH', `/iptv/${s.id}/vodgroups`, { kind, keys, enabled }), enabled ? t('Groupe activé') : t('Groupe désactivé'));
  const bind = () => {
    $$('[data-grp-tab]', el).forEach((b) => (b.onclick = () => (location.hash = `${baseHash()}/${s.id}/groups${b.dataset.grpTab === 'live' ? '' : `?kind=${b.dataset.grpTab}`}`)));
    const all = async (enabled) => {
      const r = await send(cats.map((c) => c.key), enabled);
      if (r) {
        cats = r[kind];
        draw();
        bind();
      }
    };
    $('#vgOn').onclick = () => all(true);
    $('#vgOff').onclick = () => all(false);
    const search = $('#vgSearch');
    if (search) search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      $$('#vgList .item').forEach((i) => (i.hidden = q && !i.dataset.name.includes(q)));
    };
    const list = $('#vgList');
    if (list) list.onchange = async (e) => {
      const k = e.target.dataset.vg;
      if (k === undefined) return;
      if (await send([k], e.target.checked)) {
        e.target.closest('.item').classList.toggle('off', !e.target.checked);
        const c = cats.find((x) => x.key === k);
        if (c) c.enabled = e.target.checked;
      } else e.target.checked = !e.target.checked;
    };
  };
  bind();
}

// ---- Chaines --------------------------------------------------------------------------------

const PAGE = 100;

async function channelsSection(el, s) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = { group: params.get('group') || '', state: params.get('state') || '', search: params.get('search') || '', epg: params.get('epg') || '', archive: params.get('archive') === 'true', start: Number(params.get('start')) || 0 };
  const [{ groups }, page] = await Promise.all([api('GET', `/iptv/${s.id}/groups`), api('GET', `/iptv/${s.id}/channels?${new URLSearchParams({ group: f.group, state: f.state, search: f.search, epg: f.epg, archive: f.archive, start: f.start, limit: f.group && !f.search && !f.state && !f.epg ? 500 : PAGE })}`)]);
  // Ordre a la main : dans un groupe, sans recherche ni filtre d'etat.
  const reorder = !!f.group && !f.search && !f.state && !f.epg && !f.archive && page.total <= 500;
  const groupName = (k) => groups.find((g) => g.key === k)?.name || t('Sans groupe');
  el.innerHTML = `<div class="card">
    <form class="row iptv-filters" id="chFilters" style="gap:8px;flex-wrap:wrap">
      <input type="search" name="search" value="${esc(f.search)}" placeholder="${esc(t('Rechercher une chaîne…'))}" class="grow" style="width:auto;min-width:180px">
      <select name="group" style="width:auto"><option value="">${t('Tous les groupes')}</option>${groups.map((g) => `<option value="${esc(g.key)}" ${g.key === f.group ? 'selected' : ''}>${esc(g.name || t('Sans groupe'))} (${num(g.channels)})</option>`).join('')}</select>
      <select name="state" style="width:auto"><option value="">${t('Tous les états')}</option><option value="on" ${f.state === 'on' ? 'selected' : ''}>${t('Affichées')}</option><option value="off" ${f.state === 'off' ? 'selected' : ''}>${t('Désactivées')}</option><option value="hidden" ${f.state === 'hidden' ? 'selected' : ''}>${t('Masquées par leur groupe')}</option></select>
      <select name="epg" style="width:auto"><option value="">${t('Guide : toutes')}</option><option value="with" ${f.epg === 'with' ? 'selected' : ''}>${t('Avec guide')}</option><option value="without" ${f.epg === 'without' ? 'selected' : ''}>${t('Sans guide')}</option></select>
      <label class="check-label"><input type="checkbox" name="archive" ${f.archive ? 'checked' : ''}> ${t('Replay')}</label>
      <button class="btn sm" type="submit">${t('Filtrer')}</button>
    </form>
    <div class="row iptv-bulk" style="gap:8px;margin:12px 0;flex-wrap:wrap">
      <label class="check-label"><input type="checkbox" id="chAll"> ${t('Tout cocher')}</label>
      <span class="small muted" id="chSel"></span>
      <button class="btn sm" data-bulk="on">${t('Activer')}</button><button class="btn sm" data-bulk="off">${t('Désactiver')}</button><button class="btn sm" data-bulk="move">${t('Déplacer vers…')}</button>
      <span class="grow"></span><button class="btn sm ghost" id="chKeyword">${t('Modifier par mot-clé…')}</button>
    </div>
    <p class="small muted">${t('{n} chaîne(s)', { n: num(page.total) })}${reorder ? ' · ' + t('glisse pour réordonner') : f.group ? '' : ' · ' + t('choisis un groupe pour réordonner ses chaînes')}</p>
    ${page.items.length ? `<div class="list" id="chList">${page.items.map((c) => `<div class="item ${c.enabled && c.groupEnabled ? '' : 'off'}" data-key="${esc(c.key)}">
      ${reorder ? handleBtn(page.items.length < 2) : ''}
      <input type="checkbox" class="ch-pick" value="${esc(c.key)}" aria-label="${esc(t('Sélectionner'))}">
      <div class="logo">${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : icon('tv')}</div>
      <div class="body"><div class="title">${c.number ? `<span class="faint">${esc(c.number)}</span> ` : ''}${esc(c.name)} ${c.custom.name ? `<span class="faint small">(${esc(c.providerName)})</span>` : ''}</div>
        <div class="meta"><span class="badge neutral">${esc(groupName(c.group))}</span>${c.archiveDays ? `<span class="badge accent">${esc(t('Replay {n} j', { n: c.archiveDays }))}</span>` : ''}${c.groupEnabled ? '' : `<span class="badge warn">${t('Groupe masqué')}</span>`}${c.guide ? `<span class="small faint" title="${esc(t('Chaîne du guide'))}">${icon('clock')} ${esc(c.guide.id)}${c.guide.now ? ' · ' + esc(c.guide.now) : ''}</span>` : `<span class="badge neutral">${t('Sans guide')}</span>`}</div></div>
      <div class="actions"><button class="btn sm ghost" data-edit="${esc(c.key)}">${t('Modifier')}</button>${toggle(`data-enable="${esc(c.key)}" aria-label="${esc(t('Activer'))}"`, c.enabled)}</div></div>`).join('')}</div>` : `<div class="empty">${icon('tv')}<p>${t('Aucune chaîne')}</p></div>`}
    ${!reorder && page.total > PAGE ? `<div class="row" style="justify-content:center;gap:8px;margin-top:12px">
      <button class="btn sm" id="chPrev" ${f.start ? '' : 'disabled'}>${t('← Précédentes')}</button><span class="small muted">${t('{a}–{b} sur {n}', { a: num(f.start + 1), b: num(Math.min(f.start + PAGE, page.total)), n: num(page.total) })}</span>
      <button class="btn sm" id="chNext" ${f.start + PAGE < page.total ? '' : 'disabled'}>${t('Suivantes →')}</button></div>` : ''}
  </div>`;
  const base = `${baseHash()}/${s.id}/channels`;
  const nav = (patch) => {
    const q = new URLSearchParams({ ...f, ...patch });
    for (const [k, v] of [...q]) if (!v || v === 'false' || (k === 'start' && v === '0')) q.delete(k);
    go(`${base}${q.toString() ? '?' + q : ''}`);
  };
  $('#chFilters').onsubmit = (e) => {
    e.preventDefault();
    const x = e.target;
    nav({ search: x.search.value.trim(), group: x.group.value, state: x.state.value, epg: x.epg.value, archive: x.archive.checked, start: 0 });
  };
  if ($('#chPrev')) $('#chPrev').onclick = () => nav({ start: Math.max(0, f.start - PAGE) });
  if ($('#chNext')) $('#chNext').onclick = () => nav({ start: f.start + PAGE });
  const again = () => channelsSection(el, s);
  const picked = () => $$('.ch-pick', el).filter((b) => b.checked).map((b) => b.value);
  const showSel = () => ($('#chSel').textContent = picked().length ? t('{n} sélectionnée(s)', { n: picked().length }) : '');
  el.addEventListener('change', (e) => e.target.classList?.contains('ch-pick') && showSel());
  $('#chAll').onchange = (e) => {
    $$('.ch-pick', el).forEach((b) => (b.checked = e.target.checked));
    showSel();
  };
  const update = (keys, patch, msg) => busy(null, () => api('POST', `/iptv/${s.id}/channels/update`, { keys, patch }), msg);
  $$('[data-bulk]', el).forEach(
    (b) =>
      (b.onclick = async () => {
        const keys = picked();
        if (!keys.length) return toast(t('Coche au moins une chaîne.'), true);
        if (b.dataset.bulk === 'move') {
          const g = await pickGroup(groups);
          if (g && (await update(keys, { group: g }, t('{n} chaîne(s) déplacée(s)', { n: keys.length })))) again();
          return;
        }
        if (await update(keys, { enabled: b.dataset.bulk === 'on' }, t('{n} chaîne(s) modifiée(s)', { n: keys.length }))) again();
      })
  );
  $('#chKeyword').onclick = async () => (await keywordDialog(s, groups, f)) && again();
  const list = $('#chList');
  if (!list) return;
  if (reorder) sortable(list, async (keys) => (await busy(null, () => api('PUT', `/iptv/${s.id}/channels/order`, { keys }), t('Ordre enregistré'))) && again());
  list.addEventListener('change', async (e) => {
    const k = e.target.dataset.enable;
    if (k === undefined) return;
    if (await update([k], { enabled: e.target.checked }, e.target.checked ? t('Chaîne activée') : t('Chaîne désactivée'))) e.target.closest('.item').classList.toggle('off', !e.target.checked);
    else e.target.checked = !e.target.checked;
  });
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-edit]');
    if (!b) return;
    const c = page.items.find((x) => x.key === b.dataset.edit);
    if (await editChannel(s, c, groups)) again();
  });
}

function pickGroup(groups) {
  return modal({
    title: t('Déplacer vers un groupe'),
    okLabel: t('Déplacer'),
    body: `<div class="field"><label>${t('Groupe')}</label><select name="group">${groups.map((g) => `<option value="${esc(g.key)}">${esc(g.name || t('Sans groupe'))}</option>`).join('')}</select></div>`,
    onOk: (f) => f.group.value
  });
}

// Recherche d'une chaine dans les guides (fenetre de modification d'une chaine).
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'epgFindBtn') return;
  const form = e.target.closest('form');
  const box = $('#epgResults', form);
  const sid = form.dataset.source;
  const r = await busy(e.target, () => api('GET', `/iptv/${sid}/guides/search?q=${encodeURIComponent($('#epgFind', form).value.trim())}`));
  if (!r) return;
  box.hidden = false;
  box.innerHTML = r.items.length
    ? r.items.map((x) => `<button type="button" class="check-label epg-pick" data-id="${esc(x.id)}" style="text-align:left;background:none;border:0;color:inherit"><b>${esc(x.names[0] || x.id)}</b><span class="small faint">${esc(x.id)}${x.now ? ' · ' + esc(x.now) : ''}</span></button>`).join('')
    : `<p class="small muted">${t('Aucune chaîne trouvée dans les guides.')}</p>`;
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('.epg-pick');
  if (!b) return;
  const form = b.closest('form');
  form.epg.value = b.dataset.id;
  $('#epgResults', form).hidden = true;
});

function editChannel(s, c, groups) {
  setTimeout(() => {
    const form = [...document.querySelectorAll('.backdrop form')].pop();
    if (form) form.dataset.source = s.id;
  });
  const field = (name, label, value, provider, extra = '') =>
    `<div class="field"><label>${label}</label><input name="${name}" value="${esc(value)}" placeholder="${esc(provider || '')}" ${extra}><span class="help">${provider ? t('Vide : celui du fournisseur ({v}).', { v: esc(provider) }) : t('Vide : celui du fournisseur.')}</span></div>`;
  return modal({
    title: t('Modifier « {name} »', { name: c.name }),
    okLabel: t('Enregistrer'),
    wide: true,
    body: `<div class="stack">
      ${field('name', t('Nom'), c.custom.name, c.provider.name, 'maxlength="200"')}
      <div class="row" style="gap:12px"><div class="grow">${field('number', t('Numéro'), c.custom.number, c.provider.number, 'inputmode="decimal"')}</div>
        <div class="grow"><div class="field"><label>${t('Groupe')}</label><select name="group"><option value="">${esc(t('Celui du fournisseur ({g})', { g: groups.find((g) => g.key === c.provider.group)?.name || t('Sans groupe') }))}</option>${groups.map((g) => `<option value="${esc(g.key)}" ${g.key === c.custom.group ? 'selected' : ''}>${esc(g.name || t('Sans groupe'))}</option>`).join('')}</select></div></div></div>
      ${field('logo', t('Logo (adresse d’une image)'), c.custom.logo, c.provider.logo)}
      ${field('epg', t('Identifiant dans le guide (tvg-id)'), c.custom.epg, c.provider.epg)}
      <div class="row" style="gap:8px"><input type="search" id="epgFind" class="grow" style="width:auto" placeholder="${esc(t('Chercher une chaîne dans les guides…'))}"><button type="button" class="btn sm" id="epgFindBtn">${t('Chercher')}</button></div>
      <div class="iptv-group-list" id="epgResults" hidden></div>
      ${c.guide ? `<p class="small muted">${esc(t('Associée à {id}', { id: c.guide.id }))}${c.guide.now ? ' · ' + esc(t('en ce moment : {t}', { t: c.guide.now })) : ''}</p>` : `<p class="small muted">${t('Aucune chaîne du guide associée.')}</p>`}
    </div>`,
    onOk: (f) => api('POST', `/iptv/${s.id}/channels/update`, { keys: [c.key], patch: { name: f.name.value, number: f.number.value, group: f.group.value || null, logo: f.logo.value, epg: f.epg.value } })
  });
}

/** Modification en lot par mot-cle : le nombre de chaines touchees s'affiche avant. */
async function keywordDialog(s, groups, f) {
  return modal({
    title: t('Modifier par mot-clé'),
    lead: t('Toutes les chaînes dont le nom contient ce mot (dans le groupe choisi, ou partout).'),
    okLabel: t('Appliquer'),
    body: `<div class="stack">
      <div class="field"><label>${t('Mot-clé')}</label><input name="search" value="${esc(f.search)}" required></div>
      <div class="field"><label>${t('Groupe')}</label><select name="group"><option value="">${t('Tous les groupes')}</option>${groups.map((g) => `<option value="${esc(g.key)}" ${g.key === f.group ? 'selected' : ''}>${esc(g.name || t('Sans groupe'))}</option>`).join('')}</select></div>
      <div class="field"><label>${t('Action')}</label><select name="action"><option value="off">${t('Désactiver')}</option><option value="on">${t('Activer')}</option><option value="move">${t('Déplacer vers un groupe')}</option></select></div>
      <div class="field" data-move hidden><label>${t('Vers le groupe')}</label><select name="to">${groups.map((g) => `<option value="${esc(g.key)}">${esc(g.name || t('Sans groupe'))}</option>`).join('')}</select></div>
      <p class="small" id="kwCount"></p>
    </div>`,
    onOk: async (x) => {
      const match = { search: x.search.value.trim(), group: x.group.value || undefined };
      const patch = x.action.value === 'move' ? { group: x.to.value } : { enabled: x.action.value === 'on' };
      const { count } = await api('POST', `/iptv/${s.id}/channels/update`, { match, dryRun: true });
      if (!count) throw new Error(t('Aucune chaîne ne contient ce mot.'));
      const counter = $('#kwCount', x);
      if (counter.dataset.confirmed !== String(count) + JSON.stringify(match) + JSON.stringify(patch)) {
        counter.dataset.confirmed = String(count) + JSON.stringify(match) + JSON.stringify(patch);
        counter.textContent = t('{n} chaîne(s) seront modifiées. Valide à nouveau pour appliquer.', { n: num(count) });
        return false;
      }
      const r = await api('POST', `/iptv/${s.id}/channels/update`, { match, patch });
      toast(t('{n} chaîne(s) modifiée(s)', { n: num(r.count) }));
      return r;
    }
  });
}
document.addEventListener('change', (e) => {
  if (e.target.name !== 'action' || !e.target.closest('.modal')) return;
  const m = $('[data-move]', e.target.closest('form'));
  if (m) m.hidden = e.target.value !== 'move';
});

// ---- Onglet "TV en direct" d'un profil ----------------------------------------------------------

async function profileTab(el, p, sub = []) {
  // Page d'une source privee de l'utilisateur (#/me/iptv/<id>/<section>).
  if (p.self && sub[0]) return sourcePage(el, sub[0], (sub[1] || 'summary').split('?')[0], '#/me/iptv');
  const view = await api('GET', '/iptv');
  const fresh = await api('GET', `/profiles/${p.id}`);
  const mine = p.self ? view.sources.filter((s) => s.private && s.mine) : [];
  el.innerHTML = `<div class="card">
    <div class="card-head"><div><h2>${t('TV en direct')}</h2><p>${t('Les chaînes des sources actives apparaissent dans « TV en direct » des apps Jellyfin, dans cet ordre.')}</p></div>
      <div class="row">${p.self ? `<button class="btn sm primary" id="iptvAddMine">${icon('plus')}${t('Ajouter ma source')}</button>` : `<a class="btn sm" href="#/iptv">${t('Gérer les sources')}</a>`}</div></div>
    ${fresh.iptv.length ? `<div class="list" id="iptvProfileList">${fresh.iptv.map((a) => `<div class="item ${a.enabled ? '' : 'off'}" data-key="${esc(a.id)}">
      ${handleBtn(fresh.iptv.length < 2)}
      <div class="logo">${icon('tv')}</div>
      <div class="body"><div class="title">${esc(a.name)} <span class="badge neutral">${esc(kindLabel(a.kind))}</span>${a.private ? ` <span class="badge accent">${t('Privée')}</span>` : ''}</div>
        <div class="meta"><span class="small muted">${t('{n} chaîne(s)', { n: num(a.channels) })}</span></div></div>
      <div class="actions">
        <select data-mode="${esc(a.id)}" style="width:auto" title="${esc(t('Lecture des chaînes'))}">${modeOptions(a.mode)}</select>
        ${a.private && p.self ? `<a class="btn sm ghost" href="#/me/iptv/${a.id}">${t('Gérer')}</a>` : ''}
        ${toggle(`data-enable="${esc(a.id)}" aria-label="${esc(t('Activer'))}"`, a.enabled)}
        <button class="btn ghost icon-only" data-remove="${esc(a.id)}" title="${esc(a.private ? t('Supprimer la source') : t('Retirer du profil'))}">${icon('trash')}</button>
      </div></div>`).join('')}</div>`
      : `<div class="empty">${icon('tv')}<p>${p.self ? t('Aucune source. Ajoute ton compte Xtream ou ta liste M3U.') : t('Aucune source sur ce profil. Attribue-en une depuis la page TV en direct.')}</p></div>`}
  </div>`;
  const again = () => profileTab(el, p, []);
  if ($('#iptvAddMine')) $('#iptvAddMine').onclick = async () => {
    const r = await addSourceDialog(view);
    if (r) {
      toast(t('Source ajoutée'));
      go(`#/me/iptv/${r.added}`);
    }
  };
  const list = $('#iptvProfileList');
  if (!list) return;
  sortable(list, async (ids) => (await busy(null, () => api('PUT', `/profiles/${p.id}/iptv/order`, { ids }), t('Ordre enregistré'))) && again());
  list.addEventListener('change', async (e) => {
    const en = e.target.dataset.enable;
    const md = e.target.dataset.mode;
    if (en) {
      if (await busy(null, () => api('PATCH', `/profiles/${p.id}/iptv/${en}`, { enabled: e.target.checked }), e.target.checked ? t('Source activée') : t('Source désactivée'))) e.target.closest('.item').classList.toggle('off', !e.target.checked);
      else e.target.checked = !e.target.checked;
    } else if (md) {
      await busy(null, () => api('PATCH', `/profiles/${p.id}/iptv/${md}`, { mode: e.target.value }), t('Enregistré'));
    }
  });
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const a = fresh.iptv.find((x) => x.id === b.dataset.remove);
    if (a.private && p.self) {
      if (await confirmDialog(t('Supprimer « {name} » ?', { name: a.name }), t('Ses chaînes, groupes et modifications sont supprimés.'), t('Supprimer'), true)) {
        if (await busy(null, () => api('DELETE', `/iptv/${a.id}`), t('Source supprimée'))) again();
      }
    } else if (await confirmDialog(t('Retirer « {name} » du profil ?', { name: a.name }), t('La source reste sur le serveur.'), t('Retirer'), true)) {
      if (await busy(null, () => api('PATCH', `/profiles/${p.id}/iptv/${a.id}`, { remove: true }), t('Source retirée du profil'))) again();
    }
  });
}

// ---- Page "Enregistrements" (admin) -----------------------------------------------------------

const REC_STATUS = { scheduled: ['Programmé', 'neutral'], recording: ['En cours', 'warn'], done: ['Terminé', 'ok'], failed: ['Échoué', 'bad'], cancelled: ['Annulé', 'neutral'] };

async function renderRecordings(main) {
  const r = await api('GET', '/recordings');
  const s = r.settings;
  const active = (x) => x.status === 'scheduled' || x.status === 'recording';
  const row = (x) => `<div class="item" data-key="${esc(x.id)}">
    <div class="logo">${icon('film')}</div>
    <div class="body"><div class="title">${esc(x.name)}${x.episode ? ` <span class="faint small">${esc(x.episode)}</span>` : ''} <span class="badge ${REC_STATUS[x.status]?.[1] || 'neutral'}">${esc(t(REC_STATUS[x.status]?.[0] || x.status))}</span>${x.series ? ` <span class="badge accent">${t('Série')}</span>` : ''}</div>
      <div class="meta"><span class="small muted">${esc(x.channel)} · ${esc(fmtDate(x.start))} → ${esc(new Date(x.stop).toLocaleTimeString(UI.locale, { timeStyle: 'short' }))} · ${esc(x.profile)}${x.size ? ' · ' + esc(fmtSize(x.size)) : ''}</span>${x.error ? `<span class="badge bad">${esc(t(x.error))}</span>` : ''}</div></div>
    <div class="actions"><button class="btn ghost icon-only" data-del="${esc(x.id)}" data-active="${active(x) ? '1' : ''}" data-status="${x.status}" title="${esc(active(x) ? t('Annuler') : t('Supprimer'))}">${icon(active(x) ? 'x' : 'trash')}</button></div></div>`;
  const upcoming = r.timers.filter(active).sort((a, b) => a.start - b.start);
  const done = r.timers.filter((x) => !active(x));
  main.innerHTML = `<div id="recPage">${head(t('Enregistrements'), t('Programmés depuis le guide des apps Jellyfin (bouton Enregistrer). FFmpeg copie la chaîne sans la convertir.'))}
    <div class="card"><h2>${t('Réglages')}</h2><form id="recForm">
      <div class="setting"><div class="text"><b>${t('Dossier')}</b><span>${esc(t('Vide : {f}', { f: r.folder }))} · ${esc(t('{s} utilisés', { s: r.used ? fmtSize(r.used) : '0' }))}</span></div><div class="control wide"><input name="path" value="${esc(s.recordingsPath)}" placeholder="${esc(r.folder)}"></div></div>
      <div class="setting"><div class="text"><b>${t('Marges')}</b><span>${t('Minutes enregistrées avant le début et après la fin prévus.')}</span></div><div class="control"><div class="row"><input name="pre" type="number" min="0" max="60" value="${s.recordingPrePadding}" style="width:80px"><input name="post" type="number" min="0" max="120" value="${s.recordingPostPadding}" style="width:80px"><span class="muted">min</span></div></div></div>
      <div class="setting"><div class="text"><b>${t('Enregistrements simultanés')}</b><span>${t('Chacun prend une connexion du compte IPTV (sauf si quelqu’un regarde déjà la chaîne).')}</span></div><div class="control"><input name="max" type="number" min="1" max="10" value="${s.recordingMaxConcurrent}" style="width:80px"></div></div>
      <div class="row end"><button class="btn primary" type="submit">${t('Enregistrer')}</button></div></form></div>
    <div class="card"><h2>${t('À venir et en cours')}</h2>${upcoming.length ? `<div class="list">${upcoming.map(row).join('')}</div>` : `<p class="muted">${t('Aucun enregistrement programmé.')}</p>`}</div>
    ${r.series.length ? `<div class="card"><h2>${t('Séries')}</h2><div class="list">${r.series.map((x) => `<div class="item"><div class="body"><div class="title">${esc(x.title)}</div><div class="meta"><span class="small muted">${esc(x.channel || t('Toutes les chaînes'))} · ${esc(x.profile)}</span></div></div><div class="actions"><button class="btn ghost icon-only" data-series="${esc(x.id)}" title="${esc(t('Supprimer'))}">${icon('trash')}</button></div></div>`).join('')}</div></div>` : ''}
    <div class="card"><h2>${t('Terminés')}</h2>${done.length ? `<div class="list">${done.map(row).join('')}</div>` : `<p class="muted">${t('Aucun enregistrement.')}</p>`}</div></div>`;
  const again = () => renderRecordings(main);
  $('#recForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const res = await busy($('button[type=submit]', f), () => api('PUT', '/settings', { recordingsPath: f.path.value.trim(), recordingPrePadding: Number(f.pre.value), recordingPostPadding: Number(f.post.value), recordingMaxConcurrent: Number(f.max.value) }), t('Enregistré'));
    if (res) state.settings = res;
  };
  $('#recPage').onclick = async (e) => {
    const b = e.target.closest('[data-del]');
    const sr = e.target.closest('[data-series]');
    if (b) {
      const cancel = !!b.dataset.active;
      const lead = cancel ? (b.dataset.status === 'recording' ? t('L’enregistrement s’arrête ; ce qui est déjà enregistré reste.') : '') : t('Le fichier est supprimé du serveur.');
      const ok = await confirmDialog(cancel ? t('Annuler cet enregistrement ?') : t('Supprimer cet enregistrement ?'), lead, cancel ? t('Annuler l’enregistrement') : t('Supprimer'), true);
      if (ok && (await busy(null, () => api('DELETE', `/recordings/${b.dataset.del}`), t('Fait')))) again();
    } else if (sr && (await confirmDialog(t('Supprimer cette série ?'), t('Ses prochaines diffusions ne seront plus enregistrées.'), t('Supprimer'), true))) {
      if (await busy(null, () => api('DELETE', `/recordings/series/${sr.dataset.series}`), t('Fait'))) again();
    }
  };
}
PAGES.recordings = (main) => renderRecordings(main);

PAGES.iptv = (main, parts) => (parts[1] ? sourcePage(main, parts[1], (parts[2] || 'summary').split('?')[0]) : renderSources(main));
window.StremfinIptv = { profileTab };
})();
