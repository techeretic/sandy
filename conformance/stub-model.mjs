// A stand-in for a bundled local model, for standalone conformance (design §9).
//
// It speaks just enough of the OpenAI-compatible chat API that `LlamaCppEngine`
// can drive it (which is what the real `llama-server` would do):
//   GET  /health                 -> 200
//   POST /v1/chat/completions    -> { choices: [{ message: { content } }], usage }
//
// It is bound to LOOPBACK only (127.0.0.1) — the same placement a real in-
// sandbox model uses (§4.0) — so its egress is zero by construction and the
// existing no-egress conformance applies to the standalone service.
//
// Behavior is deterministic and model-agnostic: the FIRST chat completion
// (the parse step, whose prompt asks for a JSON plan) returns a canned,
// LEGAL plan for the conformance fixture (crm/read_deals); every later
// completion (the narrate step) returns a short prose summary. This exercises
// the whole loop (parse -> run -> narrate) end-to-end with no real model, no
// GPU, and no external egress.
//
// Usage: node conformance/stub-model.mjs [--port N] [--host H] [--model PATH]
//   (LlamaCppEngine spawns it with --model/--host/--port; port 0 = pick a free
//    loopback port and print it.)
// Prints "Server listening at http://127.0.0.1:PORT" to stdout on ready.

import { createServer } from "node:http";

function parseArgs(argv) {
  const out = { port: 0, host: "127.0.0.1", model: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i] ?? 0);
    else if (a === "--host") out.host = argv[++i] ?? out.host;
    else if (a === "--model") out.model = argv[++i] ?? "";
  }
  return out;
}

const { port, host, model } = parseArgs(process.argv.slice(2));

// The plan the conformance fixture's goal maps to. crm/read_deals is the tool
// every conformance config exposes, so this plan is always legal for them.
const PLAN = JSON.stringify({
  goal: "Summarize EMEA deals",
  gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
  report: { title: "EMEA Deals", file: "emea.md" },
});
const NARRATIVE =
  "Two deals closed in EMEA this quarter per the CRM; the full detail is in the claims below.";

function isParsePrompt(prompt) {
  // The parse prompt is the only one that asks for a JSON object plan.
  return /JSON object|gather/i.test(prompt) && /plan|goal/i.test(prompt);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", model }));
    return;
  }
  if (url === "/v1/chat/completions" && req.method === "POST") {
    const body = await readBody(req);
    const prompt =
      Array.isArray(body?.messages) && body.messages.length > 0
        ? String(body.messages[body.messages.length - 1]?.content ?? "")
        : "";
    const content = isParsePrompt(prompt) ? PLAN : NARRATIVE;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => server.listen(port, host, resolve));
const actual = server.address().port;
process.stdout.write(`Server listening at http://${host}:${actual}\n`);

// Keep alive until killed (a model subprocess, reaped by LlamaCppEngine.close()).
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
