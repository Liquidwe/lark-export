FROM node:24.10.0-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    DATA_DIR=/app/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# A new named volume inherits this ownership, so the non-root user can write to it.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 4310
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
