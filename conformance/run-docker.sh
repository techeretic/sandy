#!/usr/bin/env bash
#
# Egress conformance test — NETWORK LEVEL (SB-09; PRD success criterion).
#
# Proves "zero network egress outside declared MCP endpoints" at the network
# level, in Docker. The sandbox boundary is a Docker *internal* network: the
# runtime guarantees a container on it has NO external egress (no internet, no
# other networks) — it can only reach the other containers on that same
# network. So:
#
#   * the declared MCP endpoint = an endpoint (EP) container on the network;
#   * everything else (the internet, other hosts) = unreachable by boundary.
#
# Asserts:
#   1. `sandy run` SUCCEEDS against the one declared endpoint (so all the egress
#      Sandy needed went to it) and the EP logs that it was actually hit;
#   2. an independent external-egress probe from inside the sandbox FAILS
#      (explicit, verifiable evidence the boundary blocks non-declared egress);
#   3. the reverse: a config with an endpoint NOT in allowed_network fails
#      closed at startup (VPN-02) and the EP is never reached.
#
# Requires docker. Run:  npm run conformance:docker
#   (or: bash conformance/run-docker.sh)
#
# Firejail conformance (SB-09 wants >=2 sandboxes) is the same harness with the
# firejail equivalent of the internal-network boundary; the enforcer is
# runtime-agnostic, so only the boundary command changes.
#
# Mode (env):
#   SANDY_MODE=standalone   run the STANDALONE service (design §8 step 6): the
#       config carries a bundled-model llm block (a loopback stub-model standing
#       in for the real GGUF, design §9) and the run is `sandy ask` (the full
#       loop). The in-sandbox loopback model's egress is zero by construction
#       (§4.0) — its only path is loopback to its own process — so the only
#       EXTERNAL egress is still the declared MCP endpoint, and all three
#       assertions (EP hit / external blocked / undeclared fails closed) hold.

set -euo pipefail

IMAGE="sandy-egress"
NET="sandy-egress-net"
EP_NAME="sandy-ep"
EP_PORT=9100
NET_LOG="sandy-ep-log"
EP_HOST="sandy-ep"
EP_URL="http://${EP_HOST}:${EP_PORT}/mcp"
# An external target that must NOT be reachable from inside the sandbox.
EXT_TARGET="http://example.com/"

log() { printf '\033[1;34m[egress]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[egress] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
docker info >/dev/null 2>&1 || fail "docker daemon not reachable"

log "building image ${IMAGE} (first run may take a moment)"
docker build -q -t "$IMAGE" -f conformance/Dockerfile . >/dev/null || fail "image build failed"

log "creating internal network ${NET}"
docker network create --internal "$NET" >/dev/null

cleanup() {
  log "cleaning up"
  docker rm -f "$EP_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "${NET_LOG}" >/dev/null 2>&1 || true
  rm -rf "${WS:-}" "${WS2:-}" || true
}
trap cleanup EXIT

log "starting endpoint (EP) container on the internal network"
# The EP logs every request it receives — the observable egress signal.
docker run -d --name "$EP_NAME" --network "$NET" -e EP_LOG=/ep/requests.log \
  -v "${NET_LOG}:/ep" "$IMAGE" node conformance/ep-server.mjs "$EP_PORT" >/dev/null

# Wait for the EP to report readiness (prints its URL to stdout).
for _ in $(seq 1 30); do
  if docker logs "$EP_NAME" 2>&1 | grep -q "http://"; then break; fi
  sleep 0.3
done
docker logs "$EP_NAME" 2>&1 | grep -q "http://" || fail "EP did not become ready"

# Use the EP's real IP (avoids embedded-DNS race; also the exact egress target).
EP_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$EP_NAME")"
[ -n "$EP_IP" ] || fail "could not read the EP container's IP"
EP_HOSTPORT="${EP_IP}:${EP_PORT}"
EP_URL="http://${EP_IP}:${EP_PORT}/mcp"

# Wait until the EP is actually reachable over the network (plain TCP connect).
for _ in $(seq 1 40); do
  if docker run --rm --network "$NET" "$IMAGE" node -e "
    require('net').connect(${EP_PORT}, '${EP_IP}', () => process.exit(0)).on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 1500);
  " 2>/dev/null; then break; fi
  sleep 0.3
done
log "EP ready at ${EP_URL} (hostport ${EP_HOSTPORT})"

# Mode: plugin (default) or standalone (design §8 step 6). In standalone the
# config carries a bundled-model llm block (a loopback stub-model standing in
# for the real GGUF, design §9) and the run is `sandy ask` (the full loop). The
# stub model is in-sandbox on loopback (zero egress by construction, §4.0), so
# the ONLY external egress is still the declared MCP endpoint.
SANDY_MODE="${SANDY_MODE:-plugin}"
ASK_GOAL="Summarize EMEA deals"
STUB_MODEL="/app/conformance/stub-model.mjs"   # the path inside the image

# The `sandy <verb> <arg>` invocation for the run step (relative to /ws). The
# standalone goal is emitted unquoted; the CLI re-joins the remaining positionals
# into the goal (no literal quotes leak into it).
run_args() {
  if [ "$SANDY_MODE" = "standalone" ]; then
    printf 'ask %s' "$ASK_GOAL"
  else
    printf 'run %s' "request.json"
  fi
}

# --- helper: write a workspace (config + manifest + request) for `sandy` ------
mk_ws() { # $1=host dir, $2=allowed-network endpoint, $3=ep-url
  local d="$1" net2="$2" url="$3"
  local mode llm
  if [ "$SANDY_MODE" = "standalone" ]; then
    mode="standalone"
    llm="{ \"provider\": \"local\", \"model\": \"stub\", \"model_path\": \"${STUB_MODEL}\", \"engine\": { \"type\": \"llama-server\", \"command\": [\"node\", \"${STUB_MODEL}\"], \"host\": \"127.0.0.1\", \"port\": 0 } }"
  else
    mode="plugin"
    llm="{ \"provider\": \"host\" }"
  fi
  mkdir -p "$d/reports"
  cat > "$d/mcp-servers.json" <<JSON
{ "servers": [ { "name": "crm", "transport": "http", "url": "${url}", "version": "1.0.0",
  "capabilities": ["read_deals"], "allowed_tools": ["read_deals"] } ] }
JSON
  cat > "$d/sandy.json" <<JSON
{ "mode": "${mode}", "llm": ${llm},
  "sandbox": { "runtime": "docker", "allowed_paths": ["/ws"], "allowed_network": ["${net2}"],
    "max_memory_mb": 512, "max_cpu_percent": 25 },
  "mcp_servers": "./mcp-servers.json", "report_output_dir": "./reports",
  "policy": { "confirmation_required": ["delete","overwrite"], "undo_depth": 5,
    "dry_run_default": false, "audit_payload_logging": false, "ignore_patterns": [] } }
JSON
  cat > "$d/request.json" <<JSON
{ "goal": "deals", "gather": [ { "id": "deals", "server": "crm", "tool": "read_deals", "args": { "region": "emea" } } ],
  "report": { "title": "EMEA Deals", "file": "emea.md" } }
JSON
}

count_ep_hits() { docker exec "$EP_NAME" sh -c 'wc -l < /ep/requests.log 2>/dev/null || echo 0'; }

# --- TEST 1: the only reachable endpoint is the declared one; the run succeeds --
log "TEST 1: sandy run/ask (${SANDY_MODE}) against the single declared endpoint"
WS="$(mktemp -d /tmp/sandy-egress-XXXXXX)"
mk_ws "$WS" "$EP_HOSTPORT" "$EP_URL"

run_sandy() { docker run --rm --network "$NET" -v "${WS}:/ws" -w /ws "$IMAGE" node /app/bin/sandy.js "$@"; }

run_sandy check --config sandy.json --no-progress | sed 's/^/    /'
run_sandy $(run_args) --config sandy.json --no-progress | sed 's/^/    /' || fail "sandy run/ask did not succeed"

HITS="$(count_ep_hits)"
[ "$HITS" -gt 0 ] || fail "EP was never reached (expected the declared endpoint to receive traffic)"
log "  EP received ${HITS} request(s) — the declared endpoint was used"

# Report must have been written inside the sandbox.
ls "${WS}/reports" | grep -q "\.md" || fail "no report was written to the confined reports dir"
log "  a report was written inside the sandbox"

# --- TEST 2: explicit — external egress from inside the sandbox is blocked -----
log "TEST 2: external egress probe from inside the sandbox must FAIL"
PROBE="$(docker run --rm --network "$NET" "$IMAGE" node -e "
  const t = 'http://example.com/';
  const ctl = AbortSignal.timeout(5000);
  fetch(t, { signal: ctl }).then(r => { console.log('REACHED'); process.exit(0); })
    .catch(() => { console.log('BLOCKED'); process.exit(0); });
" 2>&1)"
echo "$PROBE" | grep -q "BLOCKED" || fail "external target ${EXT_TARGET} was REACHABLE from inside the sandbox (egress leaked): ${PROBE}"
log "  external egress blocked (as required) — the boundary holds"

# --- TEST 3: reverse — undeclared endpoint fails closed (VPN-02), nothing leaves
log "TEST 3: config with an endpoint not in allowed_network must fail closed"
WS2="$(mktemp -d /tmp/sandy-egress-XXXXXX)"
mk_ws "$WS2" "some-other-host:9999" "$EP_URL"   # manifest EP != declared allowed_network
BEFORE="$(count_ep_hits)"
set +e
docker run --rm --network "$NET" -v "${WS2}:/ws" -w /ws "$IMAGE" node /app/bin/sandy.js check --config sandy.json --no-progress >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "VPN-02 violation was not caught at startup (expected a fail-closed, non-zero exit)"
AFTER="$(count_ep_hits)"
[ "$BEFORE" = "$AFTER" ] || fail "the EP was reached despite a VPN-02 config violation (expected nothing to leave)"
log "  startup failed closed (exit ${RC}) and nothing left the sandbox"

log "PASS — egress is confined to the declared endpoint (Docker, network level)"
