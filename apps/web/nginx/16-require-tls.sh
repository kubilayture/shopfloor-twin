#!/bin/sh
# Runs before nginx starts (P9-14, ADR-0039): the HTTPS listener needs the certificate and key the
# pki step writes into the web-tls volume (/etc/nginx/tls). Without them, or unreadable, the
# container stops here with a message instead of nginx failing on its configuration.
set -eu
for file in /etc/nginx/tls/server.pem /etc/nginx/tls/server-key.pem /etc/nginx/tls/ca.pem; do
  if [ ! -r "$file" ]; then
    echo "$file is missing or unreadable: run the pki step first (docker compose up runs it)" >&2
    exit 1
  fi
done
