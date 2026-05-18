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

# Install. Foreground scripts so we see the postinstall output. After install
# we dump the resolved tree and the package directory contents — if anything
# is missing, the diff is right there in the build log.
RUN npm install --foreground-scripts \
 && echo "--- npm ls (top-level) ---" \
 && npm ls --depth=0 \
 && echo "--- node_modules/node-tls-client ---" \
 && ls -la node_modules/node-tls-client/ \
 && node -e 'const p=require("./node_modules/node-tls-client/package.json"); console.log("RESOLVED:",p.name,"v"+p.version,"main="+p.main)'

# Self-test runs from /app so module resolution finds node_modules. Imports
# the package, calls initTLS() to force native library load, opens and
# closes a Session, then destroyTLS. Build fails loud if any step throws.
RUN node -e 'import("node-tls-client").then(async m=>{await m.initTLS();const s=new m.Session({clientIdentifier:"chrome_124",timeout:5000});await s.close();await m.destroyTLS();console.log("TLS native lib OK")}).catch(e=>{console.error("SELFTEST FAIL:",e&&e.stack||e);process.exit(1)})'

COPY src ./src

# data/ is a volume — we never bake state into the image.
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
