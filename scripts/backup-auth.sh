#!/bin/bash
# AT1 — backup defensivo das sessions Baileys (Rev.1.0.0.md).
#
# Empacota /root/maria-bot/auth/ num .tar.gz e mantém os últimos N backups
# em /var/backups/maria-bot/. Designed pra rodar via cron diário.
#
# Restore manual: tar xzf <backup>.tar.gz -C /root/maria-bot/
#
# Por que local-only? Sessions Baileys têm credentials WhatsApp do owner.
# Mandar pra Drive/S3 sem encryption seria pior que perder. Local rotativo
# já cobre o caso mais frequente (corrupção/I/O error). Pra DR completo,
# adicione passo extra com `age`/`gpg` antes de subir pra cloud.
set -euo pipefail

SRC="/root/maria-bot/auth"
DEST="/var/backups/maria-bot"
RETENTION_DAYS=14

mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/auth-$STAMP.tar.gz"

if [ ! -d "$SRC" ]; then
  echo "[backup-auth] ERRO: $SRC não existe — abortando" >&2
  exit 1
fi

tar czf "$OUT" -C /root/maria-bot auth
chmod 600 "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup-auth] $OUT ($SIZE)"

# Remove backups antigos (>RETENTION_DAYS)
find "$DEST" -name 'auth-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -delete
KEPT=$(find "$DEST" -name 'auth-*.tar.gz' -type f | wc -l)
echo "[backup-auth] retidos: $KEPT backups (retention=${RETENTION_DAYS}d)"
