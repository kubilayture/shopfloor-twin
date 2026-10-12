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

topic=orbis/gebze/_sys/smoke
mqtt() {
  docker compose exec -T broker "$@" -h localhost -u dev -P "$MQTT_DEV_PASSWORD"
}
mqtt mosquitto_pub -q 1 -r -t "$topic" -m persisted
docker compose restart broker >/dev/null
docker compose up -d --wait >/dev/null
received=$(mqtt mosquitto_sub -t "$topic" -C 1 -W 5)
mqtt mosquitto_pub -r -n -t "$topic"
[ "$received" = persisted ] || fail "retained message lost across broker restart"
echo "ok: retained message survives broker restart"
