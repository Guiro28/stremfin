#!/bin/sh
set -e

mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"

# Carte graphique Intel / AMD donnee au conteneur (/dev/dri) : l'utilisateur node rejoint le groupe
# qui y a acces, quel que soit son numero sur l'hote (conversion video par VA-API / QuickSync).
for dev in /dev/dri/renderD* /dev/dri/card*; do
  [ -e "$dev" ] || continue
  gid=$(stat -c %g "$dev")
  [ "$gid" = "0" ] && continue
  group=$(getent group "$gid" | cut -d: -f1)
  if [ -z "$group" ]; then
    group="gpu$gid"
    addgroup -g "$gid" "$group" 2>/dev/null || true
  fi
  addgroup node "$group" 2>/dev/null || true
done

exec su-exec node "$@"
