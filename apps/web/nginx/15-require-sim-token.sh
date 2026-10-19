#!/bin/sh
# Runs before the template is rendered (#237): the console's /sim/ proxy needs the control API's
# token. Without it, or with characters that don't fit a header value, the container stops here
# instead of serving a proxy that only ever answers 401.
set -eu
token=${SIM_CONTROL_TOKEN:-}
if [ ${#token} -lt 16 ] || [ ${#token} -gt 512 ]; then
  echo "SIM_CONTROL_TOKEN must be set, 16-512 characters" >&2
  exit 1
fi
if printf '%s' "$token" | grep -q '[^A-Za-z0-9._~+/=-]'; then
  echo "SIM_CONTROL_TOKEN may hold only A-Z a-z 0-9 . _ ~ + / = -" >&2
  exit 1
fi
