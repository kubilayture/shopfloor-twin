#!/bin/sh
# One-time init of a fresh clone (#277, P10-02, Phase 10 plan "Success criterion 1"): writes .env
# from .env.example with a new random value for every *_PASSWORD and *_TOKEN key, the rule
# scripts/gate.ts uses for its throw-away env file, and appends any required secret .env.example
# lacks. Then `docker compose up -d --wait` starts the stack:
#
#   sh scripts/stack-init.sh && docker compose up -d --wait
#
# - POSIX sh, no Node.js: the random values come from `openssl rand -hex 16`, or from 16 bytes of
#   /dev/urandom through `od` when openssl is not installed.
# - It acts on its working directory, or on the directory given as $1, never on a path derived from
#   its own location.
# - It never overwrites .env: the file is created under `umask 077` (mode 600) with `set -C`
#   (noclobber), so a .env that appeared meanwhile is never replaced. When .env exists it only
#   checks it: every required key (REQUIRED_SECRETS below, the same list as scripts/gate.ts's,
#   asserted by e2e/src/stack-init.test.ts) must have a value other than `change-me`. Then it says
#   "already initialised" and exits 0, so the line can be rerun. A required key that is missing or
#   empty is reported as missing, one set to `change-me` as weak, by name only (never a value),
#   and it exits 1. The optional GRAFANA_ADMIN_PASSWORD (observability profile) is generated but
#   never reported.
# - The bootstrap admin's password (user `admin`, to be changed at the first login, ADR-0026) is
#   printed once, only when the output is a terminal; otherwise the script says where it is, so no
#   log ever holds it.
#
# Usage: sh scripts/stack-init.sh [directory]   (or `pnpm stack:init`)
# Exit: 0 written or already initialised, 1 an existing .env lacks a required secret or has a weak
# one, 2 no .env.example (or the directory doesn't exist).
#
# Utilities: od tr
# Optional: openssl
# (Everything else is a shell builtin. The fresh-clone test, e2e/src/fresh-clone.ts, runs this
# with a PATH of links to exactly sh, git, docker, the utilities and the optional ones above.)

umask 077
set -Ceu

REQUIRED_SECRETS='DB_PASSWORD DB_APP_PASSWORD MQTT_HEALTHCHECK_PASSWORD MQTT_DEV_PASSWORD MQTT_GATEWAY_PASSWORD MQTT_MES_PASSWORD ERP_API_TOKEN SIM_CONTROL_TOKEN OPCUA_GATEWAY_PASSWORD OPCUA_READER_PASSWORD MES_BOOTSTRAP_ADMIN_PASSWORD'

dir=${1:-.}
cd -- "$dir" 2>/dev/null || {
  echo "stack-init: no directory $dir" >&2
  exit 2
}
[ -f .env.example ] || {
  echo "stack-init: no .env.example in $(pwd)" >&2
  exit 2
}

# secret: 32 hex characters (16 random bytes).
secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
    echo
  fi
}

# value_of <key> <file>: the value of the key's last assignment, without surrounding quotes; empty
# when the key is not there (`found` says whether it was).
value_of() {
  found=0
  value=
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$1="*)
        found=1
        value=${line#*=}
        ;;
    esac
  done <"$2"
  case "$value" in
    \"*\") value=${value#\"} value=${value%\"} ;;
    \'*\') value=${value#\'} value=${value%\'} ;;
  esac
}

if [ -e .env ] || [ -L .env ]; then
  missing=
  weak=
  for key in $REQUIRED_SECRETS; do
    value_of "$key" .env
    if [ -z "$value" ]; then
      missing="$missing $key"
    elif [ "$value" = change-me ]; then
      weak="$weak $key"
    fi
  done
  value=
  if [ -z "$missing$weak" ]; then
    echo "stack-init: already initialised (.env exists with every required secret set)"
    exit 0
  fi
  echo "stack-init: .env exists and is not changed, but it is not complete:" >&2
  for key in $missing; do echo "  missing: $key" >&2; done
  for key in $weak; do echo "  weak (change-me): $key" >&2; done
  echo "Set each to a random value of its own (for example \`openssl rand -hex 16\`), or move .env away and run this again." >&2
  exit 1
fi

# The new file's content, made in full before .env is created.
content=
seen=' '
admin=
while IFS= read -r line || [ -n "$line" ]; do
  key=
  case "$line" in
    [A-Z0-9_]*=*)
      key=${line%%=*}
      case "$key" in
        *[!A-Z0-9_]*) key= ;;
      esac
      ;;
  esac
  if [ -n "$key" ]; then
    seen="$seen$key "
    case "$key" in
      *_PASSWORD | *_TOKEN)
        value=$(secret)
        [ "${#value}" -eq 32 ] || {
          echo "stack-init: could not generate a random value" >&2
          exit 1
        }
        line="$key=$value"
        if [ "$key" = MES_BOOTSTRAP_ADMIN_PASSWORD ]; then admin=$value; fi
        ;;
    esac
  fi
  content="$content$line
"
done <.env.example
for key in $REQUIRED_SECRETS; do
  case "$seen" in
    *" $key "*) ;;
    *)
      value=$(secret)
      [ "${#value}" -eq 32 ] || {
        echo "stack-init: could not generate a random value" >&2
        exit 1
      }
      content="$content$key=$value
"
      if [ "$key" = MES_BOOTSTRAP_ADMIN_PASSWORD ]; then admin=$value; fi
      ;;
  esac
done
value=

# noclobber: fails, changing nothing, if .env appeared since the check above.
printf '%s' "$content" >.env || {
  echo "stack-init: could not create .env (did another one appear meanwhile?)" >&2
  exit 1
}
content=
echo "stack-init: wrote .env (mode 600) with a new random value for every password and token"
if [ -t 1 ]; then
  echo "stack-init: the bootstrap admin is \`admin\` with the password $admin (change it at the first login)"
else
  echo "stack-init: the bootstrap admin is \`admin\`; its password is MES_BOOTSTRAP_ADMIN_PASSWORD in .env (change it at the first login)"
fi
