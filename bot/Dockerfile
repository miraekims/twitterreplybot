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

# Foreground scripts so we see the install steps. Then run a tiny self-test
# script that imports node-tls-client AND calls initTLS() — this forces koffi
# to actually load the native library, which is the part that silently fails
# when the library is missing or platform-incompatible.
RUN npm install --foreground-scripts
COPY <<'EOF' /tmp/tls-selftest.mjs
import { Session, initTLS, destroyTLS } from 'node-tls-client';
await initTLS();
const s = new Session({ clientIdentifier: 'chrome_124', timeout: 5000 });
await s.close();
await destroyTLS();
console.log('node-tls-client native library loaded OK');
EOF
RUN node /tmp/tls-selftest.mjs && rm /tmp/tls-selftest.mjs

COPY src ./src

# data/ is a volume — we never bake state into the image.
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
