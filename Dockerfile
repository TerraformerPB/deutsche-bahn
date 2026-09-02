# DB-ICE-Live-Karte – Produktions-Image
# Mehrstufig: Abhängigkeiten installieren (inkl. Vendor-Kopie der Browser-Bibliotheken),
# dann schlankes Laufzeit-Image ohne Build-Werkzeuge, unprivilegierter Benutzer.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/vendor.js ./scripts/vendor.js
# postinstall kopiert maplibre-gl/pmtiles nach public/vendor (benötigt beide Pakete als dependencies)
RUN mkdir -p public && npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/public/vendor ./public/vendor
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts/vendor.js scripts/build-corridors.js ./scripts/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server.js"]
