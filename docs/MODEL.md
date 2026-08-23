# Model + Runtime Provisioning (standalone mode, SD-02)

How a user gets `llama-server` + the bundled GGUF, and the decisions this
settles from the Phase 2 design (`docs/PHASE2_DESIGN.md` §7).

## The short version

```bash
# 1. Build Sandy once.
npm ci && npm run build

# 2. Provision the model + runtime (out-of-band, install-time). Downloads
#    llama-server (Vulkan build — GPU accel with NO CUDA toolkit) and the
#    default model (Qwen3-4B-Instruct-2507 Q4_K_M, SHA256-pinned), and prints
#    the exact "llm" block to add to sandy.json.
bash scripts/provision-model.sh

# 3. Point a standalone sandy.json at the printed paths, then run inside a
#    sandbox. The model runs IN-SANDBOX on loopback — zero egress by
#    construction (design §4.0).
sandy ask "Summarize the EMEA deals" --config sandy.json
```

## Distribution: docs + a helper, not a bundled download (design §7 #1)

**Decision: (a) docs-based install of `llama-server` + GGUF, with an optional
`scripts/provision-model.sh` helper.** The runtime NEVER downloads a model —
provisioning is an install-time, out-of-band step. This is the simplest, most
air-gap-friendly option (the file is just copied onto the host) and keeps no
download logic in the security-relevant runtime path.

- The helper is a **convenience**, not a runtime dependency. It pins the model
  by **SHA256** and **fails closed** on a hash mismatch (removes the file), so a
  tampered or truncated download can never be used.
- **Air-gapped host:** run the helper on an internet-connected machine, then
  copy the model file + the `llama.cpp` dir over, and point `model_path` /
  `engine.command` at the new absolute paths. Nothing in the runtime is
  network-dependent at that point.

Why not a `sandy model fetch` runtime command or a platform bundle?
- A runtime download would need to cross the egress policy (a real design risk)
  and would add code to the security surface for a one-time install task.
- A pre-bundled binary bloats the repo and hardcodes a GPU/CPU variant; the
  helper picks the variant explicitly (Vulkan by default) and is trivial to
  point at a different one.

## The default model (design §7 #2)

**Decision: Qwen3-4B-Instruct-2507, Q4_K_M GGUF — the documented default.**

| Property | Value |
|----------|-------|
| Repo | `unsloth/Qwen3-4B-Instruct-2507-GGUF` |
| File | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` |
| Size | ~2.4 GB |
| License | **Apache-2.0** (permissive; safe to bundle/re-distribute) |
| Class | 4B instruct, within the PRD §6.6 "4–8B class, quantized, CPU-viable, GPU-accelerated" target |
| SHA256 | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |

**Why this one:**
- It is an **instruct** model (chat/agent-capable) — the parse step asks it to
  emit a structured JSON plan, and the narrate step asks for prose. A base
  (non-instruct) model is the wrong tool. (`Qwen/Qwen3-4B-GGUF` is the base
  model and is not the default.)
- **Q4_K_M** is the standard quality/size point for the 4B class (~2.4GB): it
  loads on CPU comfortably and fits easily on a consumer GPU, and it is the
  quant most often recommended as the default.
- **Apache-2.0** clears the license/size check §7 #2 requires.
- The config names it logically (`"model": "qwen3-4b-instruct-2507"`); the
  actual file is `model_path`, so SD-04 (swappable model) is a config change,
  not a code change.

**Measured on the reference box (RTX 5090, Vulkan, `-ngl 99`):** the parse step
(206 prompt tokens → 48 completion) ran in ~3.7s at ~18.8 tok/s; the full
`sandy ask` (parse → MCP run → narrate) completed in well under a minute with
zero external egress. Quality note (SD-06) is surfaced in the report.

## The runtime: llama.cpp `llama-server` (design §4.1)

`LlamaCppEngine` (`src/engine.ts`) drives `llama-server` as a **subprocess on
loopback** — in-sandbox, zero-egress by construction. It:
- fails closed if `model_path` is missing at `start()`,
- discovers the bound port (fixed if set, else parsed from the server's startup
  log — the real server logs to **stderr**),
- probes `/health` until ready, records token usage (AU-01), and marks the
  engine `degraded` (reported, not a crash) on a crash.

**GPU without a CUDA toolkit:** the default helper variant is the **Vulkan**
build, which uses the standard GPU driver (NVIDIA/AMD/Intel) — no separate CUDA
install. On a CPU-only box, use the `ubuntu-x64` (CPU) variant instead
(`SANDY_LLM_VARIANT=ubuntu-x64`).

### The runtime is integrity-pinned too (not just the model)

The model GGUF is inert weights, but `llama-server` is **executable code** that
the helper `chmod +x`s and runs as a subprocess. The helper therefore verifies
the **llama.cpp release tarball** by SHA256 **before** extracting or running it —
fail-closed, the same way it verifies the model (a mismatch is removed and
aborts; nothing unverified is ever executed). This matters more than the model
pin: a compromised release asset or a MITM'd download would otherwise run
undetected on the provisioning host.

| Property | Value |
|----------|-------|
| Release | `b10569` |
| Variant | `ubuntu-vulkan-x64` (Vulkan GPU build; the CPU build is `ubuntu-x64`) |
| Artifact | `llama-b10569-bin-ubuntu-vulkan-x64.tar.gz` (GitHub release) |
| SHA256 | `a6ae15547658207b17032f81e77eef935e304503f7bbf1243919f5d9e7c16a33` |

Overriding the pin: the built-in hash applies **only** to the default
`b10569` / `ubuntu-vulkan-x64` release+variant. If you override either
(`SANDY_LLAMA_RELEASE` / `SANDY_LLM_VARIANT`), the helper **fails closed** unless
you also supply an explicit hash via `SANDY_LLAMA_SHA256` — it never silently
skips verification of a binary it is about to execute. To pin a different
release/variant, compute its hash (`curl -fsSL -o /tmp/x.tar.gz <release-url> &&
sha256sum /tmp/x.tar.gz`) and pass it as `SANDY_LLAMA_SHA256`.

## Resource limits (design §4.5 — settled)

**Decision: map the declared sandbox caps to real levers now; the hard ceiling
is the service manager's cgroup.**

- **CPU:** `sandbox.max_cpu_percent` is mapped to a llama.cpp `--threads`
  budget for the local model (`threadsForCpuPercent` in `src/engine.ts`, wired
  in `createSandy`). A cap of `100` means "no effective limit" (no flag passed,
  llama.cpp keeps its default); any lower value **reduces** the thread budget
  (tighten-never-loosen). The host/remote engines ignore it.
- **Memory (hard ceiling):** the *hard* memory bound is the **service manager's
  cgroup** (`memory.max` / Docker `--memory` / `systemd` `MemoryMax=`). Sandy
  sets the soft knobs; the supervisor enforces the ceiling. This is documented,
  not silently unbounded. (An in-service hard bound remains an explicit,
  flagged addition if the team wants it.)

## Where things live

| Artifact | Default location | Config field |
|----------|------------------|--------------|
| `llama-server` | `~/.local/share/sandy/llama.cpp/llama-server` | `llm.engine.command` |
| Model GGUF | `~/.local/share/sandy/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | `llm.model_path` |

Both are absolute, host-specific paths — set them after provisioning. The
helper prints the ready-to-paste `llm` block.
