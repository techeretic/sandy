#!/usr/bin/env bash
#
# Sandbox conformance matrix (SB-09/10) — the runtime-agnosticity proof.
#
# The enforcer is written once, runtime-agnostic: it detects whatever boundary
# it is in, reports what it has/lost, and confines paths + egress. SB-10 says
# conformance must hold across sandbox implementations, expressed as a
# capability manifest, not per-platform code. This script PROVES that claim:
#
#   the SAME config + the SAME request are run under a Docker container AND
#   under a Firejail jail (both with NO external egress — the Docker `--network
#   none` / Firejail `--net=none` analog of the egress harness's internal
#   network). For each boundary we assert `sandy check` and `sandy run`
#   succeed with a healthy report and a confined, provenance-tracked report;
#   then we assert the two boundaries produce BYTE-IDENTICAL behavioral
#   signatures. Same input, same behavior, different enforcing boundary.
#
# stdio MCP is used (not HTTP) so the fixture needs no network — the matrix
# isolates boundary behavior (detection / capability report / confinement /
# provenance) from egress, which `conformance/run-docker.sh` covers.
#
# The "behavior signature" is the runtime-agnostic projection (see
# signature.mjs): ok / degraded / lost / summary / allowlist / MCP fleet /
# provenance (claim text + server + tool + argsHash). It deliberately excludes
# the fields that are legitimately runtime-specific (the detected runtime name
# + evidence, absolute workspace paths, wall-clock timestamps, durations).
#
# Modes (env):
#   SANDY_MATRIX=docker     run only the Docker boundary (used by CI matrix)
#   SANDY_MATRIX=firejail   run only the Firejail boundary (used by CI matrix)
#   (unset)                 run BOTH and prove they are identical (default)
#
# Run:  npm run conformance:sandbox
#   (or: bash conformance/sandbox-matrix.sh)

set -euo pipefail

# A missing optional boundary is not a failure — it's reported and skipped, so
# the suite stays green on hosts without Docker and/or Firejail. Set
# SANDY_REQUIRE=1 to fail closed when a boundary is missing (CI uses this).
MODE="${SANDY_MATRIX:-}"
REQUIRE="${SANDY_REQUIRE:-0}"

IMAGE="sandy-matrix"
log()  { printf '\033[1;34m[matrix]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[matrix] SKIP:\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[matrix] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

have_docker()   { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
have_firejail() { command -v firejail >/dev/null 2>&1; }

want_docker()   { [ "$MODE" = "docker" ] || [ -z "$MODE" ]; }
want_firejail() { [ "$MODE" = "firejail" ] || [ -z "$MODE" ]; }

OUT="$(mktemp -d /tmp/sandy-matrix-XXXXXX)"
WS_DOCKER="$(mktemp -d /tmp/sandy-ws-docker-XXXXXX)"
WS_FJ="$(mktemp -d /tmp/sandy-ws-fj-XXXXXX)"
rm -rf "$WS_DOCKER" "$WS_FJ"
# Stable artifact path: each matrix leg (docker / firejail) writes its behavior
# signature here, so a downstream CI job can download both and prove they are
# identical. On a local all-in-one run the in-script cross-check is authoritative.
SIGDIR="${SANDY_SIG_DIR:-/tmp/sandy-matrix-sigs}"
cleanup() {
  docker network rm "sandy-matrix-net" >/dev/null 2>&1 || true
  rm -rf "$OUT" "$WS_DOCKER" "$WS_FJ"
  # Keep the durable signature artifact at $SIGDIR; only remove the scratch dirs.
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# write_workspace <physical-dir> <runtime> <fixture-absolute-path> <declared-root>
# Writes the config + request into <physical-dir>. The config is byte-identical
# across boundaries EXCEPT two fields that are pure environment specifics (where
# the workspace physically lives), and BOTH are excluded from the behavioral
# signature:
#   - sandbox.allowed_paths = <declared-root>
#       Docker: "/ws" (the container mount point); Firejail: the host path.
#   - the stdio command's fixture path
#       Docker: /app/conformance/stdio-server.mjs; Firejail: the repo path.
# The request, mode, llm, network, policy — everything the behavior depends on —
# is identical, which is what the cross-boundary assertion is about.
write_workspace() {
  local ws="$1" runtime="$2" fixture="$3" root="$4"
  mkdir -p "$ws/reports"
  cat > "$ws/mcp-servers.json" <<JSON
{ "servers": [ { "name": "crm", "transport": "stdio",
  "command": ["node", "${fixture}"],
  "version": "1.0.0", "capabilities": ["read_deals"], "allowed_tools": ["read_deals"] } ] }
JSON
  cat > "$ws/sandy.json" <<JSON
{ "mode": "plugin", "llm": { "provider": "host" },
  "sandbox": { "runtime": "${runtime}", "allowed_paths": ["${root}"],
    "allowed_network": [], "max_memory_mb": 512, "max_cpu_percent": 25 },
  "mcp_servers": "./mcp-servers.json", "report_output_dir": "./reports",
  "policy": { "confirmation_required": ["delete","overwrite"], "undo_depth": 5,
    "dry_run_default": false, "audit_payload_logging": false, "ignore_patterns": [] } }
JSON
  cat > "$ws/request.json" <<JSON
{ "goal": "deals", "gather": [ { "id": "deals", "server": "crm", "tool": "read_deals", "args": { "region": "emea" } } ],
  "report": { "title": "EMEA Deals", "file": "emea.md" } }
JSON
}

# run_and_assert <label> <ws> <check.json> <run.json> <report-path>
# Run check + run (already captured by the caller into the given files is NOT
# the contract here — the caller pipes sandy output to these files), then
# assert the behavior and write the signature. The caller supplies the files;
# this function asserts on them.
assert_behavior() {
  local label="$1" checkf="$2" runf="$3" ws="$4"
  grep -q '"ok": true'        "$checkf" || fail "[$label] check did not report ok:true"
  grep -q '"degraded": false' "$checkf" || fail "[$label] check reported a degraded (reduced) sandbox"
  grep -q '"crm"'             "$checkf" || fail "[$label] crm server did not connect"
  grep -q '"claims": \['      "$runf"   || fail "[$label] run produced no claims"
  grep -q '2 deals closed in emea' "$runf" || fail "[$label] run did not return the expected claim"
  ls "$ws/reports" | grep -q '\.md'   || fail "[$label] no report was written to the confined reports dir"
  mkdir -p "$SIGDIR"
  node conformance/signature.mjs "$checkf" "$runf" | tee "$OUT/${label}.sig" > "${SIGDIR}/${label}.sig"
}

ran_any=0
skipped=()

# ------------------------------- DOCKER ------------------------------------
if want_docker; then
  if ! have_docker; then
    if [ "$REQUIRE" = "1" ]; then fail "docker is required (SANDY_REQUIRE=1) but the daemon is unavailable"; fi
    skipped+=("docker: docker unavailable")
  else
    ran_any=1
    log "Docker boundary: building image ${IMAGE}"
    docker build -q -t "$IMAGE" -f conformance/Dockerfile . >/dev/null || fail "image build failed"
    write_workspace "$WS_DOCKER" "docker" "/app/conformance/stdio-server.mjs" "/ws"
    docker network create "sandy-matrix-net" >/dev/null

    log "Docker: sandy check (no external egress)"
    set +e
    docker run --rm --network "sandy-matrix-net" -v "${WS_DOCKER}:/ws" -w /ws \
      "$IMAGE" node /app/bin/sandy.js check --config sandy.json --no-progress --json > "$OUT/docker.check.json" 2> "$OUT/docker.check.err"
    RC_CHECK=$?
    set -e
    [ "$RC_CHECK" -eq 0 ] || { cat "$OUT/docker.check.err"; fail "docker check exited ${RC_CHECK}"; }

    log "Docker: sandy run (no external egress)"
    set +e
    docker run --rm --network "sandy-matrix-net" -v "${WS_DOCKER}:/ws" -w /ws \
      "$IMAGE" node /app/bin/sandy.js run request.json --config sandy.json --no-progress --json > "$OUT/docker.run.json" 2> "$OUT/docker.run.err"
    RC_RUN=$?
    set -e
    [ "$RC_RUN" -eq 0 ] || { cat "$OUT/docker.run.err"; fail "docker run exited ${RC_RUN}"; }

    assert_behavior "docker" "$OUT/docker.check.json" "$OUT/docker.run.json" "$WS_DOCKER"
    log "Docker boundary: PASS (check ok, run produced a confined provenance-tracked report)"
  fi
fi

# ------------------------------ FIREJAIL -----------------------------------
if want_firejail; then
  if ! have_firejail; then
    if [ "$REQUIRE" = "1" ]; then fail "firejail is required (SANDY_REQUIRE=1) but not on PATH"; fi
    skipped+=("firejail: not installed")
  else
    ran_any=1
    # Non-root firejail: host paths resolve inside the jail, so the fixture is
    # the repo's own file and the workspace lives under /tmp (both visible in
    # the default jail without root-only --bind).
    write_workspace "$WS_FJ" "firejail" "${ROOT}/conformance/stdio-server.mjs" "$WS_FJ"
    # Absolute node path so it resolves inside the jail regardless of PATH.
    NODE_BIN="$(command -v node)"
    run_fj() { firejail --quiet --net=none -- "$NODE_BIN" bin/sandy.js "$@"; }

    log "Firejail: sandy check (no external egress)"
    set +e
    run_fj check --config "$WS_FJ/sandy.json" --no-progress --json > "$OUT/firejail.check.json" 2> "$OUT/firejail.check.err"
    RC_CHECK=$?
    set -e
    [ "$RC_CHECK" -eq 0 ] || { cat "$OUT/firejail.check.err"; fail "firejail check exited ${RC_CHECK}"; }

    log "Firejail: sandy run (no external egress)"
    set +e
    run_fj run "$WS_FJ/request.json" --config "$WS_FJ/sandy.json" --no-progress --json > "$OUT/firejail.run.json" 2> "$OUT/firejail.run.err"
    RC_RUN=$?
    set -e
    [ "$RC_RUN" -eq 0 ] || { cat "$OUT/firejail.run.err"; fail "firejail run exited ${RC_RUN}"; }

    assert_behavior "firejail" "$OUT/firejail.check.json" "$OUT/firejail.run.json" "$WS_FJ"
    log "Firejail boundary: PASS (check ok, run produced a confined provenance-tracked report)"
  fi
fi

# --------------------------- CROSS-Boundary --------------------------------
if [ "$MODE" = "" ]; then
  if [ "$ran_any" -eq 0 ]; then
    fail "neither docker nor firejail is available; cannot run the matrix"
  fi
  if [ -f "$OUT/docker.sig" ] && [ -f "$OUT/firejail.sig" ]; then
    log "proving the two boundaries behave identically (byte-identical signature)"
    if diff -u "$OUT/docker.sig" "$OUT/firejail.sig"; then
      log "signatures are identical"
    else
      fail "Docker and Firejail produced DIFFERENT behavior signatures (enforcer is not runtime-agnostic)"
    fi
    cat "$OUT/docker.sig" | sed 's/^/    /'
  else
    warn "only one boundary was available; cross-boundary comparison skipped"
  fi
fi

for s in "${skipped[@]:-}"; do
  if [ -n "$s" ]; then warn "$s"; fi
done
if [ "$ran_any" -eq 0 ]; then
  warn "no boundary ran (all skipped); nothing to prove"
  exit 0
fi
if [ "$MODE" = "" ]; then
  log "PASS — sandbox conformance: Docker + Firejail are behaviorally identical"
else
  log "PASS — sandbox conformance: the ${MODE} boundary conforms"
fi
