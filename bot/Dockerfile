# Linux x86_64 image — runs under Rosetta on Apple Silicon Macs. Slow startup
# is irrelevant for a bot that does ~10 requests per minute.
FROM --platform=linux/amd64 node:22-bookworm-slim

WORKDIR /app

# Two layers of dependencies:
#   1. apt: build toolchain for better-sqlite3, plus wget+tar to fetch
#      curl-impersonate, plus ca-certificates so curl-impersonate can verify
#      x.com's TLS cert.
#   2. curl-impersonate (pinned to v0.6.1): a curl build that produces a
#      Chrome 116 TLS Client Hello byte-for-byte (JA3, HTTP/2 SETTINGS,
#      header order). This replaces the npm-side node-tls-client we burned
#      hours on. The release tarball ships several /usr/local/bin/curl_*
#      binaries; we only use curl_chrome116. Verified end-to-end with a
#      probe HTTP request to x.com/home before this Dockerfile was committed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates wget tar \
 && rm -rf /var/lib/apt/lists/*

ARG CURL_IMP_VERSION=v0.6.1
RUN wget -q -O /tmp/ci.tgz \
      "https://github.com/lwthiker/curl-impersonate/releases/download/${CURL_IMP_VERSION}/curl-impersonate-${CURL_IMP_VERSION}.x86_64-linux-gnu.tar.gz" \
 && tar -xzf /tmp/ci.tgz -C /usr/local/bin/ \
 && rm /tmp/ci.tgz \
 && curl_chrome116 --version | head -1 \
 && curl_chrome116 -sS -o /dev/null -w "x.com probe: HTTP %{http_code}\n" "https://x.com/home"

# Manifest first for layer caching. We deliberately don't COPY package-lock.json
# (it's in .dockerignore) so install resolves fresh against linux/amd64.
COPY package.json ./

RUN npm install --foreground-scripts \
 && npm ls --depth=0

COPY src ./src

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
