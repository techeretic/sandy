# Sandbox conformance image (SB-09). A minimal node image so `sandy` can run
# INSIDE a real sandbox boundary for the egress conformance test. Kept tiny:
# it copies only what runs the compiled CLI.
FROM node:22-trixie-slim
WORKDIR /app
# deps + built CLI. The sandbox boundary for the conformance run is the
# container network (--internal), not this image.
COPY package.json package-lock.json ./
COPY node_modules ./node_modules
COPY dist ./dist
COPY bin ./bin
COPY conformance/ep-server.mjs ./conformance/ep-server.mjs
ENV NODE_ENV=production
