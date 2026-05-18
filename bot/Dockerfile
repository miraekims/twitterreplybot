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

# Only the manifest — we deliberately ignore any host-generated
# package-lock.json (.dockerignore'd) so the install resolves fresh against
# the current platform, avoiding stale-lock skips of native dependencies.
COPY package.json ./

# Foreground scripts so we see the node-tls-client postinstall download.
# Then assert the native binary is actually on disk — fail the build loud
# if it isn't, instead of silently shipping a broken image.
RUN npm install --foreground-scripts \
 && node -e "import('node-tls-client').then(m => { if (!m.Session && !(m.default && m.default.Session)) { throw new Error('node-tls-client loaded but Session export missing'); } console.log('node-tls-client OK, version', require('node-tls-client/package.json').version); })"

COPY src ./src

# data/ is a volume — we never bake state into the image.
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
