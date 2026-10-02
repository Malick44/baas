#!/bin/bash
# archive_command for point-in-time recovery with the archive kept in baas's shared store (BAAS_PITR_SHARED=true):
#   archive_command = '/etc/baas/pitr-archive.sh <baas-url> <cluster-id> <token> %p %f'
# `baas admin pitr archive-command <cluster>` prints the exact line. It uploads one WAL file with an HTTP PUT and succeeds only
# when baas answers 200, so Postgres keeps the segment until it is safely stored. Uses curl when there is one (needed for https),
# else plain http through bash's /dev/tcp, because the stock postgres image has no curl.
set -u
url=$1 cluster=$2 token=$3 path=$4 file=$5
target="$url/v1/pitr/wal/$cluster/$file"
if command -v curl >/dev/null 2>&1; then
  exec curl -fsS -m 300 -X PUT -H "x-archive-token: $token" -H 'content-type: application/octet-stream' --data-binary "@$path" "$target" -o /dev/null
fi
case "$url" in http://*) ;; *) echo "pitr-archive: https needs curl" >&2; exit 1 ;; esac
hostport=${url#http://}; hostport=${hostport%%/*}
host=${hostport%%:*}; port=80; [ "$host" != "$hostport" ] && port=${hostport##*:}
size=$(stat -c %s "$path")
exec 3<>"/dev/tcp/$host/$port" || exit 1
printf 'PUT /v1/pitr/wal/%s/%s HTTP/1.1\r\nHost: %s\r\nx-archive-token: %s\r\ncontent-type: application/octet-stream\r\ncontent-length: %s\r\nconnection: close\r\n\r\n' "$cluster" "$file" "$hostport" "$token" "$size" >&3
cat "$path" >&3
read -r _ status _ <&3
exec 3>&-
[ "$status" = 200 ]
