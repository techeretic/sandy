# Sandbox conformance image (SB-09). A minimal node image so `sandy` can run
# INSIDE a real sandbox boundary for the egress conformance test. Kept tiny:
# it copies only what runs the compiled CLI.
FROM node:22-trixie-slim
WORKDIR /app
# deps + built CLI. The sandbox boundary for the conformance run is the
# container network (--internal / --network none), not this image.
COPY package.json package-lock.json ./
COPY node_modules ./node_modules
COPY dist ./dist
COPY bin ./bin
# ep-server.mjs: the HTTP MCP endpoint for the egress harness.
# stdio-server.mjs: the stdio MCP server for the sandbox matrix (no network).
# stub-model.mjs: a loopback OpenAI-compatible stand-in for the bundled model
#   (standalone conformance, design §9) — lets `sandy ask` run the full loop
#   (parse -> run -> narrate) with no real model, no GPU, and no external egress.
COPY conformance/ep-server.mjs ./conformance/ep-server.mjs
COPY conformance/stdio-server.mjs ./conformance/stdio-server.mjs
COPY conformance/stub-model.mjs ./conformance/stub-model.mjs
ENV NODE_ENV=production
