#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
# The env file: ./.env by default; SMOKE_ENV_FILE names another (the gate's throw-away file with
# generated secrets, #178), which every docker compose call below then reads instead of ./.env.
env_file=${SMOKE_ENV_FILE:-./.env}
set -a
. "$env_file"
set +a
# SMOKE_EPHEMERAL_PORTS=1 (the gate, #228): every published port on an ephemeral host port chosen
# by Docker (e2e/compose.ephemeral-ports.yml; the broker unpublished too), so a dev stack on the
# default ports can stay up. The smoke reads each address back with `docker compose port` either
# way, so it never assumes a fixed host port. Either way the MES, the gateway and the database are
# not published (P9-14, ADR-0039): the smoke reaches them with `docker compose exec`.
compose_files=
if [ "${SMOKE_EPHEMERAL_PORTS:-}" = 1 ]; then
  compose_files="--file docker-compose.yml --file e2e/compose.ephemeral-ports.yml"
fi
docker() {
  if [ "$1" = compose ]; then
    shift
    # shellcheck disable=SC2086 # compose_files is a list of words or empty
    command docker compose --env-file "$env_file" $compose_files "$@"
  else
    command docker "$@"
  fi
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# published <service> <container port>: the host address the port is published on, or nothing.
# (`docker compose port` prints ":0" and exits 0 for a port that isn't published.)
published() {
  address=$(docker compose port "$1" "$2" 2>/dev/null) || address=
  case "$address" in
    *:0 | '') ;;
    *) echo "$address" ;;
  esac
}
# url <service> <container port> [scheme]: <scheme, default http>://<host address> the port is
# published on.
url() {
  address=$(published "$1" "$2")
  [ -n "$address" ] || fail "$1:$2 is not published"
  echo "${3:-http}://$address"
}
# in_container <service> <port> <path>: GET http://127.0.0.1:<port><path> inside the service's
# container (the MES and the gateway are not published, P9-14), its body on stdout; fails on a
# non-2xx answer.
in_container() {
  docker compose exec -T "$1" node -e "
    fetch('http://127.0.0.1:$2$3').then(async (r) => {
      process.stdout.write(await r.text());
      process.exit(r.ok ? 0 : 1);
    }, () => process.exit(1));
  "
}

# Compose refuses to start without a required secret, but not without the optional bootstrap
# admin password (#168, ADR-0026): `config` interpolates like `up`, in a clean environment so the
# variables exported above don't fill the gap.
compose_without() {
  stripped=$(mktemp)
  grep -v "^$1=" "$env_file" >"$stripped" || true
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file "$stripped" config -q >/dev/null 2>&1
  result=$?
  rm -f "$stripped"
  return $result
}
# The same with the observability file (P9-17, compose.observability.yml) on the hardened files and
# the profiles given after the key (`observability`: Prometheus; `grafana`: Grafana).
observability_without() {
  stripped=$(mktemp)
  grep -v "^$1=" "$env_file" >"$stripped" || true
  shift
  profiles=
  for profile in "$@"; do profiles="$profiles --profile $profile"; done
  # shellcheck disable=SC2086 # profiles is a list of words
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file "$stripped" \
    --file docker-compose.yml --file compose.observability.yml $profiles \
    config -q >/dev/null 2>&1
  result=$?
  rm -f "$stripped"
  return $result
}
for key in DB_PASSWORD DB_APP_PASSWORD ERP_API_TOKEN SIM_CONTROL_TOKEN MQTT_HEALTHCHECK_PASSWORD \
  MQTT_DEV_PASSWORD MQTT_GATEWAY_PASSWORD MQTT_MES_PASSWORD OPCUA_GATEWAY_PASSWORD \
  OPCUA_READER_PASSWORD; do
  if compose_without "$key"; then fail "Compose accepted a configuration without $key"; fi
done
compose_without MES_BOOTSTRAP_ADMIN_PASSWORD ||
  fail "Compose refused a configuration without the optional MES_BOOTSTRAP_ADMIN_PASSWORD"
echo "ok: Compose refuses to start without a required secret, not without the bootstrap admin password"
# The observability profile (P9-17) is opt-in: the default stack doesn't need its Grafana password;
# with the profile Compose refuses to start without it. Checked when the env file sets it (the
# gate's does: every *_PASSWORD of .env.example is generated), so a .env without the profile passes.
compose_without GRAFANA_ADMIN_PASSWORD ||
  fail "the default stack requires GRAFANA_ADMIN_PASSWORD (the observability profile's)"
if [ -n "${GRAFANA_ADMIN_PASSWORD:-}" ]; then
  observability_without NONE observability grafana ||
    fail "Compose refused the observability profiles with every secret set"
  if observability_without GRAFANA_ADMIN_PASSWORD observability grafana; then
    fail "Compose accepted Grafana's profile without GRAFANA_ADMIN_PASSWORD"
  fi
  # Prometheus alone (the performance suite, P9-18) needs no Grafana password.
  observability_without GRAFANA_ADMIN_PASSWORD observability ||
    fail "Compose refused Prometheus alone without GRAFANA_ADMIN_PASSWORD"
  echo "ok: the observability profiles are opt-in; Grafana's refuses to start without GRAFANA_ADMIN_PASSWORD, Prometheus alone doesn't need it"
else
  echo "ok: the default stack needs no GRAFANA_ADMIN_PASSWORD (not set here: profile not checked)"
fi

# Rows the MES records from here on belong to this run (rejected cycles below).
smoke_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d --wait

# Where the stack listens on the host (#228): read back, never assumed. The web front is HTTPS
# only (P9-14, ADR-0039).
sim_url=$(url simulator 4800)
erp=$(url erp 4600)
web=$(url web 8443 https)
web_address=${web#https://}
if [ "${SMOKE_EPHEMERAL_PORTS:-}" = 1 ]; then
  for address in "$sim_url" "$erp" "$web"; do
    case "$address" in
      *:4800 | *:4600 | *:8443) fail "a default host port is published: $address" ;;
    esac
  done
  for pair in "broker 1883" "simulator 4841" "simulator 4845" "simulator 5020"; do
    # shellcheck disable=SC2086 # two words: service and port
    [ -z "$(published $pair)" ] || fail "published on the host: $pair"
  done
  echo "ok: ephemeral host ports (web $web); broker, OPC UA and Modbus unpublished"
fi
# The hardened ports (P9-14, checklist S8): the MES, the gateway and the database are published on
# no host port, the web on no HTTP port; every published container port is one of the S8 list
# (8443, 1883, 4800, 4841-4845, 5020, 4600), on 127.0.0.1 only.
for pair in "mes 4700" "gateway 4900" "db 5432" "web 8080"; do
  # shellcheck disable=SC2086 # two words: service and port
  [ -z "$(published $pair)" ] || fail "published on the host: $pair"
done
bindings=$(docker compose ps --format json | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
    const rows = text.trim().startsWith("[") ? JSON.parse(text) : text.trim().split("\n").map((l) => JSON.parse(l));
    for (const row of rows) {
      for (const p of row.Publishers ?? []) {
        if (p.PublishedPort > 0) console.log(`${row.Service}:${p.TargetPort}@${p.URL}`);
      }
    }
  });
') || fail "could not list the published ports"
for binding in $bindings; do
  case "$binding" in
    web:8443@127.0.0.1 | broker:1883@127.0.0.1 | simulator:4800@127.0.0.1 | simulator:484[1-5]@127.0.0.1 | \
      simulator:5020@127.0.0.1 | erp:4600@127.0.0.1) ;;
    *) fail "published outside the S8 list: $binding" ;;
  esac
done
echo "ok: published ports within the S8 list ($(echo $bindings | wc -w | tr -d ' ') bindings); MES, gateway, database unpublished"

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

# The client id the broker binds to a user (P9-13, ADR-0039; config/mosquitto/dynamic-security.json):
# every user is bound, most to their own name.
bound_id() {
  case "$1" in
    mes) echo mes-server ;;
    mes-cmd) echo mes-server-cmd ;;
    *) echo "$1" ;;
  esac
}
# as_user <user> <password> <command…>: the command in the broker container as that user, under
# its bound client id (so one connection per user at a time). As gw-01 that takes the gateway's
# publishing session over for a moment (clean, with an outbox: it reconnects and resends). Never as
# mes: its session is persistent, and a clean connection under its id would end it.
as_user() {
  user=$1
  password=$2
  shift 2
  id=$(bound_id "$user")
  docker compose exec -T broker "$@" -h localhost -u "$user" -P "$password" -i "$id"
}
# connects <user> <password> <client id>: does the broker accept this login?
connects() {
  docker compose exec -T broker mosquitto_pub -h localhost -u "$1" -P "$2" -i "$3" \
    -t smoke/login -n >/dev/null 2>&1
}

# Client-id binding and passwords (P9-13, S2): no user may take another's session (Mosquitto checks
# no username on a takeover, so every user is bound, dev and healthcheck included), a user connects
# only under its own id, a wrong password is refused. The generated configuration holds the
# password hashes: private to the broker, and the plain password file of Phase 8 is gone.
for login in "mes:$MQTT_MES_PASSWORD:gw-01" "mes-cmd:$MQTT_MES_PASSWORD:mes-server" \
  "gw-01:$MQTT_GATEWAY_PASSWORD:mes-server" "gw-01-cmd:$MQTT_GATEWAY_PASSWORD:gw-01" \
  "gw-01:$MQTT_GATEWAY_PASSWORD:gw-01-cmd" "mes:$MQTT_MES_PASSWORD:mes-server-cmd" \
  "gw-01:$MQTT_GATEWAY_PASSWORD:smoke-$$" "mes:$MQTT_MES_PASSWORD:smoke-$$" \
  "dev:$MQTT_DEV_PASSWORD:gw-01" "healthcheck:$MQTT_HEALTHCHECK_PASSWORD:gw-01" \
  "dev:$MQTT_DEV_PASSWORD:mes-server-cmd" "smoke-reader:$MQTT_DEV_PASSWORD:dev" \
  "dev:$MQTT_DEV_PASSWORD:smoke-$$" "healthcheck:$MQTT_HEALTHCHECK_PASSWORD:smoke-$$"; do
  user=${login%%:*}
  id=${login##*:}
  password=${login#*:}
  password=${password%:*}
  if connects "$user" "$password" "$id"; then fail "the broker accepted $user with client id $id"; fi
done
if connects gw-01 "not-the-password-$$" gw-01; then fail "the broker accepted a wrong password"; fi
if connects dev "$MQTT_GATEWAY_PASSWORD" "smoke-$$"; then fail "the broker accepted another user's password"; fi
connects dev "$MQTT_DEV_PASSWORD" dev || fail "dev cannot connect with its own client id"
[ "$(docker compose exec -T broker stat -c '%a %U' /mosquitto/data/dynamic-security.json)" = '600 mosquitto' ] ||
  fail "the dynamic-security configuration is not private to the broker"
if docker compose exec -T broker test -e /mosquitto/data/passwd; then fail "the Phase 8 password file is still there"; fi
echo "ok: broker client ids bound to every user (no takeover, also by dev or healthcheck); wrong passwords refused"

topic=orbis/gebze/_sys/edge-gateway/gw-01/smoke
as_user gw-01 "$MQTT_GATEWAY_PASSWORD" mosquitto_pub -q 1 -r -t "$topic" -m persisted
docker compose restart broker >/dev/null
docker compose up -d --wait >/dev/null
received=$(as_user dev "$MQTT_DEV_PASSWORD" mosquitto_sub -t "$topic" -C 1 -W 5 || true)
as_user gw-01 "$MQTT_GATEWAY_PASSWORD" mosquitto_pub -q 1 -r -n -t "$topic"
[ "$received" = persisted ] || fail "retained message lost across broker restart"
echo "ok: retained message survives broker restart"

# delivered <publisher> <publisher password> <topic>: does a message from this user reach a reader?
# The reader is `smoke-reader` (dev's role: reads orbis/#, as `mes` does), so the MES's session is
# never touched and `dev` can publish meanwhile.
acl_out=$(mktemp)
# The dev CA's and the web's certificates (P9-14), read from the web container below.
tls_dir=$(mktemp -d)
# On every exit (success, `fail`, a `set -e` stop, Ctrl-C): remove the temporary file and disable
# the smoke user once it exists (#170; review of PR #186).
smoke_users=
cleanup() {
  status=$?
  rm -f "$acl_out"
  rm -rf "$tls_dir"
  for smoke_user in $smoke_users; do
    if docker compose exec -T mes node apps/mes-server/src/user-cli.ts --disable \
      --username "$smoke_user" >/dev/null 2>&1; then
      echo "ok: the smoke user $smoke_user is disabled again"
    else
      echo "FAIL: could not disable the smoke user $smoke_user" >&2
      [ "$status" -ne 0 ] || status=1
    fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
delivered() {
  as_user smoke-reader "$MQTT_DEV_PASSWORD" mosquitto_sub -t "$3" -C 1 -W 6 >"$acl_out" 2>/dev/null &
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

# The control token (#237, control API 1.11): every route but /health/* and /metrics refuses a
# request without it (reads too) or with another; the token goes to curl on stdin, not on its
# command line.
for path in /api/v1/status /api/v1/ground-truth /api/v1/lots /api/v1/no-such-route; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$sim_url$path")
  [ "$code" = 401 ] || fail "control API answered $path without the token ($code)"
  code=$(printf 'Authorization: Bearer %s\n' "not-the-token-$(openssl rand -hex 8)" |
    curl -s -o /dev/null -w '%{http_code}' -H @- "$sim_url$path")
  [ "$code" = 401 ] || fail "control API answered $path with a wrong token ($code)"
done
curl -sf -o /dev/null "$sim_url/health/ready" || fail "control API health check needs a token"
sim_get() {
  printf 'Authorization: Bearer %s\n' "$SIM_CONTROL_TOKEN" | curl -sf -H @- "$sim_url$1"
}
echo "ok: control API refuses requests without its token (401), health check open"
status=$(sim_get /api/v1/status) || fail "simulator control API not reachable with its token"
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

# The pki step (#239, ADR-0038): the one-shot service ran before the simulator and the gateway and
# exited 0. Its summary line says how many certificates it made and how long that took; the first
# one is this project's first run (a later `up` reruns it, keeping what is valid).
pki_container=$(docker compose ps --all --quiet pki)
[ -n "$pki_container" ] || fail "no pki container"
pki_state=$(docker inspect "$pki_container" --format '{{.State.Status}} {{.State.ExitCode}}')
[ "$pki_state" = "exited 0" ] || fail "the pki step did not exit 0 ($pki_state)"
pki_summary=$(docker compose logs --no-log-prefix pki 2>/dev/null | grep '^pki: ok' | head -n 1)
[ -n "$pki_summary" ] || fail "the pki step logged no summary"
echo "ok: pki step exited 0 (first run: ${pki_summary#pki: ok, })"
# Each PKI volume is mounted by its own component only (the pki step mounts all of them while it
# runs; the tools volume and the dev CA's, pki-ca, by no long-running service; web-tls, nginx's
# certificate and key, by the web alone, read-only).
for service in $(docker compose ps --format '{{.Service}}'); do
  mounts=$(docker inspect "$(docker compose ps -q "$service")" \
    --format '{{range .Mounts}}{{.Name}}:{{.RW}} {{end}}')
  for volume in simulator-pki gateway-pki opcua-tools-pki pki-ca web-tls; do
    case " $mounts" in
      *"_$volume:"*)
        case "$service:$volume" in
          simulator:simulator-pki | gateway:gateway-pki) ;;
          web:web-tls)
            case " $mounts" in *"_web-tls:false "*) ;; *) fail "web mounts web-tls writable" ;; esac
            ;;
          *) fail "$service mounts $volume" ;;
        esac
        ;;
    esac
  done
done
echo "ok: each PKI volume mounted by its own component only (pki-ca by none, web-tls read-only)"
# Checklist S1 as the tools client (opcua-reader, the tools certificate every server pins), inside
# the Compose network: SignAndEncrypt only, LoadOrder and LoadProgram refused with
# BadUserAccessDenied (a permission refusal on a trusted certificate), an unpinned client
# certificate refused, anonymous sessions and a wrong password refused, and no variable writable
# (none with CurrentWrite, every Write refused, on all five machines; #239 review).
docker compose run --rm --no-deps opcua-tools || fail "OPC UA security checks failed"

ready=$(in_container gateway 4900 /health/ready) || fail "gateway not ready"
echo "ok: gateway ready ($ready)"
# Every machine's retained state reaches the UNS through the gateway (snapshot on connect).
states=$(as_user dev "$MQTT_DEV_PASSWORD" mosquitto_sub -t 'orbis/gebze/+/+/+/state/current' -v -C 6 -W 30 | cut -d/ -f5 | sort -u | tr '\n' ' ')
[ "$states" = "asm-01 cnc-01 cnc-02 lkt-01 pck-01 wsh-01 " ] || fail "UNS states incomplete: $states"
echo "ok: UNS has the current state of all six machines"

# Lots and operator on cycle facts (UNS contract 1.4, #197, ADR-0033), as the MES stored them: the
# latest CNC cycle carries its lots and a null operator; an ASM-01 cycle carries component lots
# and an operator, and the lot index finds it. The simulator starts producing with the stack, so
# by now (or within the short retry) both machines have completed cycles; no live subscription.
cnc_trace=""
asm_lot=""
for _ in $(seq 1 45); do
  cnc_trace=$(as_app -c "select jsonb_typeof(payload -> 'value' -> 'lots') || ':' ||
      coalesce(jsonb_array_length(case when jsonb_typeof(payload -> 'value' -> 'lots') = 'array'
        then payload -> 'value' -> 'lots' end), -1) || ':' ||
      coalesce(jsonb_typeof(payload -> 'value' -> 'operator'), 'absent')
    from ingest.equipment_event where event_type = 'cycle' and equipment in ('cnc-01', 'cnc-02')
    order by ingested_at desc limit 1")
  asm_lot=$(as_app -c "select payload -> 'value' -> 'lots' -> 0 ->> 'lot'
    from ingest.equipment_event where event_type = 'cycle' and equipment = 'asm-01'
      and payload -> 'value' -> 'lots' @> '[{}]'
      and jsonb_typeof(payload -> 'value' -> 'operator') = 'string'
    order by ingested_at desc limit 1")
  case "$cnc_trace" in array:[1-9]*:null) [ -n "$asm_lot" ] && break ;; esac
  sleep 2
done
case "$cnc_trace" in
  array:[1-9]*:null) ;;
  *) fail "the latest stored CNC cycle has no lots or a non-null operator ($cnc_trace)" ;;
esac
[ -n "$asm_lot" ] || fail "no stored ASM-01 cycle with component lots and an operator"
printf '%s' "$asm_lot" | grep -Eq '^[A-Za-z0-9-]+$' || fail "unexpected lot id: $asm_lot"
found=$(as_app -c "select count(*) from ingest.equipment_event where event_type = 'cycle'
  and payload -> 'value' -> 'lots' @> jsonb_build_array(jsonb_build_object('lot', '$asm_lot'))")
[ "$found" -gt 0 ] || fail "the lot index found no cycle of lot $asm_lot"
# Cycles refused, or kept without their trace fields, since this smoke started the stack.
refused=$(as_app -c "select count(*) from ingest.rejected_message
  where topic like '%/events/cycle-complete' and received_at >= '$smoke_started'")
[ "$refused" = 0 ] || fail "the MES refused $refused cycle messages or dropped their trace fields"
echo "ok: stored cycle facts carry lots and operator (contract 1.4; lot $asm_lot found by lot, $found cycles)"

# ERP mock (#171): ready, refuses the API without the bearer token, serves the order feed with it.
# The token goes to curl on stdin, not on its command line.
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
ready=$(in_container mes 4700 /health/ready) || fail "MES not ready"
echo "ok: MES ready ($ready)"

# The HTTPS front (P9-14, ADR-0039, checklist S4). The dev CA's certificate (public) and the
# certificate nginx should serve are read from the web container (the pki step's web-tls volume),
# never taken from the handshake; every request to the web below trusts that CA alone (curl
# --cacert; NODE_EXTRA_CA_CERTS for the web checks, which compare the handshake's certificate with
# this one).
docker compose exec -T web cat /etc/nginx/tls/ca.pem >"$tls_dir/ca.pem" ||
  fail "no dev CA certificate in the web container"
docker compose exec -T web cat /etc/nginx/tls/server.pem >"$tls_dir/server.pem" ||
  fail "no server certificate in the web container"
wcurl() {
  curl --cacert "$tls_dir/ca.pem" "$@"
}
code=$(wcurl -s -o /dev/null -w '%{http_code}' "$web/healthz")
[ "$code" = 200 ] || fail "the web did not answer over HTTPS with the dev CA ($code)"
untrusted=0
curl -s -o /dev/null "$web/healthz" || untrusted=$?
[ "$untrusted" = 60 ] || fail "the web's certificate verified without the dev CA (curl exit $untrusted)"
plain=$(curl -s -D - -o /dev/null "http://$web_address/") || fail "no answer to plain HTTP on the web port"
case "$plain" in
  'HTTP/1.1 400'*) ;;
  *) fail "plain HTTP on the web port was not refused with 400: $(printf '%s' "$plain" | head -n 1)" ;;
esac
if printf '%s' "$plain" | grep -qi '^location:'; then fail "plain HTTP on the web port redirects"; fi
headers=$(wcurl -s -D - -o /dev/null "$web/") || fail "GET / over HTTPS failed"
if printf '%s' "$headers" | grep -qi '^strict-transport-security:'; then
  fail "the web sends HSTS"
fi
docker compose logs --no-log-prefix pki 2>/dev/null | grep -q '^pki: dev CA sha256 ' ||
  fail "the pki step logged no dev CA fingerprint"
echo "ok: HTTPS only (dev CA trusted, untrusted without it; plain HTTP 400 without a redirect; no HSTS)"
code=$(wcurl -s -o /dev/null -w '%{http_code}' -H "Host: evil.test:${web##*:}" "$web/api/v1/equipment")
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
smoke_users=$SMOKE_USERNAME
echo "ok: user:create made the operator $SMOKE_USERNAME"
# With SMOKE_WRITES=1 also a supervisor (#178): it releases and dispatches one order and is refused
# an abandon while the command's run goes on. Disabled again by the exit trap.
if [ "${SMOKE_WRITES:-}" = 1 ]; then
  SMOKE_SUPERVISOR_USERNAME="smoke-sup-$(openssl rand -hex 4)"
  SMOKE_SUPERVISOR_PASSWORD=$(openssl rand -hex 16)
  export SMOKE_SUPERVISOR_USERNAME SMOKE_SUPERVISOR_PASSWORD
  printf '%s' "$SMOKE_SUPERVISOR_PASSWORD" | docker compose exec -T mes \
    node apps/mes-server/src/user-cli.ts --username "$SMOKE_SUPERVISOR_USERNAME" --role supervisor >/dev/null ||
    fail "user:create could not create the smoke supervisor"
  smoke_users="$smoke_users $SMOKE_SUPERVISOR_USERNAME"
  echo "ok: user:create made the supervisor $SMOKE_SUPERVISOR_USERNAME"
  # And a quality user (#204): it releases the supervisor's smoke hold and is refused a limit
  # version before version 1 exists. Disabled again by the exit trap.
  SMOKE_QUALITY_USERNAME="smoke-qa-$(openssl rand -hex 4)"
  SMOKE_QUALITY_PASSWORD=$(openssl rand -hex 16)
  export SMOKE_QUALITY_USERNAME SMOKE_QUALITY_PASSWORD
  printf '%s' "$SMOKE_QUALITY_PASSWORD" | docker compose exec -T mes \
    node apps/mes-server/src/user-cli.ts --username "$SMOKE_QUALITY_USERNAME" --role quality >/dev/null ||
    fail "user:create could not create the smoke quality user"
  smoke_users="$smoke_users $SMOKE_QUALITY_USERNAME"
  echo "ok: user:create made the quality user $SMOKE_QUALITY_USERNAME"
fi
NODE_EXTRA_CA_CERTS="$tls_dir/ca.pem" SMOKE_WEB_CERT="$tls_dir/server.pem" \
  node scripts/stack-smoke-web.mjs "$web" || fail "web checks failed"

# The console's /sim/ proxy (#237): anonymous 401, routes outside the allowlist 404 (the ground
# truth and the recorded run among them), a write from another origin 403; the token never comes
# back to the browser. The Playwright console run covers the roles and every action.
for path in /sim/api/v1/status /sim/api/v1/lots /sim/api/v1/scenarios; do
  code=$(wcurl -s -o /dev/null -w '%{http_code}' "$web$path")
  [ "$code" = 401 ] || fail "/sim/ answered $path anonymously ($code)"
done
for path in /sim/api/v1/ground-truth /sim/api/v1/scenario/recorded /sim/health/ready /sim/metrics; do
  code=$(wcurl -s -o /dev/null -w '%{http_code}' "$web$path")
  [ "$code" = 404 ] || fail "/sim/ proxied $path, outside its allowlist ($code)"
done
code=$(wcurl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://evil.test' "$web/sim/api/v1/pause")
[ "$code" = 403 ] || fail "/sim/ took a cross-origin write ($code)"
# The same host and port over http:// is another origin since P9-14 (nginx compares $scheme).
code=$(wcurl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: http://$web_address" "$web/sim/api/v1/pause")
[ "$code" = 403 ] || fail "/sim/ took a write from the http:// origin of the same host ($code)"
echo "ok: /sim/ allowlist (401 anonymous, 404 outside it, 403 cross-origin write)"

# Edge trust (#237): every request through nginx reached the MES over the edge network as
# mes-edge (trusted), none from anywhere else (untrusted), and the MES learned that network.
mes_metrics=$(in_container mes 4700 /metrics) || fail "MES metrics not reachable"
proxied_trusted=$(printf '%s\n' "$mes_metrics" |
  sed -n 's/^mes_http_proxy_requests_total{trusted="true"} \([0-9][0-9]*\)$/\1/p')
proxied_untrusted=$(printf '%s\n' "$mes_metrics" |
  sed -n 's/^mes_http_proxy_requests_total{trusted="false"} \([0-9][0-9]*\)$/\1/p')
[ -n "$proxied_trusted" ] && [ "$proxied_trusted" -gt 0 ] ||
  fail "no request through nginx arrived trusted at the MES (${proxied_trusted:-none})"
[ "$proxied_untrusted" = 0 ] ||
  fail "requests through nginx arrived untrusted at the MES (${proxied_untrusted:-none})"
docker compose logs mes 2>/dev/null | grep -q 'edge network learned' ||
  fail "the MES did not log its learned edge network"

# The edge network has no gateway (#237 review: inhibit_ipv4): no address in the trusted subnet
# outside nginx and the MES, neither on the bridge nor in its IPAM configuration.
mes_container=$(docker compose ps -q mes)
edge_network=$(docker inspect "$mes_container" \
  --format '{{range $name, $net := .NetworkSettings.Networks}}{{println $name}}{{end}}' | grep '_edge$' || true)
[ -n "$edge_network" ] || fail "the MES is not on the edge network"
# JSON forms: a plain template prints an unset address field as "invalid IP".
edge_settings=$(docker network inspect "$edge_network" \
  --format '{{json .IPAM.Config}}|{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}|{{.Internal}}')
case "$edge_settings" in
  *'"Gateway"'*) fail "the edge network has an IPAM gateway ($edge_settings)" ;;
  *'|true|true') ;;
  *) fail "the edge network is not internal with inhibit_ipv4 ($edge_settings)" ;;
esac
for service in mes web; do
  endpoint=$(docker inspect "$(docker compose ps -q "$service")" \
    --format "{{json (index .NetworkSettings.Networks \"$edge_network\")}}")
  case "$endpoint" in
    *'"Gateway":""'*) ;;
    *) fail "$service has a gateway on the edge network ($endpoint)" ;;
  esac
done
echo "ok: edge network internal, without a gateway (IPAM and endpoints)"

# A client's X-Original-Method never reaches the MES through /api/ (#237 review): nginx clears it,
# so a GET of the permission check with `X-Original-Method: POST` doesn't count as session use.
# The smoke operator's sessions are set five minutes back (as the superuser); the check (403 for
# an operator, after the session lookup) must leave them there, and a plain read must move them.
smoke_cookie=$(printf '{"username":"%s","password":"%s"}' "$SMOKE_USERNAME" "$SMOKE_PASSWORD" |
  wcurl -s -o /dev/null -D - -H "Origin: $web" -H 'Content-Type: application/json' \
    --data-binary @- "$web/api/v1/session" |
  sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-sft_session=[^;]*\).*/\1/p')
[ -n "$smoke_cookie" ] || fail "could not log in as $SMOKE_USERNAME for the X-Original-Method check"
as_super() {
  docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -Atc "$1"
}
back_dated="update identity.session s set last_used_at = now() - interval '5 minutes'
  from identity.user_account u where u.id = s.user_id and u.username = '$SMOKE_USERNAME'
  and s.ended_at is null"
latest_use="select max(s.last_used_at) > now() - interval '1 minute' from identity.session s
  join identity.user_account u on u.id = s.user_id
  where u.username = '$SMOKE_USERNAME' and s.ended_at is null"
as_super "$back_dated" >/dev/null
code=$(printf 'Cookie: %s\n' "$smoke_cookie" | wcurl -s -o /dev/null -w '%{http_code}' -H @- \
  -H 'X-Original-Method: POST' "$web/api/v1/session/permission/sim:control")
[ "$code" = 403 ] || fail "the permission check answered the operator $code, not 403"
[ "$(as_super "$latest_use")" = f ] ||
  fail "a client's X-Original-Method through /api/ counted as session use"
printf 'Cookie: %s\n' "$smoke_cookie" | wcurl -sf -o /dev/null -H @- "$web/api/v1/session" ||
  fail "the smoke operator's session read failed"
[ "$(as_super "$latest_use")" = t ] || fail "a session read through /api/ did not count as use"
echo "ok: a client's X-Original-Method through /api/ is dropped (no session use; a read is use)"
echo "ok: edge trust ($proxied_trusted proxied requests trusted, 0 untrusted)"
