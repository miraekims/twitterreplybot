# The bot no longer makes direct HTTPS requests to x.com — that's done by
# the Chrome extension via the WebSocket bridge. We can therefore drop:
#   - curl-impersonate (was used for Chrome TLS fingerprinting)
#   - the apt build chain that fetched + extracted it
#
# Image is now ~250 MB instead of ~700 MB and builds in seconds. We keep
# better-sqlite3's compile deps (python3 + g++) because it has a native
# binding that needs building on first npm install.
FROM --platform=linux/amd64 node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifest first for layer caching.
COPY package.json ./
RUN npm install --foreground-scripts \
 && npm ls --depth=0

COPY src ./src

# Bridge server listens on this port; docker-compose publishes it to
# 127.0.0.1 only so the LAN can't reach it.
EXPOSE 8787

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
