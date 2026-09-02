# DB-ICE-Live-Karte

Live-Karte des deutschen Fernverkehrs (ICE, optional IC/EC) auf einer selbst gehosteten Vektorkarte
(MapLibre GL JS + PMTiles). Zeigt, wo welcher Zug gerade unterwegs ist, ob er pünktlich ist, welche
Streckenstörungen gemeldet sind, hebt die 16 Landeshauptstädte und die ICE-Hauptstrecken hervor und
blendet Wetterdaten des Deutschen Wetterdienstes ein.

> **Inoffizielles Angebot.** Dieses Projekt steht in keiner Verbindung zur Deutschen Bahn AG. Alle Angaben
> sind berechnet bzw. aus Drittquellen übernommen und ohne Gewähr. Rechtliche Einordnung: [docs/RECHTLICHES.md](docs/RECHTLICHES.md).

## Funktionen

| Bereich | Umsetzung |
|---|---|
| Zugpositionen | Serverseitig aus Fahrtverläufen (`/trips/:id`, Plan-/Ist-Zeiten der Halte) entlang Polyline → ICE-Korridor → Luftlinie interpoliert; im Browser flüssig animiert |
| Verspätung / Status | pünktlich (≤ 5 min), leicht (6–15), verspätet (16–60), stark (> 60), ausgefallen, keine Echtzeitdaten – farbcodiert auf Karte und in Listen |
| Störungen | HIM-/Echtzeitmeldungen aus Fahrten und Abfahrtstafeln, kategorisiert (Strecke, Bau, Zug, Wetter), betroffene Halte/Abschnitte auf der Karte |
| Landeshauptstädte | 16 Hauptbahnhöfe mit Stern-Markierung, Abfahrtstafel-Zusammenfassung, Wetter-Chip, DWD-Warnungen |
| ICE-Hauptstrecken | 58 Korridore (Schnellfahr-, Ausbau- und Hauptstrecken) als hervorgehobene Linien mit Linien-/Geschwindigkeitsinfo |
| Wetter | Deutscher Wetterdienst über Bright Sky (inkl. amtlicher Warnungen), Fallback Open-Meteo; „Wetter am Zug“ |
| Weitere Infos | Gleiswechsel, Auslastung, Halte mit Plan/Ist/Gleis, Zugsuche, Bahnhofssuche mit Live-Abfahrten |
| Betrieb | Kein API-Schlüssel nötig, striktes Anfragebudget gegenüber transport.rest, Caching, Circuit-Breaker, Demo-Modus ohne Internet |

## Architektur in einem Satz

Ein Node.js-Dienst (Express 5) fragt serverseitig `v6.db.transport.rest` und die Wetter-APIs ab, hält alle
Fahrten im Speicher und liefert dem Browser fertige GeoJSON-Daten; der Browser lädt ausschließlich vom eigenen
Server und vom eigenen Kartenserver (`maps.paulbartsch.de`). Details: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md),
Ablaufdiagramme: [docs/PROGRAMMABLAUFPLAN.md](docs/PROGRAMMABLAUFPLAN.md).

## Schnellstart

Voraussetzungen: Node.js ≥ 22, npm.

```bash
npm install                 # installiert Abhängigkeiten und kopiert MapLibre/PMTiles nach public/vendor
cp .env.example .env        # anpassen (mindestens MAP_STYLE_URL, USER_AGENT mit Kontaktadresse)
npm start                   # http://localhost:3000
```

Demo ohne Internetzugang (synthetische Fahrten, Mock-Wetter, Ersatz-Basiskarte):

```bash
npm run demo                # http://127.0.0.1:3000
```

Docker:

```bash
docker compose up -d --build
```

Wichtige Umgebungsvariablen (vollständig in [.env.example](.env.example)):

| Variable | Bedeutung | Standard |
|---|---|---|
| `MAP_STYLE_URL` | style.json des eigenen Kartenservers | `https://maps.paulbartsch.de/style/style.json` |
| `MAP_MODE` | `vector` (PMTiles) oder `raster` (serverseitiger Kachel-Proxy) | `vector` |
| `TRANSPORT_API_BASE_URL` | transport.rest oder eigene db-rest-Instanz | `https://v6.db.transport.rest` |
| `USER_AGENT` | Kennung mit Kontaktmöglichkeit (Fair Use) | Projektname |
| `UPSTREAM_MAX_RPM` | Anfragebudget pro Minute | `40` |
| `TRACK_PRODUCTS` | `nationalExpress` (ICE) oder `nationalExpress,national` (ICE + IC/EC) | `nationalExpress` |
| `WEATHER_PROVIDERS` | `brightsky,open-meteo` oder `none` | `brightsky,open-meteo` |
| `TRUST_PROXY` | hinter Reverse-Proxy: `1` | `false` |

## Kartenserver

Die Karte lädt Style, PMTiles-Kacheln (HTTP-Range-Requests) und Glyphen direkt vom Kartenserver. Dieser muss
für die Domain der App CORS erlauben (`Access-Control-Allow-Origin`, `Accept-Ranges`, `Access-Control-Expose-Headers:
Content-Range, Content-Length`). Alternativ `MAP_MODE=raster` verwenden, wenn die App auf demselben Server läuft
wie der Kartenserver (Raster-Endpunkt ist auf den Server beschränkt). Siehe [docs/BETRIEB.md](docs/BETRIEB.md).

## Qualitätssicherung

```bash
npm run lint      # Syntax + verbotene Konstrukte
npm test          # Unit-Tests (node:test), ohne Netzwerk
npm run test:e2e  # Browser-Rauchtest mit Chromium gegen Demo-Modus (Screenshots in test-results/)
npm run audit     # npm audit (Laufzeitabhängigkeiten)
```

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) | Komponenten, Datenfluss, Module, Entscheidungen |
| [docs/PROGRAMMABLAUFPLAN.md](docs/PROGRAMMABLAUFPLAN.md) | Programmablaufpläne (Mermaid) für Start, Poller, Interpolation, Anfragen |
| [docs/API.md](docs/API.md) | Eigene HTTP-API |
| [docs/DATENQUELLEN.md](docs/DATENQUELLEN.md) | Externe Quellen, Formate, Limits, Lizenzen |
| [docs/SICHERHEIT.md](docs/SICHERHEIT.md) | Bedrohungsmodell (STRIDE), Maßnahmen, Prüfschritte |
| [docs/RECHTLICHES.md](docs/RECHTLICHES.md) | DSGVO/TDDDG/DDG, Markenrecht, Lizenzen, Checkliste |
| [docs/BETRIEB.md](docs/BETRIEB.md) | Deployment (Docker, systemd, nginx/Caddy), Monitoring, Wartung |
| [docs/ENTSCHEIDUNGEN.md](docs/ENTSCHEIDUNGEN.md) | Architekturentscheidungen (ADR) |
| [SECURITY.md](SECURITY.md) | Meldeweg für Sicherheitslücken |

## Lizenz

Quellcode: MIT (siehe [LICENSE](LICENSE)). Daten unterliegen den Lizenzen ihrer Quellen (siehe docs/DATENQUELLEN.md);
Pflicht-Quellenvermerke werden in der Anwendung angezeigt.
