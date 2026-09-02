# Betrieb

## 1. Voraussetzungen

* Linux-Server mit Node.js ≥ 22 **oder** Docker.
* Reverse-Proxy mit TLS (nginx oder Caddy), Domain z. B. `bahn.paulbartsch.de`.
* Eigener Kartenserver (`maps.paulbartsch.de`) mit `style/style.json`, `tiles/europe.pmtiles`, `fonts/…`.
* Ausgehender HTTPS-Zugang zu `v6.db.transport.rest`, `api.brightsky.dev`, `api.open-meteo.com`.

## 2. Installation

### Variante A: Docker Compose (empfohlen)

```bash
git clone <repo> db-ice-live-karte && cd db-ice-live-karte
cp .env.example .env && $EDITOR .env
docker compose up -d --build
curl -s http://127.0.0.1:3000/api/health
```

Das Compose-Setup startet den Container unprivilegiert, mit schreibgeschütztem Dateisystem, ohne Capabilities
und mit Healthcheck; der Port ist nur auf `127.0.0.1` gebunden (Reverse-Proxy davor).

### Variante B: systemd

```bash
sudo useradd -r -s /usr/sbin/nologin dbkarte      # optional; Unit nutzt DynamicUser
sudo mkdir -p /opt/db-ice-live-karte && sudo cp -r . /opt/db-ice-live-karte
cd /opt/db-ice-live-karte && npm ci --omit=dev
sudo cp deploy/systemd/db-ice-live-karte.service /etc/systemd/system/
sudo cp .env /etc/db-ice-live-karte.env && sudo chmod 600 /etc/db-ice-live-karte.env
sudo systemctl daemon-reload && sudo systemctl enable --now db-ice-live-karte
journalctl -u db-ice-live-karte -f
```

## 3. Reverse-Proxy

Beispiele in `deploy/nginx.example.conf` und `deploy/Caddyfile.example`. Wesentlich:

* `proxy_pass http://127.0.0.1:3000`, Header `X-Forwarded-For` und `X-Forwarded-Proto` setzen und in `.env`
  `TRUST_PROXY=1` (Anzahl der Proxy-Hops), sonst zählt das Rate-Limit alle Clients als eine IP.
* TLS 1.2+, HSTS nur am Proxy **oder** per `HSTS_ENABLED=true` in der App (nicht doppelt).
* Kompression für `application/json`, `text/javascript`, `text/css` (MapLibre ≈ 580 KB unkomprimiert).
* Zugriffsprotokolle am Proxy mit Anonymisierung/Rotation (7 Tage), passend zur Datenschutzerklärung.

## 4. Kartenserver (CORS und Range-Requests)

Im Vektor-Modus lädt der Browser Style, PMTiles und Glyphen direkt vom Kartenserver. Für eine andere Domain
als die der App muss der Kartenserver antworten mit:

```
Access-Control-Allow-Origin: https://bahn.paulbartsch.de   (oder *)
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Range, If-Match, If-None-Match
Access-Control-Expose-Headers: Content-Range, Content-Length, ETag, Accept-Ranges
Accept-Ranges: bytes
```

PMTiles benötigt HTTP-Range-Requests (`206 Partial Content`). Prüfen:

```bash
curl -sI -H "Range: bytes=0-16383" https://maps.paulbartsch.de/tiles/europe.pmtiles | head -20
curl -sI -H "Origin: https://bahn.paulbartsch.de" https://maps.paulbartsch.de/style/style.json | grep -i access-control
```

Die Content-Security-Policy der App gibt automatisch den Origin aus `MAP_STYLE_URL` frei; weichen Kachel- oder
Glyphen-Hosts ab, diese in `MAP_EXTRA_ORIGINS` eintragen (kommagetrennt, nur Origins ohne Pfad).

**Raster-Modus.** Läuft die App auf demselben Server wie der Kartenserver, kann `MAP_MODE=raster` mit
`MAP_RASTER_URL_TEMPLATE=http://127.0.0.1:8080/raster/{z}/{x}/{y}.png` genutzt werden. Die App proxied die
Kacheln (Cache im Speicher, Zoom bis `MAP_RASTER_MAX_ZOOM`) und erzeugt `/map/style.json`. CORS ist dann nicht nötig.

## 5. Konfiguration und Fair Use

* `USER_AGENT` mit Projektname und Kontakt setzen (z. B. `db-ice-live-karte/0.1 (+mailto:…)`), damit der Betreiber
  von transport.rest Sie bei Problemen erreichen kann.
* `UPSTREAM_MAX_RPM` konservativ lassen (40). Ein Wert über 60 riskiert Blockierung durch das DB-Backend.
* `TRACK_PRODUCTS=nationalExpress,national` verdoppelt etwa die Zahl der Fahrten – nur mit ausreichend Budget.
* Mehrere Instanzen (Staging/Produktion) teilen sich das Kontingent der Server-IP.

## 6. Überwachung

| Prüfung | Befehl / Endpunkt | Erwartung |
|---|---|---|
| Liveness | `GET /api/health` | `200 {"status":"ok"}` |
| Datenfluss | `GET /api/status` | `poller.upstream.state = "closed"`, `lastRefreshAt` < 10 min, `trackedTrips` > 0 tagsüber |
| Logs | `journalctl -u …` / `docker logs` | keine `error`-Zeilen in Folge; `warn` mit `UPSTREAM_RATE_LIMITED` → Budget senken |
| Speicher | `docker stats` | < 300 MB |

Für externe Überwachung (Uptime-Robot, Healthchecks.io) `GET /api/health` alle 5 min abfragen.
Alarmierung sinnvoll bei: Health rot > 5 min, `upstream.state = open` > 30 min, Speicher > 500 MB.

## 7. Wartung

* **Aktualisierung:** `git pull && npm ci --omit=dev && systemctl restart …` bzw. `docker compose up -d --build`.
  Vorher `npm run lint && npm test` auf einer Kopie ausführen.
* **Abhängigkeiten:** Dependabot-PRs prüfen; `npm audit --omit=dev` monatlich.
* **Korridore:** `src/data/ice-corridors.source.js` anpassen und `npm run build:corridors` ausführen.
* **Stationsdaten:** `db-stations` in `src/data/db-stations.json` aktualisieren (Skript in `scripts/` bzw. Anleitung in DATENQUELLEN.md).
* **Rechtstexte:** `public/impressum.html`, `public/datenschutz.html` ausfüllen (Platzhalter `[[…]]`).

## 8. Störungsbehebung

| Symptom | Ursache | Abhilfe |
|---|---|---|
| Karte grau, Banner „Kartenstil nicht erreichbar“ | CORS/Range am Kartenserver, falsche `MAP_STYLE_URL` | Abschnitt 4 prüfen; Browser-Konsole zeigt blockierte Anfrage |
| Keine Züge, Status „gestört“ | transport.rest/DB-Backend blockiert (429/5xx) | `/api/status` prüfen; Budget senken; ggf. `TRANSPORT_PROFILE=dbweb` testen; eigene db-rest-Instanz |
| Züge ohne Bewegung | Polylines fehlen und Korridor nicht erkannt → Luftlinie | Normal; Anzeige `source: linear` |
| Rate-Limit trifft alle Nutzer | `TRUST_PROXY` falsch | `TRUST_PROXY=1` hinter genau einem Proxy |
| Wetter leer | Bright Sky/Open-Meteo nicht erreichbar | `/api/status` → `weather`; Firewall für ausgehendes HTTPS |
| CSP-Verstöße in der Konsole | Zusätzliche Hosts für Glyphen/Kacheln | `MAP_EXTRA_ORIGINS` setzen |

## 9. Backup und Wiederherstellung

Die Anwendung hält keinen persistenten Zustand. Zu sichern sind nur `.env` und die angepassten Rechtstexte.
Nach einem Neustart benötigt der Poller 1–2 Zyklen (≈ 10–20 min), bis alle laufenden Fahrten erfasst sind.
