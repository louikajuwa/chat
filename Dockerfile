FROM node:22-slim

WORKDIR /usr/src/app

# Everything below runs as the unprivileged `node` user (uid 1000).
# /usr/src/app/uploads is the mount point of the `uploads` named volume.
RUN mkdir -p /usr/src/app/uploads && chown -R node:node /usr/src/app
USER node

COPY --chown=node:node package*.json ./
# Dev (default) installs devDependencies for tests/lint; the prod override passes --omit=dev.
ARG NPM_CI_FLAGS=""
RUN npm ci $NPM_CI_FLAGS

COPY --chown=node:node . .

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node directly (not npm) so it receives SIGTERM; run with `docker run --init`.
CMD ["node", "server.js"]
