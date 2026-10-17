#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
set -a
. ./.env
set +a

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

docker compose up -d --wait

timescale=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "select extversion from pg_extension where extname = 'timescaledb'")
[ -n "$timescale" ] || fail "timescaledb extension missing"
echo "ok: timescaledb $timescale"

# Database roles (#169, ADR-0027). The MES connects as mes_app (over TCP with DB_APP_PASSWORD,
# like the MES): it owns nothing, so changing an object or rewriting the audit trail is refused
# with 42501, also after SET ROLE mes_cagg; as mes_cagg it may refresh an aggregate.
as_app() {
  docker compose exec -T -e PGPASSWORD="$DB_APP_PASSWORD" db \
    psql -h 127.0.0.1 -U mes_app -d "$DB_NAME" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -At "$@" 2>&1
}
[ "$(as_app -c 'select current_user')" = mes_app ] || fail "mes_app cannot log in"
sessions=$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "select count(*) from pg_stat_activity where usename = 'mes_app'")
[ "$sessions" -gt 0 ] || fail "the MES is not connected as mes_app"
for statement in \
  'ALTER TABLE identity.audit_log DISABLE TRIGGER audit_log_no_update_delete' \
  'TRUNCATE identity.audit_log' \
  'UPDATE identity.audit_log SET username = username' \
  'DELETE FROM identity.audit_log' \
  'UPDATE alarms.alarm_transition SET actor = actor' \
  'DELETE FROM alarms.occurrence_state' \
  'DELETE FROM shifts.handover_note' \
  'CREATE TABLE identity.smoke (x int)'; do
  for role in mes_app mes_cagg; do
    out=$(as_app -c "BEGIN; SET LOCAL ROLE $role; $statement; ROLLBACK;" || true)
    case "$out" in
      *'ERROR:  42501'*) ;;
      *) fail "as $role, not refused with 42501: $statement ($out)" ;;
    esac
  done
done
out=$(as_app -c "CALL refresh_continuous_aggregate('ingest.cycle_hourly', '1970-01-01', '1970-01-02')" || true)
case "$out" in
  *'must be owner'*) ;;
  *) fail "mes_app refreshed an aggregate without SET ROLE: $out" ;;
esac
as_app -c 'SET ROLE mes_cagg' \
  -c "CALL refresh_continuous_aggregate('ingest.cycle_hourly', '1970-01-01', '1970-01-02')" \
  >/dev/null || fail "mes_app could not refresh an aggregate as mes_cagg"
echo "ok: database roles (MES as mes_app; audit trail and DDL refused, also as mes_cagg; refresh as mes_cagg)"

if docker compose exec -T broker mosquitto_pub -h localhost -t smoke/anon -m x 2>/dev/null; then
  fail "broker accepted an anonymous client"
fi
echo "ok: anonymous MQTT client refused"

as_user() {
  user=$1
  password=$2
  shift 2
  docker compose exec -T broker "$@" -h localhost -u "$user" -P "$password"
}

topic=orbis/gebze/_sys/edge-gateway/gw-01/smoke
as_user gw-01 "$MQTT_GATEWAY_PASSWORD" mosquitto_pub -q 1 -r -t "$topic" -m persisted
docker compose restart broker >/dev/null
docker compose up -d --wait >/dev/null
received=$(as_user dev "$MQTT_DEV_PASSWORD" mosquitto_sub -t "$topic" -C 1 -W 5 || true)
as_user gw-01 "$MQTT_GATEWAY_PASSWORD" mosquitto_pub -q 1 -r -n -t "$topic"
[ "$received" = persisted ] || fail "retained message lost across broker restart"
echo "ok: retained message survives broker restart"

# delivered <publisher> <publisher password> <topic>: does a message from this user reach `mes`?
acl_out=$(mktemp)
# On every exit (success, `fail`, a `set -e` stop, Ctrl-C): remove the temporary file and disable
# the smoke user once it exists (#170; review of PR #186).
smoke_user=
cleanup() {
  status=$?
  rm -f "$acl_out"
  if [ -n "$smoke_user" ]; then
    if docker compose exec -T mes node apps/mes-server/src/user-cli.ts --disable \
      --username "$smoke_user" >/dev/null 2>&1; then
      echo "ok: the smoke user $smoke_user is disabled again"
    else
      echo "FAIL: could not disable the smoke user $smoke_user" >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
delivered() {
  as_user mes "$MQTT_MES_PASSWORD" mosquitto_sub -t "$3" -C 1 -W 6 >"$acl_out" 2>/dev/null &
  sub=$!
  # The subscriber must be listening before the publish, or a denial would pass vacuously.
  sleep 2
  as_user "$1" "$2" mosquitto_pub -q 1 -t "$3" -m acl 2>/dev/null || true
  wait "$sub" || true
  [ "$(cat "$acl_out")" = acl ]
}
base=orbis/gebze/machining/cell-m1/cnc-01
delivered gw-01 "$MQTT_GATEWAY_PASSWORD" "$base/state/smoke" || fail "gw-01 may not publish state"
if delivered gw-01 "$MQTT_GATEWAY_PASSWORD" "$base/mes/smoke"; then fail "gw-01 published MES context"; fi
if delivered dev "$MQTT_DEV_PASSWORD" "$base/state/smoke"; then fail "dev published although read-only"; fi
if delivered gw-01 "$MQTT_GATEWAY_PASSWORD" "orbis/gebze/_sys/edge-gateway/gw-02/status"; then
  fail "gw-01 published another gateway's status"
fi
if delivered gw-01 "$MQTT_GATEWAY_PASSWORD" "orbis/gebze/_sys/mes-server/main/state/x"; then
  fail "gw-01 wrote into another component's topics"
fi
echo "ok: broker ACLs (gateway may publish machine data only; dev is read-only)"

status=$(curl -sf "http://127.0.0.1:${SIM_CONTROL_PORT:-4800}/api/v1/status") || fail "simulator control API not reachable"
case "$status" in
  *'"state":"running"'*) echo "ok: simulator running ($status)" ;;
  *) fail "simulator not running: $status" ;;
esac
for port in 4841 4842 4843 4844 4845 5020; do
  docker compose exec -T simulator node -e "
    const s = require('node:net').connect($port, '127.0.0.1');
    s.on('connect', () => process.exit(0)).on('error', () => process.exit(1));
  " || fail "port $port not listening"
done
echo "ok: OPC UA servers listening on 4841-4845, Modbus on 5020"

ready=$(curl -sf "http://127.0.0.1:${GATEWAY_HTTP_PORT:-4900}/health/ready") || fail "gateway not ready"
echo "ok: gateway ready ($ready)"
# Every machine's retained state reaches the UNS through the gateway (snapshot on connect).
states=$(as_user dev "$MQTT_DEV_PASSWORD" mosquitto_sub -t 'orbis/gebze/+/+/+/state/current' -v -C 6 -W 30 | cut -d/ -f5 | sort -u | tr '\n' ' ')
[ "$states" = "asm-01 cnc-01 cnc-02 lkt-01 pck-01 wsh-01 " ] || fail "UNS states incomplete: $states"
echo "ok: UNS has the current state of all six machines"

# ERP mock (#171): ready, refuses the API without the bearer token, serves the order feed with it.
# The token goes to curl on stdin, not on its command line.
erp="http://127.0.0.1:${ERP_HTTP_PORT:-4600}"
curl -sf "$erp/health/ready" >/dev/null || fail "ERP mock not ready"
code=$(curl -s -o /dev/null -w '%{http_code}' "$erp/api/v1/orders")
[ "$code" = 401 ] || fail "ERP mock answered without a token ($code)"
feed=$(printf 'Authorization: Bearer %s\n' "$ERP_API_TOKEN" | curl -sf -H @- "$erp/api/v1/orders?limit=1") ||
  fail "ERP mock refused its own token"
case "$feed" in
  *'"feedSeq":1'*) echo "ok: ERP mock ready, token required, order feed served" ;;
  *) fail "ERP mock feed empty: $feed" ;;
esac


# MES and web (#99). `up --wait` above already waited for the MES to be ready (migrated, database
# answering, subscribed to the UNS) and for nginx.
ready=$(curl -sf "http://127.0.0.1:${MES_HTTP_PORT:-4700}/health/ready") || fail "MES not ready"
echo "ok: MES ready ($ready)"
web="http://127.0.0.1:${WEB_PORT:-8080}"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.test:${WEB_PORT:-8080}" "$web/api/v1/equipment")
[ "$code" = 403 ] || fail "MES answered a foreign Host through the web ($code)"
echo "ok: foreign Host refused through the web (DNS rebinding)"

# Identity (#170): every API route and the WebSocket need a session (MES_AUTH=on by default). The
# smoke logs in as a user of its own, made for this run with `user:create` inside the MES container
# (password generated here, passed on stdin and in the environment of the web checks only; never
# written to a file). The exit trap disables it again, pass, fail or Ctrl-C (`user-cli.ts --disable`);
# its row and audit entries stay in the database (users are never deleted).
SMOKE_USERNAME="smoke-$(openssl rand -hex 4)"
SMOKE_PASSWORD=$(openssl rand -hex 16)
export SMOKE_USERNAME SMOKE_PASSWORD
printf '%s' "$SMOKE_PASSWORD" | docker compose exec -T mes \
  node apps/mes-server/src/user-cli.ts --username "$SMOKE_USERNAME" --role operator >/dev/null ||
  fail "user:create could not create the smoke user"
smoke_user=$SMOKE_USERNAME
echo "ok: user:create made the operator $SMOKE_USERNAME"
node scripts/stack-smoke-web.mjs "$web" || fail "web checks failed"
