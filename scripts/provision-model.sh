#!/usr/bin/env bash
#
# Model + runtime provisioning — an INSTALL-TIME, out-of-band step.
#
# This is NOT part of the runtime. The Sandy runtime never downloads anything:
# it only READS a GGUF from disk (model_path) and spawns a local server on
# loopback, so model provisioning can never become an egress path (design §4.0).
# You run this once, on a machine that HAS internet, then copy the artifacts
# into an air-gapped host (or just point the config at the paths here).
#
# What it installs:
#   1. llama.cpp `llama-server` (a GPU/CPU backend that needs no CUDA toolkit:
#      the default variant is Vulkan, which drives an NVIDIA/AMD/Intel GPU
#      through the standard driver; a CPU-only variant is also available).
#   2. The documented default model (design §7 #2): Qwen3-4B-Instruct-2507,
#      Q4_K_M GGUF (Apache-2.0, ~2.4GB), SHA256-pinned and verified fail-closed.
#
# On completion it prints the exact `llm` config block to add to sandy.json.
#
# Usage:
#   bash scripts/provision-model.sh
#   # or, to override:
#   SANDY_LLM_DIR=/opt/sandy/llama SANDY_MODEL_DIR=/opt/sandy/models \
#   SANDY_LLM_VARIANT=ubuntu-x64 bash scripts/provision-model.sh
#
set -euo pipefail

# --- defaults (the documented default model, design §7 #2) -------------------
DEFAULT_MODEL_URL="https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
DEFAULT_MODEL_SHA256="3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"
DEFAULT_MODEL_FILE="Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
LLAMA_RELEASE="${SANDY_LLAMA_RELEASE:-b10569}"
LLAMA_VARIANT="${SANDY_LLM_VARIANT:-ubuntu-vulkan-x64}"   # vulkan = GPU, no CUDA toolkit
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-${LLAMA_VARIANT}.tar.gz"
LLAMA_EXTRACT_DIR="llama-${LLAMA_RELEASE}"
# SHA256 of the default (release, variant) pin above -- pinned the same way the
# model is, since this tarball becomes executable code we chmod +x and run.
DEFAULT_LLAMA_SHA256="a6ae15547658207b17032f81e77eef935e304503f7bbf1243919f5d9e7c16a33"
LLAMA_SHA256="${SANDY_LLAMA_SHA256:-$DEFAULT_LLAMA_SHA256}"

MODEL_URL="${SANDY_MODEL_URL:-$DEFAULT_MODEL_URL}"
MODEL_SHA256="${SANDY_MODEL_SHA256:-$DEFAULT_MODEL_SHA256}"
MODEL_FILE="${SANDY_MODEL_FILE:-$DEFAULT_MODEL_FILE}"
MODEL_DIR="${SANDY_MODEL_DIR:-$HOME/.local/share/sandy/models}"
LLM_DIR="${SANDY_LLM_DIR:-$HOME/.local/share/sandy/llama.cpp}"

log()  { printf '\033[1;34m[provision]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[provision] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

log "install dir (runtime): $LLM_DIR"
log "install dir (model):   $MODEL_DIR"
mkdir -p "$MODEL_DIR" "$LLM_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. llama-server (the local model runtime) -------------------------------
log "downloading llama.cpp ${LLAMA_RELEASE} (${LLAMA_VARIANT})"
curl -fsSL --max-time 1200 -o "$TMP/llama.tar.gz" "$LLAMA_URL" || fail "llama.cpp download failed: $LLAMA_URL"

# If the release/variant was overridden from the pinned default, the built-in
# hash does not apply: fail closed unless an explicit hash is supplied, rather
# than silently skipping verification of a binary we are about to execute.
if { [ "$LLAMA_RELEASE" != "b10569" ] || [ "$LLAMA_VARIANT" != "ubuntu-vulkan-x64" ]; } && [ -z "${SANDY_LLAMA_SHA256:-}" ]; then
  fail "SANDY_LLAMA_RELEASE/SANDY_LLM_VARIANT was overridden from the pinned default (b10569 / ubuntu-vulkan-x64), so the built-in llama-server hash does not apply. Set SANDY_LLAMA_SHA256 explicitly (compute it with: curl -fsSL -o /tmp/x.tar.gz '$LLAMA_URL' && sha256sum /tmp/x.tar.gz), or unset the override to use the pinned default."
fi
log "verifying llama.cpp tarball SHA256 (fail-closed; this becomes executable code)"
ACTUAL_LLAMA="$(sha256sum "$TMP/llama.tar.gz" | awk '{print $1}')"
if [ "$ACTUAL_LLAMA" != "$LLAMA_SHA256" ]; then
  rm -f "$TMP/llama.tar.gz"
  fail "llama.cpp tarball hash mismatch (expected $LLAMA_SHA256, got $ACTUAL_LLAMA) — refusing to extract/run an unverified binary"
fi
log "llama.cpp tarball verified"

tar xzf "$TMP/llama.tar.gz" -C "$TMP" || fail "llama.cpp tarball is corrupt"
[ -f "$TMP/$LLAMA_EXTRACT_DIR/llama-server" ] || fail "llama-server binary not found in the tarball (unexpected layout)"
# Flatten into a STABLE path so the config does not churn when the release
# bumps. The binary resolves its own libs via RUNPATH=$ORIGIN, so the libs must
# sit beside it — copy the whole extracted dir's contents in.
cp -a "$TMP/$LLAMA_EXTRACT_DIR/." "$LLM_DIR/"
chmod +x "$LLM_DIR/llama-server"
log "llama-server installed at $LLM_DIR/llama-server"

# --- 2. the model (SHA256-pinned, fail-closed) -------------------------------
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"
if [ -f "$MODEL_PATH" ]; then
  log "model already present: $MODEL_PATH (verifying hash)"
else
  log "downloading model: $MODEL_URL"
  curl -fsSL --max-time 3600 -o "$MODEL_PATH.part" "$MODEL_URL" || fail "model download failed: $MODEL_URL"
  mv "$MODEL_PATH.part" "$MODEL_PATH"
fi
log "verifying model SHA256 (fail-closed)"
ACTUAL="$(sha256sum "$MODEL_PATH" | awk '{print $1}')"
if [ "$ACTUAL" != "$MODEL_SHA256" ]; then
  rm -f "$MODEL_PATH"
  fail "model hash mismatch (expected $MODEL_SHA256, got $ACTUAL) — file removed; re-download required"
fi
log "model verified: $MODEL_PATH"

# --- 3. the config block -----------------------------------------------------
cat <<EOF

Provisioning complete. Add this to your standalone sandy.json (mode: "standalone"):

  "llm": {
    "provider": "local",
    "model": "qwen3-4b-instruct-2507",
    "model_path": "$MODEL_PATH",
    "engine": {
      "type": "llama-server",
      "command": ["$LLM_DIR/llama-server"],
      "host": "127.0.0.1",
      "port": 0
    }
  }

Notes:
  - port 0 = pick a free loopback port (the model runs IN-SANDBOX, zero-egress).
  - The sandbox's max_cpu_percent caps the model's CPU threads (llama.cpp
    --threads). For GPU accel with the vulkan variant, set a GPU in the sandbox
    (e.g. nvidia runtime for Docker) — it is then used automatically.
  - Air-gapped host: copy "$MODEL_PATH" and the "$LLM_DIR" directory over, then
    point model_path / engine.command at the new absolute locations.
EOF
