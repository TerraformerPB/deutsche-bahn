# Datenquellen der DB-ICE-Live-Karte

Stand: September 2026. Dieses Dokument beschreibt je Quelle Zweck, Schnittstelle, Format,
Limits, Lizenz, Betreiber, Alternativen und Risiken. Rechtliche Bewertung: `docs/RECHTLICHES.md`.
Alle Quellen werden **ausschließlich serverseitig** abgefragt; der Browser spricht nur den eigenen
Server und den eigenen Kartenserver an. Basis-URLs, Limits und Provider sind über `.env`
konfigurierbar (siehe `.env.example`).

## 1. Adapter-Prinzip

Jede Quelle ist hinter einer Factory mit festem Vertrag gekapselt (Brief, Abschnitt 3 und 4):

| Quelle | Adapter | Vertrag | Austausch bedeutet |
|---|---|---|---|
| Fahrplan/Echtzeit | `src/transport/transport-rest-client.js`, `src/transport/normalize.js` | `departures()`, `arrivals()`, `trip()`, `locations()` → normalisierte `Departure`/`Trip`/`Stopover`/`Remark` | Neuen Client mit gleichem Interface schreiben; Poller, Positionsberechnung, Störungen und API bleiben unverändert |
| Wetter | `src/weather/brightsky.js`, `src/weather/open-meteo.js` | `{name, current(points), alerts?(points)}` → `WeatherItem`, `Alert` | Weiteren Provider in `WEATHER_PROVIDERS` eintragen |
| Karte | Style-URL (`MAP_STYLE_URL`) bzw. Raster-Proxy (`src/routes/map-proxy.js`) | MapLibre-Style JSON | URL ändern oder `MAP_MODE=raster` |
| Stationen | `src/data/stations.js` | `findStation()`, `stationsById` | `src/data/db-stations.json` neu erzeugen |
| Grenzen | `src/data/bundeslaender.geo.json` | GeoJSON `FeatureCollection` mit `properties.id = 'DE-XX'` | Datei ersetzen, `_meta` anpassen |

Intern gelten: Zeiten als Epoch-Millisekunden, Verspätung als `delaySec` (`null` = keine
Echtzeitinformation), Koordinaten `[lon, lat]`. Upstream-Antworten werden defensiv geparst
(fehlende Felder → `null`, falsche Grundstruktur → `UpstreamFormatError`).

## 2. Fahrplan- und Echtzeitdaten: `v6.db.transport.rest`

**Zweck.** Entdeckung laufender ICE/IC/EC-Fahrten über Abfahrtstafeln an rund 100 Knoten,
anschließend Laden der Fahrt mit Halten, Verspätungen, Gleisen, Auslastung, Hinweisen und
Streckenverlauf. Aus diesen Daten interpoliert `src/transport/position.js` die Zugposition.

**Betreiber.** Privatperson (Jannis Redmann, „derhuerst“), Software `db-rest` (ISC) auf Basis
von `db-vendo-client` (ISC), das die Backend-APIs von DB Navigator (`dbnav`, Standardprofil),
bahn.de (`dbweb`) und Regio-Guide/RIS (`db`) anspricht. Die Daten selbst stammen von der
Deutschen Bahn AG.

**Endpunkte und Parameter (wie im Brief).**

| Endpunkt | Parameter | Verwendung |
|---|---|---|
| `GET /stops/{id}/departures` | `duration=60`, `language=de`, `remarks=true`, alle zehn Produktflags explizit (`nationalExpress=true&national=false&regionalExpress=false&regional=false&suburban=false&bus=false&ferry=false&subway=false&tram=false&taxi=false`), optional `profile=dbnav\|db\|dbweb` | Discovery an Knoten, Bahnhofstafeln |
| `GET /stops/{id}/arrivals` | wie oben | Optional (`HUB_INCLUDE_ARRIVALS`) für endende Züge |
| `GET /trips/{id}` | `stopovers=true`, `remarks=true`, `polyline=true`, `language=de`; Trip-ID immer `encodeURIComponent` (enthält `\|`, `#`, `$`, `@`, `%`, Leerzeichen) | Fahrtverlauf, Position |
| `GET /locations` | `query=…`, `results=5`, `stops=true`, `addresses=false`, `poi=false` | Bahnhofssuche (Fallback zu `findStation`) |

`stationId` wird gegen `/^\d{5,12}$/` validiert (EVA-Nummer), `tripId` als String von 5–512
Zeichen ohne Steuerzeichen.

**Formatbesonderheiten.**

* `delay` in **Sekunden** (`null` = keine Echtzeitinformation); Zeiten ISO 8601 mit Offset
  (`2026-09-02T18:04:00+02:00`).
* Abfahrtstafeln liefern **immer nur 1 Stunde**; `duration` wird vom Backend gedeckelt. Mehr als
  60 Minuten voraus ist nur über wiederholte Abfragen oder das `dbris`-Profil (API-Key) möglich.
* `/radar` und `/stops/reachable-from` **existieren nicht mehr**. Positionen werden aus Fahrten
  zeitlich interpoliert.
* `polyline` im `trip()` ist **nicht garantiert** (fehlt oder leer). Fallback: Korridorgeometrie
  aus `src/data/ice-corridors.geo.json`, sonst Luftlinie zwischen Halten. Polyline-Features
  tragen `properties: {}`, Halte müssen per monotoner Nächster-Punkt-Suche zugeordnet werden.
* `stop`-Objekte können `location` weglassen → Koordinaten aus `findStation()`.
* `loadFactor` fehlt in Boards, ist nur in `trip()`/`stopovers` vorhanden und dort nicht immer.
* Boards enthalten nur die wichtigsten `remarks`; `dbweb` liefert alle, wird aber aggressiver
  blockiert. `line.fahrtNr` ist in Boards und `trip()` beim `dbnav`-Profil unzuverlässig.
* Ausgefallene Fahrten sind mit `cancelled: true` enthalten. Remarks: `type` ∈ `hint|status|warning`,
  Felder `code`, `summary`, `text`, `modified`, `priority`.
* Fehler: HTTP 4xx/5xx mit JSON `{error: true, msg}`; 429 = Rate-Limit. Antworten tragen
  `ETag`/`Cache-Control`.

**Limits/Quoten.** transport.rest: 100 Anfragen/Minute pro IP. Darunterliegendes DB-Backend:
ca. 60/min (IPv4), „teils aggressive Blockierung“. Eigene Konfiguration: `UPSTREAM_MAX_RPM=40`,
`UPSTREAM_CONCURRENCY=2`, `UPSTREAM_TIMEOUT_MS=12000`, `HUB_POLL_INTERVAL_SEC=600`
(Stufe 2 mit Faktor 2), `TRIP_REFRESH_MIN_SEC=180`, `TRIP_MAX_TRACKED=400`, `BOARD_CACHE_SEC=60`,
Token-Bucket, Circuit-Breaker (`UPSTREAM_CIRCUIT_COOLDOWN_SEC=60`), 20 % Reserve für
On-Demand-Anfragen.

**Verfügbarkeit/SLA.** Keine. Community-Dienst ohne Zusage, Statusseite über UptimeRobot;
Abschaltung oder Sperrung durch die DB jederzeit möglich. Die App hält alte Daten vor
(Stale-Anzeige mit Zeitstempel, Banner „Datenquelle nicht erreichbar“).

**Lizenz und Attribution.** Software ISC; für die Daten wird keine Lizenz eingeräumt (Details in
`RECHTLICHES.md`, Abschnitt 3). Text im Info-Tab und auf der Quellen-Seite:
`Fahrplan- und Echtzeitdaten: Deutsche Bahn AG, abgerufen über v6.db.transport.rest (inoffizielle Community-API). Alle Angaben ohne Gewähr.`

**Alternativen/Migration.**

| Alternative | Status | Format | Anpassung |
|---|---|---|---|
| Eigene `db-rest`/`db-vendo-client`-Instanz (Docker) | inoffiziell, eigene IP-Quote | identisch | nur `TRANSPORT_API_BASE_URL` |
| DB API Marketplace: RIS::Boards, Timetables (IRIS) | offiziell, API-Key, Nutzungsbedingungen | RIS-Trip-IDs, Boards bis 12 h, keine Polylines, keine Auslastung; IRIS liefert XML | neuer Client; Geometrie stets aus Korridoren |
| DELFI GTFS + GTFS-RT (mobilithek, CC BY 4.0) via MOTIS lokal oder Transitous | Open Data | GTFS-RT TripUpdates; `motis-fptf-client` ist Drop-in für hafas-client | neuer Client; Trip-IDs GTFS |
| Regio-Guide RIS (ohne Key) | inoffiziell | Polylines in `routing-search`, Boards 12 h | wie oben |

**Risiken.** Rechtlich ungeklärte Nutzung, IP-Sperre, Abschaltung, stille Formatänderungen
(Felder verschwinden), sinkende Datenqualität bei Backend-Wechseln, Diskrepanzen zum DB Navigator.

## 3. Wetter (primär): DWD über Bright Sky

**Zweck.** Aktuelles Wetter an den 16 Landeshauptstadt-Bahnhöfen (Wetter-Chips, Wetter-Tab),
amtliche Wetterwarnungen des DWD, optional Wetter an der Zugposition.

**Betreiber.** Bright Sky (Jakob de Maeyer, Deutschland), Open-Source (MIT), gefördert durch
Prototype Fund/BMBF; Datenbasis Open-Data-Server des Deutschen Wetterdienstes (Stationsmessungen,
MOSMIX-Vorhersagen, Warnungen).

**Endpunkte.**

| Endpunkt | Parameter | Antwort |
|---|---|---|
| `GET /current_weather` | `lat`, `lon` | `weather` mit `timestamp`, `temperature` (°C), `condition` (`dry\|fog\|rain\|sleet\|snow\|hail\|thunderstorm\|null`), `icon`, `wind_speed_10`/`wind_gust_speed_10` (km/h), `wind_direction_10`, `precipitation_10`/`precipitation_60` (mm), `relative_humidity`, `pressure_msl` (hPa), `visibility` (m), `cloud_cover`, `dew_point`, `sunshine_60`; `sources[]` mit `station_name`, `distance`, `observation_type` |
| `GET /alerts` | `lat`, `lon` | `alerts[]` mit `severity` (`minor\|moderate\|severe\|extreme`), `urgency`, `event_de`, `headline_de`, `description_de`, `instruction_de`, `onset`, `expires`; `location` mit Warnzelle, Kreis, Bundesland |

**Formatbesonderheiten.** Ein Request je Punkt (keine Bündelung); Messwerte sind
Stationsdaten mit `distance` zum Anfragepunkt; Werte können einzeln `null` sein; Warnungen sind
CAP-basiert und liegen zweisprachig vor. Zeitstempel ISO 8601 mit Offset.

**Limits/Quoten.** Kein API-Key, kein veröffentlichtes Hard-Limit; Fair Use. Eigene
Konfiguration: `WEATHER_REFRESH_SEC=600` (16 Punkte × 2 Endpunkte = 32 Anfragen je 10 min,
Nebenläufigkeit 2), Punktabfragen `WEATHER_POINT_QUERIES_PER_MIN=30` mit Cache auf 0,05°-Raster
und TTL 10 min. Teilausfälle einzelner Punkte werden toleriert (Stale-while-error bis 3 h).

**Verfügbarkeit/SLA.** Keine; spendenfinanziert, historisch stabil.

**Lizenz und Attribution.** DWD-Daten unterliegen der GeoNutzV (§ 3: Quellenvermerk, Änderungen
kennzeichnen); Bright Sky weist darauf hin, dass die DWD-Nutzungsbedingungen für alle abgerufenen
Daten gelten. Warnungstexte sind unverändert mit Zeitbezug wiederzugeben. Text:
`Datenbasis: Deutscher Wetterdienst (DWD), bereitgestellt über Bright Sky`

**Alternativen.** Eigene Bright-Sky-Instanz (Docker, `brightsky-infrastructure`), direkter
Abruf vom DWD-Open-Data-Server (MOSMIX/POI-CSV, Warnungen als CAP/JSON), Open-Meteo (Abschnitt 4).

**Risiken.** Ausfall des Community-Dienstes, DWD-Formatänderungen, Stationsabstand zur Anfrage
(Messwert gilt nicht exakt am Bahnhof).

## 4. Wetter (Fallback): Open-Meteo

**Zweck.** Ersatz, wenn Bright Sky nicht antwortet; keine Warnungen (Alerts nur über Bright Sky).

**Betreiber.** Open-Meteo (Schweiz), Open-Source-Modell-Aggregator (u. a. DWD ICON).

**Endpunkt.** `GET /v1/forecast?latitude=52.5,53.5&longitude=13.4,10.0&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day&wind_speed_unit=kmh&timezone=Europe%2FBerlin`

**Formatbesonderheiten.** Ein gebündelter Request für alle Punkte; bei mehreren Standorten ist
die Antwort ein **Array**, bei einem Standort ein Objekt (beides behandeln). Wetterlage als
WMO-Code (0 klar, 1–3 bewölkt, 45/48 Nebel, 51–57 Niesel, 61–67 Regen, 71–77 Schnee, 80–82
Regenschauer, 85/86 Schneeschauer, 95–99 Gewitter) → `wmoCodeToIcon(code, isDay)`. Werte sind
Modellwerte, keine Messungen.

**Limits/Quoten.** Kostenlos nur für nicht-kommerzielle Nutzung: 10 000 Anfragen/Tag,
5 000/Stunde, 600/Minute; kommerzielle Nutzung erfordert ein Abonnement. Eigener Bedarf: eine
Anfrage je Refresh.

**Verfügbarkeit/SLA.** Keine für den Free-Tier.

**Lizenz und Attribution.** Daten CC BY 4.0. Text (nur wenn der Provider aktiv ist):
`Wetterdaten: Open-Meteo.com (CC BY 4.0)`

**Risiken.** Bei Monetarisierung entfällt die Kostenfreiheit; keine amtlichen Warnungen.

## 5. Karte: eigener Kartenserver `maps.paulbartsch.de`

**Zweck.** Grundkarte (Vektorkacheln), Glyphen und Sprites für MapLibre.

**Betreiber.** Der Betreiber der App selbst; damit keine Drittanbieter-Requests aus dem Browser.

**Schnittstelle.** `MAP_STYLE_URL=https://maps.paulbartsch.de/style/style.json` (MapLibre-Style
Version 8), Kacheln als PMTiles über HTTP-Range-Requests (`pmtiles://`-Protokoll im Client),
Glyphen/Sprites laut Style. Origins des Kartenservers werden in die CSP (`img-src`,
`connect-src`) aufgenommen (`MAP_EXTRA_ORIGINS` für weitere). Alternativ `MAP_MODE=raster`:
serverseitiger Proxy `/map/raster/{z}/{x}/{y}.png` mit Cache und generiertem `/map/style.json`.
Text-Labels der Züge werden nur gerendert, wenn der Style eine `glyphs`-URL besitzt.

**Software.** MapLibre GL JS 6.7 und PMTiles 4.5, beide BSD-3-Clause, ausgeliefert aus
`public/vendor/` mit Lizenztexten.

**Lizenz und Attribution.** Kartendaten OpenStreetMap unter ODbL 1.0; Pflichttext
`© OpenStreetMap-Mitwirkende` (`MAP_ATTRIBUTION`), dauerhaft sichtbar im Kartenrand mit Link auf
`https://www.openstreetmap.org/copyright`. Falls die Kacheln mit dem OpenMapTiles-Schema
(Planetiler) erzeugt wurden, zusätzlich `© OpenMapTiles` (CC BY 4.0); Natural-Earth-Anteile
sind gemeinfrei.

**Limits/SLA.** Eigene Infrastruktur; Verfügbarkeit liegt beim Betreiber.

**Alternativen.** Fremde Kachel-Dienste (würden Drittanbieter-Requests und damit Änderungen in
Datenschutzerklärung und CSP erfordern), Raster-Modus mit lokalem Tile-Server.

**Risiken.** Fehlende oder verdeckte OSM-Attribution ist ein Lizenzverstoß; PMTiles-Datei ist
eine abgeleitete Datenbank (ODbL 4.6, siehe `RECHTLICHES.md` 5.2).

## 6. Stationsverzeichnis: `db-stations` (DB StaDa Open Data)

**Zweck.** Namen, EVA-Nummern, DS100-Kürzel, Koordinaten, Kategorie und Bundesland von 5 388
Stationen: Koordinaten-Fallback für Upstream-Stops, Namensauflösung (`findStation`,
tolerant gegenüber Schreibvarianten), Bahnhofssuche, Grundlage von `capitals.js` und `hubs.js`.

**Quelle.** npm-Paket `db-stations` 5.0.2 (ISC, Jannis R), abgeleitet aus der DB-API
*Station Data (StaDa)*, veröffentlicht als Open Data unter CC BY 4.0 durch die Deutsche Bahn AG
(heute DB InfraGO AG). In `src/data/db-stations.json` gekürzt auf `{id, name, ril100, lat, lon,
cat, state, w}`; `_meta` dokumentiert Herkunft und Felder. Stationen ohne IBNR fehlen.

**Formatbesonderheiten.** `id` = EVA-Nummer (7-stellig, identisch mit den Stop-IDs von
transport.rest für Bahnhöfe); `cat` 1–7; `w` Gewichtung nach Fahrgastaufkommen (db-stations).

**Aktualisierung.** Paket neu installieren und Extraktionsskript erneut ausführen; Stand der
Paketdaten prüfen (Bahnhofsneubauten, Umbenennungen).

**Lizenz und Attribution.** CC BY 4.0 verlangt Namensnennung, Lizenzlink und Änderungshinweis:
`Stationsdaten: © Deutsche Bahn AG / DB InfraGO AG (Station Data, StaDa), CC BY 4.0, aufbereitet über db-stations; gekürzt und umformatiert.`

**Alternativen.** StaDa v2 direkt über den DB API Marketplace (Key), zentrales
Haltestellenverzeichnis zHV (DELFI, CC BY 4.0), `db-hafas-stations`.

**Risiken.** Veraltete Koordinaten oder Namen; Abweichungen zwischen StaDa-Namen und
Upstream-Namen (durch `normalizeStationName` abgefangen).

## 7. Bundesländergrenzen: `deutschlandGeoJSON`

**Zweck.** Dezente Flächen- und Linienebene, Zuordnung der Landeshauptstädte.

**Quelle.** `isellsoap/deutschlandGeoJSON`, Datei `2_bundeslaender/3_mittel.geo.json`
(vereinfacht, Toleranz 0,005, 16 `MultiPolygon`-Features mit `properties.id = 'DE-XX'`).
Repository archiviert, Lizenz Unlicense; Rohdaten laut README DIVA-GIS/GADM (nur
nicht-kommerzielle Nutzung).

**Lizenz und Attribution.** Unlicense verlangt nichts; empfohlener Hinweis auf der
Quellen-Seite: `Bundesländergrenzen: deutschlandGeoJSON (isellsoap), Rohdaten GADM/DIVA-GIS`.

**Alternative (Pflicht bei kommerzieller Nutzung).** BKG *Verwaltungsgebiete 1:2 500 000*
(VG2500), dl-de/by-2-0, Konvertierung mit `ogr2ogr -f GeoJSON -t_srs EPSG:4326`, Attribution
`© GeoBasis-DE / BKG (2025) dl-de/by-2-0`. Oder OSM-Verwaltungsgrenzen (ODbL).

**Risiken.** Lizenzkette unklar; vereinfachte Geometrie (Küsten, Inseln) nur für die Übersicht
geeignet.

## 8. Eigene Datensätze

`src/data/ice-corridors.geo.json` (schematische Hauptkorridore, erzeugt aus
`ice-corridors.source.js` über `findStation`), `src/data/capitals.js` und `src/data/hubs.js` sind
eigene Werke des Projekts. Sie sind keine amtlichen Streckendaten und nur als Fallback-Geometrie
und Auswahlliste gedacht. Lizenz: wie das Projekt (MIT) bzw. ausdrücklich CC BY 4.0 für die
Daten (in der README festlegen).

## 9. Welche Information kommt woher

| Information in der App | Quelle | Feld/Verfahren | Hinweise |
|---|---|---|---|
| Zugposition | transport.rest `trip()` + Geometrie | Zeitliche Interpolation zwischen Halten (`computePosition`), Echtzeit vor Plan; Geometrie aus `polyline`, sonst Korridor, sonst Luftlinie | Berechnet, nicht gemessen; `source` und `state` im Feature |
| Verspätung / Status | transport.rest | `delay` (Sekunden) → `delaySec`, `delayMin`; `classifyDelay`: ≤ 5 min pünktlich, 6–15 leicht, 16–60 verspätet, > 60 stark | `null` → „unbekannt“; Ausfall über `cancelled` |
| Störungen (HIM-Meldungen) | transport.rest `remarks` in Trips und Boards | `type` `warning`/`status`, Stichwortfilter, Kategorisierung, `zwischen X und Y` → Segment | Boards enthalten nur wichtigste Remarks; Dedup über SHA-1 |
| Gleiswechsel | transport.rest | `platform` ≠ `plannedPlatform` (Boards, Stopovers) | `prognosedPlatform` optional |
| Auslastung | transport.rest `trip()` | `loadFactor` (`low-to-medium`, `high`, `very-high`, `exceptionally-high`) | Nicht in Boards; nicht für alle Züge |
| Abfahrtstafeln der Landeshauptstädte | transport.rest `departures()` | 1-h-Fenster, `BoardSummary` (verspätet > 5 min, ausgefallen, Ø/max Verspätung, nächste 5) | Cache `BOARD_CACHE_SEC` |
| Ausfälle | transport.rest | `cancelled: true` auf Fahrt oder Halt | Position ausgefallener Züge am letzten bekannten Halt |
| Fahrtnummer, Linie, Betreiber | transport.rest `line` | `name`, `fahrtNr`, `productName`, `operator` | `fahrtNr` bei `dbnav` unzuverlässig |
| Wetter an Landeshauptstädten | Bright Sky `/current_weather`, Fallback Open-Meteo | `temperature`, `condition`, `icon`, Wind, Niederschlag | Provider im `attribution`-Feld der Antwort |
| Wetterwarnungen | Bright Sky `/alerts` | `severity`, `headline_de`, `onset`, `expires` | Kein Fallback |
| Wetter am Zug | Bright Sky/Open-Meteo über `/api/weather/point` | Zugkoordinate, Cache 0,05°-Raster | Budget `WEATHER_POINT_QUERIES_PER_MIN` |
| Bundesländergrenzen | `bundeslaender.geo.json` | statisch, `/api/bundeslaender` | ETag, 1 Tag Cache |
| Bahnhöfe, Koordinaten, Suche | `db-stations` (`stations.js`) | `findStation`, `searchStations`, `/api/stations/search` | Fallback `/locations` upstream |
| ICE-Hauptstrecken | `ice-corridors.geo.json` | statisch, `/api/corridors`; `routeBetween` für Positionsfallback | schematisch |
| Grundkarte | `maps.paulbartsch.de` | MapLibre-Style, PMTiles | OSM-Attribution Pflicht |
