FROM apify/actor-node-playwright-chrome:20 AS builder

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --chown=myuser:myuser package*.json ./
RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./
RUN npm run build

FROM apify/actor-node-playwright-chrome:20

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --chown=myuser:myuser --from=builder /home/myuser/dist ./dist
COPY --chown=myuser:myuser .actor ./.actor
COPY --chown=myuser:myuser README.md ./README.md

CMD ["npm", "run", "start:prod"]
