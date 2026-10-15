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
trap 'rm -f "$acl_out"' EXIT
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

