# Linux x86_64 image — node-tls-client publishes prebuilt binaries for this
# platform, so the Go binary that does the Chrome TLS handshake lands on disk
# during `npm install` and we never have to debug it again.
#
# Why not use multi-arch: even on Apple Silicon Macs, Docker will run this
# x86_64 image under Rosetta. That's slower (irrelevant for a bot doing one
# request per minute), but gives us a guaranteed-working environment.
FROM --platform=linux/amd64 node:22-bookworm-slim

# better-sqlite3 needs a C++ toolchain to compile its native module on first
# install. Removed in the same RUN to keep the image small.
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Force install of node-tls-client (it's listed as optional in package.json so
# npm can skip it on unsupported platforms — here we know it works).
RUN npm install --omit=dev || npm install \
 && npm install node-tls-client --foreground-scripts

COPY src ./src

# data/ is a volume — we never bake state into the image.
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
