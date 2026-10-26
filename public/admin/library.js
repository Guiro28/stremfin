'use strict';
// Page Addons : bibliotheque d'addons reprise de Nuvio Manager (branche dev, renderLibrary et ses
// fenetres), adaptee aux profils de Stremfin. esc, $, $$, api, busy, modal, toast, hue, t : app.js.
(() => {
// Modes de connexion d'un addon sur un profil (memes libelles que Nuvio Manager).
const MODES = [
  ["none", "Sans proxy"],
  ["direct", "Proxy interne"],
  ["warp", "Proxy externe"],
];
const modeOptions = (selected) =>
  [
    ["none", "Sans proxy · URL d’origine"],
    ["direct", "Proxy · IP du serveur"],
    ["warp", "Proxy externe · WARP, SOCKS ou HTTP"],
  ]
    .map(([m, label]) => `<option value="${m}" ${m === selected ? "selected" : ""}>${esc(t(label))}</option>`)
    .join("");

// Avatar de profil au format de Nuvio Manager (image, sinon initiale sur fond colore).
function profileAvatar(profile) {
  const src = profile.avatarUrl || "";
  return `<span class="avatar" style="background:hsl(${hue(profile.name)} 55% 42%)"><span class="avatar-fallback">${esc(String(profile.name || "?").slice(0, 1).toUpperCase())}</span>${src ? `<img class="profile-avatar" src="${esc(src)}" alt="" decoding="async">` : ""}</span>`;
}

// Logo de l'addon (manifest), avec la premiere lettre a defaut.
function addonLogoHtml(addon, extraClass = "") {
  let source = "";
  try {
    const url = new URL(addon.logo);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) source = url.href;
  } catch {}
  return `<span class="addon-logo${extraClass ? " " + extraClass : ""}"><span>${esc((addon.name || "A").slice(0, 1).toUpperCase())}</span>${source ? `<img src="${esc(source)}" alt="${esc(t("Logo de {name}", { name: addon.name }))}" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}

const dropBrokenImages = (root) =>
  root.querySelectorAll(".addon-logo img, .profile-avatar").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));

/** Fenetre de Stremfin avec le contenu de Nuvio Manager ; renvoie aussi son element. */
function openDialog(opts) {
  const done = modal({ ...opts, body: `<div class="nm-lib">${opts.body}</div>` });
  const root = [...document.querySelectorAll(".backdrop")].pop();
  dropBrokenImages(root);
  return { done, root };
}

// Glisser-deposer natif d'une liste `.lib-pick` : l'ordre des cases cochees est l'ordre d'ajout.
function enableListReorder(listEl) {
  if (!listEl) return;
  let dragged = null;
  const afterElement = (y) => {
    const items = [...listEl.querySelectorAll(".lib-pick:not(.dragging)")];
    return items.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        return offset < 0 && offset > closest.offset ? { offset, element: child } : closest;
      },
      { offset: -Infinity, element: null },
    ).element;
  };
  listEl.querySelectorAll(".lib-pick").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      dragged = row;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      try { event.dataTransfer.setData("text/plain", ""); } catch {}
    });
    row.addEventListener("dragend", () => {
      if (dragged) dragged.classList.remove("dragging");
      dragged = null;
    });
  });
  listEl.addEventListener("dragover", (event) => {
    if (!dragged) return;
    event.preventDefault();
    const after = afterElement(event.clientY);
    if (after == null) listEl.appendChild(dragged);
    else listEl.insertBefore(dragged, after);
  });
}

const externalNote = (lib) =>
  lib.external ? "" : `<p class="muted">${esc(t("Proxy externe : à configurer dans Réglages → Lecture et réseau. Sans lui, ce mode passe par l’IP du serveur."))}</p>`;

const resultToast = (result) => {
  const failed = (result.results || []).filter((r) => !r.ok).length;
  toast(
    failed
      ? t("{n} profil(s) mis à jour, {f} échec(s).", { n: result.applied, f: failed })
      : t("{n} profil(s) mis à jour.", { n: result.applied }),
  );
};

// Liste a cocher des addons de la bibliotheque (reordonnable), pour un profil.
function addonChecklist(addons) {
  return addons
    .map(
      (a) =>
        `<label class="check-label lib-pick" draggable="true"><span class="lib-drag" aria-hidden="true">⠿</span><input type="checkbox" value="${esc(a.id)}">${addonLogoHtml(a, "addon-logo-sm")}<span class="lib-pick-name">${esc(a.name)}</span></label>`,
    )
    .join("");
}

function bindSelectAll(root, button, boxes) {
  button.onclick = () => {
    const all = boxes().every((b) => b.checked);
    boxes().forEach((b) => (b.checked = !all));
    button.textContent = all ? t("Tout sélectionner") : t("Tout désélectionner");
  };
}

async function renderLibrary(main, lib = null) {
  lib = lib || (await api("GET", "/library"));
  const rerender = (next) => next && renderLibrary(main, next);
  // Les avatars + le nombre de profils ouvrent la fenetre des modes par profil.
  const stack = (users) =>
    `<span class="lib-avatar-stack">${users.slice(0, 5).map((u) => profileAvatar(u)).join("")}${users.length > 5 ? `<span class="lib-avatar-more">+${users.length - 5}</span>` : ""}</span>`;
  const usageControl = (a, users) =>
    users.length
      ? `<button type="button" class="lib-usage btn sm" data-usage="${esc(a.id)}" title="${esc(t("Gérer les profils"))}">${stack(users)}<span class="badge neutral lib-count">${esc(users.length === 1 ? t("1 profil") : t("{n} profils", { n: users.length }))}</span></button>`
      : `<span class="badge neutral lib-count lib-count-empty">${esc(t("Aucun profil"))}</span>`;
  const card = (a) =>
    `<article class="addon library-addon"><div class="addon-top"><div class="library-addon-identity">${addonLogoHtml(a)}<div class="library-addon-copy"><div class="addon-name">${esc(a.name)} ${a.version ? `<span class="faint small">v${esc(a.version)}</span>` : ""} ${a.ok ? "" : `<span class="badge bad">${esc(t("Injoignable"))}</span>`}</div><p class="url" title="${esc(a.url)}">${esc(a.url)}</p></div></div><div class="lib-row-right">${usageControl(a, a.users)}<div class="actions"><button class="btn sm" data-edit="${a.id}">${esc(t("Modifier"))}</button><button data-assign="${a.id}" class="btn sm primary">${esc(t("Attribuer à un profil"))}</button><button class="btn sm" data-assign-many="${a.id}">${esc(t("À plusieurs profils"))}</button><button data-delete="${a.id}" class="btn sm ghost">${esc(t("Retirer"))}</button></div></div></div></article>`;

  main.innerHTML =
    head(
      t("Addons"),
      t("Chaque addon montre les profils qui l’utilisent. Changez le mode de proxy profil par profil."),
      `<div class="row">${lib.addons.length ? `<button class="btn" id="lib-refresh">${icon("refresh")}${esc(t("Recharger"))}</button><button class="btn" id="bulk-assign">${esc(t("Attribuer plusieurs addons"))}</button>` : ""}<button class="btn primary" id="new-addon">${icon("plus")}${esc(t("＋ Ajouter un addon").replace(/^＋\s*/, ""))}</button></div>`,
    ) +
    `<div class="nm-lib">${
      lib.addons.length
        ? `<div class="list" id="library-list">${lib.addons.map(card).join("")}</div>`
        : `<div class="empty"><div class="empty-symbol">⊞</div><h2>${esc(t("Votre catalogue commence ici."))}</h2><p class="muted">${esc(t("Ajoutez l’URL du manifest d’un addon. Son attribution aux profils reste manuelle."))}</p></div>`
    }</div>`;
  dropBrokenImages(main);

  $("#new-addon").onclick = async () => rerender(await addonForm());
  if ($("#bulk-assign")) $("#bulk-assign").onclick = async () => rerender(await bulkAssign(lib));
  if ($("#lib-refresh")) $("#lib-refresh").onclick = async (e) => rerender(await busy(e.currentTarget, () => api("POST", "/library/refresh"), t("Manifests rechargés")));
  const byId = (id) => lib.addons.find((a) => a.id === id);
  $$("[data-usage]", main).forEach((b) => (b.onclick = async () => rerender(await usageDialog(byId(b.dataset.usage), lib))));
  $$("[data-edit]", main).forEach((b) => (b.onclick = async () => rerender(await addonForm(byId(b.dataset.edit)))));
  $$("[data-assign]", main).forEach((b) => (b.onclick = async () => rerender(await assign(byId(b.dataset.assign), lib))));
  $$("[data-assign-many]", main).forEach((b) => (b.onclick = async () => rerender(await assignToProfiles(byId(b.dataset.assignMany), lib))));
  $$("[data-delete]", main).forEach(
    (b) =>
      (b.onclick = async () => {
        const a = byId(b.dataset.delete);
        const ok = await confirmDialog(
          t("Retirer « {name} » ?", { name: a.name }),
          a.users.length ? esc(t("Il sera aussi retiré des {n} profil(s) qui l’utilisent.", { n: a.users.length })) : "",
          t("Retirer"),
          true,
        );
        if (ok) rerender(await busy(null, () => api("DELETE", `/library/${a.id}`), t("Retiré de la bibliothèque.")));
      }),
  );
}

// Fenetre ouverte depuis le nombre de profils : modes par profil et retraits, appliques ensemble
// a l'enregistrement.
function usageDialog(addon, lib) {
  if (!addon) return null;
  const users = addon.users;
  const row = (u) =>
    `<div class="lib-profile" data-ref="${esc(u.profileId)}" data-original="${esc(u.mode)}" data-mode="${esc(u.mode)}">${profileAvatar(u)}<div class="lib-profile-meta"><span class="lib-profile-name">${esc(u.name)}</span><span class="muted">${u.enabled === false ? esc(t("désactivé")) : esc(t("actif"))}</span></div><div class="mode-toggle" role="group">${MODES.map(([m, label]) => `<button type="button" class="${u.mode === m ? "active" : ""}" data-set-mode="${m}">${esc(t(label))}</button>`).join("")}</div><button type="button" class="icon-btn" data-remove-toggle aria-label="${esc(t("Retirer de ce profil"))}" title="${esc(t("Retirer de ce profil"))}">✕</button></div>`;
  const { done, root } = openDialog({
    title: t("Profils utilisant « {name} »", { name: addon.name }),
    wide: true,
    body: `<div class="form lib-usage-list">${users.length ? users.map(row).join("") : `<p class="muted">${esc(t("Aucun profil n’utilise cet addon pour le moment."))}</p>`}</div>${users.length ? `<p class="muted">${esc(t("Modifiez le mode de chaque profil puis enregistrez."))}</p>` : ""}${externalNote(lib)}`,
    okLabel: users.length ? t("Enregistrer") : "",
    cancelLabel: t("Fermer"),
    onOk: async () => {
      const changes = [];
      root.querySelectorAll(".lib-profile").forEach((profileRow) => {
        const mode = profileRow.classList.contains("removing") ? "remove" : profileRow.dataset.mode;
        if (mode !== profileRow.dataset.original) changes.push({ profileId: profileRow.dataset.ref, mode });
      });
      if (!changes.length) {
        toast(t("Aucune modification à appliquer."));
        return false;
      }
      const result = await api("POST", `/library/${addon.id}/modes`, { changes });
      resultToast(result);
      return result;
    },
  });
  root.querySelectorAll("[data-set-mode]").forEach((b) => {
    b.onclick = () => {
      const toggle = b.closest(".mode-toggle");
      toggle.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      const profileRow = b.closest(".lib-profile");
      profileRow.dataset.mode = b.dataset.setMode;
      profileRow.classList.remove("removing");
      profileRow.querySelector("[data-remove-toggle]")?.classList.remove("active");
    };
  });
  root.querySelectorAll("[data-remove-toggle]").forEach((b) => {
    b.onclick = () => {
      const profileRow = b.closest(".lib-profile");
      b.classList.toggle("active", profileRow.classList.toggle("removing"));
    };
  });
  return done;
}

function addonForm(a = {}) {
  return openDialog({
    title: a.id ? t("Modifier un addon") : t("Ajouter un addon"),
    body: `<div class="form"><label>${esc(t("Nom"))}<input name="name" value="${esc(a.customName)}" placeholder="${esc(a.manifestName || t("Nom du manifest"))}"></label><label>${esc(t("URL du manifest"))}<input name="url" required value="${esc(a.url)}" placeholder="https://…/manifest.json"></label><p class="muted">${esc(a.id ? t("Les profils qui l’utilisent suivent ce nom et cette URL.") : t("Le catalogue conserve l’URL de configuration. Aucun profil n’est modifié à cette étape."))}</p></div>`,
    okLabel: t("Enregistrer"),
    onOk: (f) => {
      const body = { name: f.name.value, url: f.url.value };
      return a.id ? api("PATCH", `/library/${a.id}`, body) : api("POST", "/library", body);
    },
  }).done;
}

function profileOptions(lib) {
  return lib.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
}

function assign(addon, lib) {
  if (!addon) return null;
  return openDialog({
    title: t("Attribuer l’addon"),
    lead: esc(addon.name),
    body: `<div class="form"><label>${esc(t("Profil"))}<select name="profile">${profileOptions(lib)}</select></label><label>${esc(t("Mode de connexion"))}<select name="mode">${modeOptions(lib.defaultMode)}</select></label>${externalNote(lib)}</div>`,
    okLabel: t("Attribuer"),
    onOk: async (f) => {
      const result = await api("POST", `/library/${addon.id}/assign`, { profiles: [f.profile.value], mode: f.mode.value });
      resultToast(result);
      return result;
    },
  }).done;
}

// Plusieurs addons de la bibliotheque vers un profil, en une fois (meme mode).
// Les addons deja presents sur le profil voient leur mode mis a jour.
function bulkAssign(lib) {
  const { done, root } = openDialog({
    title: t("Attribuer plusieurs addons"),
    body: `<div class="form"><label>${esc(t("Profil"))}<select name="profile">${profileOptions(lib)}</select></label><label>${esc(t("Mode de connexion"))}<select name="mode">${modeOptions(lib.defaultMode)}</select></label><div class="lib-pick-head"><span class="muted">${esc(t("Addons à ajouter"))}</span><button type="button" id="bulk-all" class="btn sm ghost">${esc(t("Tout sélectionner"))}</button></div><div class="lib-picklist">${addonChecklist(lib.addons)}</div><p class="muted">${esc(t("Glissez les addons pour définir leur ordre d’ajout."))}</p><p class="muted">${esc(t("Les addons déjà présents sur ce profil verront leur mode mis à jour."))}</p>${externalNote(lib)}</div>`,
    okLabel: t("Attribuer"),
    wide: true,
    onOk: async (f) => {
      const ids = boxes().filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) {
        toast(t("Sélectionne au moins un addon."), true);
        return false;
      }
      const result = await api("POST", "/library/assign", { profileId: f.profile.value, ids, mode: f.mode.value });
      toast(t("{n} addon(s) attribué(s).", { n: result.applied }));
      return result;
    },
  });
  const boxes = () => [...root.querySelectorAll(".lib-picklist input[type=checkbox]")];
  enableListReorder(root.querySelector(".lib-picklist"));
  bindSelectAll(root, root.querySelector("#bulk-all"), boxes);
  return done;
}

// Un addon vers plusieurs profils, avec un meme mode. Les profils l'ayant deja voient leur mode mis a jour.
function assignToProfiles(addon, lib) {
  if (!addon) return null;
  const group = `<div class="assign-group">${lib.profiles.map((p) => `<label class="check-label lib-pick"><input type="checkbox" data-ref="${esc(p.id)}" ${addon.users.some((u) => u.profileId === p.id) ? "checked" : ""}>${profileAvatar(p)}<span class="lib-pick-name">${esc(p.name)}${p.disabled ? " · " + esc(t("désactivé")) : ""}</span></label>`).join("")}</div>`;
  const { done, root } = openDialog({
    title: t("Attribuer « {name} » à plusieurs profils", { name: addon.name }),
    body: `<div class="form"><label>${esc(t("Mode de connexion"))}<select name="mode">${modeOptions(lib.defaultMode)}</select></label><div class="lib-pick-head"><span class="muted">${esc(t("Profils cibles"))}</span><button type="button" id="multi-all" class="btn sm ghost">${esc(t("Tout sélectionner"))}</button></div><div class="lib-picklist">${group}</div><p class="muted">${esc(t("Les profils ayant déjà cet addon verront leur mode mis à jour."))}</p>${externalNote(lib)}</div>`,
    okLabel: t("Attribuer"),
    wide: true,
    onOk: async (f) => {
      const refs = boxes().filter((b) => b.checked).map((b) => b.dataset.ref);
      if (!refs.length) {
        toast(t("Sélectionne au moins un profil."), true);
        return false;
      }
      const result = await api("POST", `/library/${addon.id}/assign`, { profiles: refs, mode: f.mode.value });
      resultToast(result);
      return result;
    },
  });
  const boxes = () => [...root.querySelectorAll(".lib-picklist input[type=checkbox]")];
  bindSelectAll(root, root.querySelector("#multi-all"), boxes);
  return done;
}

/**
 * Onglet Addons d'un profil : ajout depuis la bibliotheque (admin), meme liste a cocher que
 * "Attribuer plusieurs addons". Renvoie le profil mis a jour.
 */
async function pickForProfile(p) {
  const lib = await api("GET", "/library");
  const available = lib.addons.filter((a) => !p.addons.some((x) => x.lib === a.id));
  if (!available.length) {
    toast(t("Tous les addons de la bibliothèque sont déjà sur ce profil."), true);
    return null;
  }
  const { done, root } = openDialog({
    title: t("Depuis la bibliothèque"),
    body: `<div class="form"><div class="lib-pick-head"><span class="muted">${esc(t("Addons à ajouter"))}</span><button type="button" id="pick-all" class="btn sm ghost">${esc(t("Tout sélectionner"))}</button></div><div class="lib-picklist">${addonChecklist(available)}</div><p class="muted">${esc(t("Glissez les addons pour définir leur ordre d’ajout."))}</p></div>`,
    okLabel: t("Ajouter"),
    wide: true,
    onOk: () => {
      const ids = boxes().filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) {
        toast(t("Sélectionne au moins un addon."), true);
        return false;
      }
      // Mode de connexion : celui des Reglages ; il se change ensuite depuis la page Addons.
      return api("POST", `/profiles/${p.id}/addons`, { ids });
    },
  });
  const boxes = () => [...root.querySelectorAll(".lib-picklist input[type=checkbox]")];
  enableListReorder(root.querySelector(".lib-picklist"));
  bindSelectAll(root, root.querySelector("#pick-all"), boxes);
  return done;
}

PAGES.library = (main) => renderLibrary(main);
window.StremfinLibrary = { MODES, pickForProfile };
})();
