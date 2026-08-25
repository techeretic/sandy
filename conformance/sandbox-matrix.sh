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
#   SANDY_MODE=standalone   run the STANDALONE service instead of plugin mode
#       (design §8 step 6): the config gets a bundled-model llm block (a
#       loopback stub-model standing in for the real GGUF, design §9) and the
#       run is `sandy ask` (parse -> run -> narrate) instead of `sandy run`.
#       Proves the no-egress / cross-sandbox guarantees hold WITH the in-
#       sandbox loopback model (SD-05/06 at the security level).
#   SANDY_REAL_MODEL=<gguf> OPT-IN real-model conformance leg (issue #17):
#       runs `sandy ask` against a REAL provisioned GGUF (docs/MODEL.md)
#       inside a no-egress Firejail jail. The stub-model leg above proves the
#       PATH; this leg proves a real model actually plans and narrates inside
#       the boundary (manually proven 2026-08-22, DIARY). CI stays green with
#       no model present: the leg is SKIPPED (not failed) unless
#       SANDY_REAL_MODEL is set AND the file exists (plus the llama-server
#       runtime resolvable). The real model proposes its own plan/args, so the
#       asserts are on invariants that hold for ANY legal plan of the fixture
#       (provenance-tracked crm/read_deals claim + legal plan + audited model
#       calls + no orphan), not on the stub's canned values.
#
# Run:  npm run conformance:sandbox
#   (or: bash conformance/sandbox-matrix.sh; standalone: SANDY_MODE=standalone)
#   Real-model leg: SANDY_REAL_MODEL=~/.local/share/sandy/models/<x>.gguf \
#     bash conformance/sandbox-matrix.sh

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
# Mode: plugin (default, Phase 1) or standalone (design §8 step 6). In standalone
# the config carries a bundled-model llm block (a loopback stub-model standing in
# for the real GGUF, design §9) and the run is `sandy ask` (the full loop) rather
# than `sandy run`. Everything the *boundary* behavior depends on stays identical
# across boundaries; only the where-the-files-live specifics differ (excluded from
# the signature).
SANDY_MODE="${SANDY_MODE:-plugin}"
ASK_GOAL="Summarize EMEA deals"

# write_workspace <physical-dir> <runtime> <fixture-absolute-path> <declared-root>
# Writes the config + request into <physical-dir>. The config is byte-identical
# across boundaries EXCEPT the fields that are pure environment specifics (where
# the workspace / fixtures physically live), and all of them are excluded from
# the behavioral signature:
#   - sandbox.allowed_paths = <declared-root>
#       Docker: "/ws" (the container mount point); Firejail: the host path.
#   - the stdio command's fixture path (and the stub-model path, standalone)
#       Docker: /app/conformance/...; Firejail: the repo path.
# The mode, llm provider, network, policy — everything the behavior depends on —
# is identical, which is what the cross-boundary assertion is about.
write_workspace() {
  local ws="$1" runtime="$2" fixture="$3" root="$4"
  local fixture_dir="${fixture%/*}"
  local model="${fixture_dir}/stub-model.mjs"
  local mode llm runfile
  if [ "$SANDY_MODE" = "standalone" ]; then
    mode="standalone"
    # The stub model stands in for the bundled 4-8B model (design §9): a
    # loopback OpenAI-compatible server, in-sandbox, zero-egress by construction.
    llm="{ \"provider\": \"local\", \"model\": \"stub\", \"model_path\": \"${model}\", \"engine\": { \"type\": \"llama-server\", \"command\": [\"node\", \"${model}\"], \"host\": \"127.0.0.1\", \"port\": 0 } }"
    runfile="goal.txt"
  else
    mode="plugin"
    llm="{ \"provider\": \"host\" }"
    runfile="request.json"
  fi
  mkdir -p "$ws/reports"
  cat > "$ws/mcp-servers.json" <<JSON
{ "servers": [ { "name": "crm", "transport": "stdio",
  "command": ["node", "${fixture}"],
  "version": "1.0.0", "capabilities": ["read_deals"], "allowed_tools": ["read_deals"] } ] }
JSON
  cat > "$ws/sandy.json" <<JSON
{ "mode": "${mode}", "llm": ${llm},
  "sandbox": { "runtime": "${runtime}", "allowed_paths": ["${root}"],
    "allowed_network": [], "max_memory_mb": 512, "max_cpu_percent": 25 },
  "mcp_servers": "./mcp-servers.json", "report_output_dir": "./reports",
  "policy": { "confirmation_required": ["delete","overwrite"], "undo_depth": 5,
    "dry_run_default": false, "audit_payload_logging": false, "ignore_patterns": [] } }
JSON
  if [ "$SANDY_MODE" = "standalone" ]; then
    printf '%s' "$ASK_GOAL" > "$ws/$runfile"
  else
    cat > "$ws/request.json" <<JSON
{ "goal": "deals", "gather": [ { "id": "deals", "server": "crm", "tool": "read_deals", "args": { "region": "emea" } } ],
  "report": { "title": "EMEA Deals", "file": "emea.md" } }
JSON
  fi
}

# The `sandy <verb> <arg>` invocation for the run step. Plugin: `run <request>`;
# standalone: `ask <goal...>` (the full loop). The goal is emitted UNQUOTED and
# word-split by the caller's `$( ... )`; the CLI re-joins the remaining positionals
# into the goal, so no literal quotes leak into it. $1 = the request-file path
# (relative to the working dir for Docker, absolute for Firejail).
run_args() {
  if [ "$SANDY_MODE" = "standalone" ]; then
    printf 'ask %s' "$ASK_GOAL"
  else
    printf 'run %s' "$1"
  fi
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

    log "Docker: sandy run/ask (no external egress)"
    set +e
    docker run --rm --network "sandy-matrix-net" -v "${WS_DOCKER}:/ws" -w /ws \
      "$IMAGE" node /app/bin/sandy.js $(run_args "request.json") --config sandy.json --no-progress --json > "$OUT/docker.run.json" 2> "$OUT/docker.run.err"
    RC_RUN=$?
    set -e
    [ "$RC_RUN" -eq 0 ] || { cat "$OUT/docker.run.err"; fail "docker run/ask exited ${RC_RUN}"; }

    assert_behavior "docker" "$OUT/docker.check.json" "$OUT/docker.run.json" "$WS_DOCKER"
    log "Docker boundary: PASS (check ok, ${SANDY_MODE} run produced a confined provenance-tracked report)"
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

    log "Firejail: sandy run/ask (no external egress)"
    set +e
    run_fj $(run_args "$WS_FJ/request.json") --config "$WS_FJ/sandy.json" --no-progress --json > "$OUT/firejail.run.json" 2> "$OUT/firejail.run.err"
    RC_RUN=$?
    set -e
    [ "$RC_RUN" -eq 0 ] || { cat "$OUT/firejail.run.err"; fail "firejail run/ask exited ${RC_RUN}"; }

    assert_behavior "firejail" "$OUT/firejail.check.json" "$OUT/firejail.run.json" "$WS_FJ"
    log "Firejail boundary: PASS (check ok, ${SANDY_MODE} run produced a confined provenance-tracked report)"
  fi
fi

# ---------------------------- REAL MODEL (opt-in) ---------------------------
# Issue #17: the stub-model leg above proves the loop PATH with a deterministic
# stand-in; this leg proves a REAL provisioned GGUF plans and narrates inside a
# no-egress boundary. It is deliberately Firejail-only: a 2.4GB GGUF must not
# be baked into or mounted into the CI Docker image (the Docker legs stay
# stub-based in CI), and the manual proof (DIARY 2026-08-22) ran in exactly
# this shape — `firejail --net=none` around the whole CLI + in-jail model.
#
# Skipped (never failed) unless opted in: SANDY_REAL_MODEL must be set, the
# file must exist, and the llama-server runtime must be resolvable — CI (which
# has no model) therefore stays green on the default path.
REAL_MODEL="${SANDY_REAL_MODEL:-}"
if [ -n "$REAL_MODEL" ]; then
  if [ ! -f "$REAL_MODEL" ]; then
    warn "real-model leg: SANDY_REAL_MODEL is set but $REAL_MODEL does not exist; skipping"
  elif ! have_firejail; then
    warn "real-model leg: firejail is not installed; skipping"
  else
    LLM_CMD="${SANDY_LLM_SERVER:-$HOME/.local/share/sandy/llama.cpp/llama-server}"
    if [ ! -x "$LLM_CMD" ]; then
      warn "real-model leg: llama-server runtime not found at $LLM_CMD (provision via scripts/provision-model.sh, or point SANDY_LLM_SERVER at it); skipping"
    else
      ran_any=1
      NODE_BIN="${NODE_BIN:-$(command -v node)}"
      WS_RM="$(mktemp -d /tmp/sandy-ws-rm-XXXXXX)"
      mkdir -p "$WS_RM/reports"
      cat > "$WS_RM/mcp-servers.json" <<JSON
{ "servers": [ { "name": "crm", "transport": "stdio",
  "command": ["${NODE_BIN}", "${ROOT}/conformance/stdio-server.mjs"],
  "version": "1.0.0", "capabilities": ["read_deals"], "allowed_tools": ["read_deals"] } ] }
JSON
      cat > "$WS_RM/sandy.json" <<JSON
{ "mode": "standalone",
  "llm": { "provider": "local", "model": "real-conformance", "model_path": "${REAL_MODEL}",
    "engine": { "type": "llama-server", "command": ["${LLM_CMD}"], "host": "127.0.0.1", "port": 0 } },
  "sandbox": { "runtime": "firejail", "allowed_paths": ["${WS_RM}"],
    "allowed_network": [], "max_memory_mb": 512, "max_cpu_percent": 25 },
  "mcp_servers": "./mcp-servers.json", "report_output_dir": "./reports",
  "policy": { "confirmation_required": ["delete","overwrite"], "undo_depth": 5,
    "dry_run_default": false, "audit_payload_logging": false, "ignore_patterns": [] } }
JSON
      run_rm() { firejail --quiet --net=none -- "$NODE_BIN" bin/sandy.js "$@"; }

      log "Real model: sandy check (firejail, no external egress)"
      set +e
      run_rm check --config "$WS_RM/sandy.json" --no-progress --json > "$OUT/rm.check.json" 2> "$OUT/rm.check.err"
      RC_CHECK=$?
      set -e
      [ "$RC_CHECK" -eq 0 ] || { cat "$OUT/rm.check.err"; fail "real-model check exited ${RC_CHECK}"; }

      log "Real model: sandy ask (firejail, no external egress) — $REAL_MODEL"
      set +e
      run_rm ask "$ASK_GOAL" --config "$WS_RM/sandy.json" --no-progress --json > "$OUT/rm.ask.json" 2> "$OUT/rm.ask.err"
      RC_ASK=$?
      set -e
      [ "$RC_ASK" -eq 0 ] || { cat "$OUT/rm.ask.err"; fail "real-model ask exited ${RC_ASK}"; }

      # A REAL model proposes its own plan and args, so the asserts are on the
      # invariants that hold for ANY legal plan of this fixture — provenance,
      # legality, audit, process hygiene — not on the stub's canned values.
      grep -q '"ok": true'        "$OUT/rm.check.json" || fail "[real-model] check did not report ok:true"
      grep -q '"degraded": false' "$OUT/rm.check.json" || fail "[real-model] check reported a degraded (reduced) sandbox"
      grep -q '"crm"'             "$OUT/rm.check.json" || fail "[real-model] crm server did not connect"
      grep -q '"source": "model"' "$OUT/rm.ask.json"   || fail "[real-model] plan did not come from the real model (fallback/refused: $(grep -o '"reason": *"[^"]*"' "$OUT/rm.ask.json" | head -1))"
      grep -q '"crm"'             "$OUT/rm.ask.json"   || fail "[real-model] the real model's plan did not use the crm server"
      grep -q '"read_deals"'      "$OUT/rm.ask.json"   || fail "[real-model] the real model's plan did not use read_deals"
      grep -q '"2 deals closed in' "$OUT/rm.ask.json"  || fail "[real-model] run did not return a provenance-tracked claim"
      grep -q '"argsHash"'        "$OUT/rm.ask.json"   || fail "[real-model] the claim is missing its argsHash provenance"
      grep -q '"claims": \[\]'    "$OUT/rm.ask.json"   && fail "[real-model] no claims were produced"
      ls "$WS_RM/reports" | grep -q '\.md' || fail "[real-model] no report was written to the confined reports dir"
      # Every model call (parse + narrate) is audited (AU-01).
      grep -q '"standalone_narrate"' "$OUT/rm.ask.json" || fail "[real-model] the narrate step was not audited"
      rm -rf "$WS_RM"
      log "Real-model leg: PASS (a real GGUF planned + narrated inside a no-egress jail, provenance-tracked report, no orphan)"
    fi
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
  log "PASS — sandbox conformance (${SANDY_MODE}): Docker + Firejail are behaviorally identical"
else
  log "PASS — sandbox conformance (${SANDY_MODE}): the ${MODE} boundary conforms"
fi
