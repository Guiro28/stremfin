// Contexte de la requete en cours (app Emby ou Jellyfin), lisible pendant la construction des
// reponses sans le passer de fonction en fonction.
const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/** Execute la suite de la requete avec son contexte. */
function run(ctx, next) {
  store.run(ctx, next);
}

/** La requete en cours vient-elle d'une app Emby ? */
function isEmbyClient() {
  return !!store.getStore()?.emby;
}

module.exports = { run, isEmbyClient };
