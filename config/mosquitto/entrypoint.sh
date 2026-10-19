#!/bin/sh
# Generates the broker's dynamic-security configuration (ADR-0039) and starts Mosquitto.
#
# /mosquitto/config is mounted read-only, so the configuration the plugin loads lives in
# /mosquitto/data: on every start it is rebuilt from the template in this directory (users, their
# bound client ids, roles and ACLs; no secrets) and the passwords in MQTT_USERS
# ("user:password user:password …", this stack's random passwords from .env), hashed by
# `mosquitto_ctrl -f … dynsec setClientPassword`. Nothing is kept from a previous start: there is
# no admin user, so nothing changes the configuration at run time, and a changed password in .env
# takes effect on the next start.
#
# It refuses to start (exit 1) when MQTT_USERS names a user the template doesn't have or a name
# outside a-z, 0-9 and -, gives an empty password, or leaves a user of the template without one.
# Each password is on mosquitto_ctrl's command line (argv) for the moment it is hashed, inside the
# broker container only (ADR-0039).
set -eu

template=/mosquitto/config/dynamic-security.json
config=/mosquitto/data/dynamic-security.json
next="$config.next"

fail() {
  echo "entrypoint: $1" >&2
  exit 1
}

umask 077
# The plain password file of Phases 3 to 8: gone with the ACL file.
rm -f /mosquitto/data/passwd "$next"
cp "$template" "$next"

# No globbing of the entries (a password may hold * or ?); one word per user:password.
set -f
for entry in ${MQTT_USERS:?MQTT_USERS is not set}; do
  user=${entry%%:*}
  password=${entry#*:}
  [ -n "$user" ] && [ "$user" != "$entry" ] || fail "an MQTT_USERS entry is not user:password"
  case "$user" in
    *[!a-z0-9-]*) fail "MQTT_USERS names a user with characters other than a-z, 0-9 and -" ;;
  esac
  [ -n "$password" ] || fail "the password of $user is empty"
  # Exact match, in the template's layout or in mosquitto_ctrl's compact one once it rewrote the file.
  grep -qF "\"username\": \"$user\"" "$next" || grep -qF "\"username\":\"$user\"" "$next" ||
    fail "MQTT_USERS names $user, a user the template doesn't have"
  # mosquitto_ctrl exits 0 even when it reports an error ("Error: Client … not found.").
  out=$(mosquitto_ctrl -f "$next" dynsec setClientPassword "$user" "$password" 2>&1) ||
    fail "could not set the password of $user"
  case "$out" in
    *Error*) fail "could not set the password of $user" ;;
  esac
done
set +f

users=$(grep -o '"username": *"[^"]*"' "$next" | wc -l)
passwords=$(grep -o '"encoded_password": *"[^"]*"' "$next" | wc -l)
[ "$users" -eq "$passwords" ] || fail "$((users - passwords)) user(s) of the template got no password"

chown mosquitto:mosquitto "$next"
mv "$next" "$config"

# The passwords are hashed into the file; Mosquitto needs none of them in its environment.
unset MQTT_USERS
exec mosquitto -c /mosquitto/config/mosquitto.conf
