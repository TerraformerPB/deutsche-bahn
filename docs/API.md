# HTTP-API der Anwendung

Alle Endpunkte sind lesend (`GET`), liefern `application/json; charset=utf-8` und benötigen keine Authentifizierung.
Live-Daten tragen `Cache-Control: no-store`, statische Geodaten `Cache-Control: public, max-age=86400` mit ETag.
Fehler haben die Form `{"error": {"code": "…", "message": "…"}}`. Pro Client-IP gilt ein Rate-Limit
(`RATE_LIMIT_PER_MIN`, Standard 120/min; Header `RateLimit-*`, bei Überschreitung HTTP 429).

| Endpunkt | Zweck | Parameter | Antwort (Auszug) |
|---|---|---|---|
| `GET /api/health` | Liveness | – | `{status:"ok", version, uptimeSec}` |
| `GET /api/status` | Betriebszustand | – | `{now, demo, poller:{trackedTrips, activeTrips, lastDiscoveryAt, lastRefreshAt, requestsLastMinute, upstream:{state, lastErrorCode,…}, budget}, weather:{updatedAt, provider}, disruptions:{count}}` |
| `GET /api/config` | Öffentliche Konfiguration | – | `{app, demo, map:{mode, styleUrl, attribution, center, zoom}, transport:{products,…}, weather, attributions:[{name,text,url}], disclaimer}` |
| `GET /api/trains` | Aktuelle Zugpositionen | `product` (kommagetrennt), `bbox=w,s,e,n`, `includeScheduled`, `includeFinished` | GeoJSON `FeatureCollection` + `meta:{generatedAt, count, tracked, dataAgeSec}` |
| `GET /api/trains/:tripId` | Fahrtdetails | `refresh=true` (Aktualisierung, budgetabhängig) | `{trip, position, polyline:{type:"LineString", coordinates}|null, geometry:{source}, stale?}` |
| `GET /api/disruptions` | Störungen | – | `{generatedAt, items:[Disruption]}` |
| `GET /api/stations` | Landeshauptstädte und Knoten mit Board-Zusammenfassung | – | `{generatedAt, capitals:[{…, board, weather, alerts}], hubs:[…]}` |
| `GET /api/stations/search` | Bahnhofssuche | `q` (2–64 Zeichen) | `[{id, name, lat, lon}]` |
| `GET /api/stations/:id/departures` | Abfahrtstafel (Fernverkehr) | – | `{station, fetchedAt, departures:[Departure]}` |
| `GET /api/weather` | Wetter an den Landeshauptstädten | – | `{updatedAt, provider, attribution, items:[{stationId, city, weather, alerts}]}` |
| `GET /api/weather/point` | Wetter an einer Koordinate | `lat`, `lon` | `{weather}` |
| `GET /api/corridors` | ICE-Korridore | – | GeoJSON `FeatureCollection` (LineStrings) |
| `GET /api/bundeslaender` | Bundesländergrenzen | – | GeoJSON `FeatureCollection` |
| `GET /api/capitals` | Landeshauptstädte | – | GeoJSON `FeatureCollection` (Points) |
| `GET /map/style.json` | Raster-Style (nur `MAP_MODE=raster`) | – | MapLibre-Style |
| `GET /map/raster/:z/:x/:y.png` | Kachel-Proxy (nur `MAP_MODE=raster`) | – | PNG |

## Feature-Properties von `/api/trains`

| Feld | Typ | Bedeutung |
|---|---|---|
| `tripId` | string | Fahrt-ID des Upstreams (auch Feature-`id`) |
| `line`, `product`, `productName`, `fahrtNr`, `operator` | string | Linie („ICE 597“), Produktklasse (`nationalExpress`, `national`), Gattung, Zugnummer, Betreiber |
| `direction`, `origin`, `destination` | string | Ziel laut Anzeige, Start- und Endbahnhof |
| `state` | string | `scheduled`, `en_route`, `at_stop`, `finished`, `cancelled`, `unknown` |
| `status` | string | `on_time`, `slight`, `delayed`, `heavy`, `cancelled`, `unknown` |
| `delaySec`, `delayMin` | number\|null | Verspätung (Sekunden bzw. gerundete Minuten), `null` ohne Echtzeitdaten |
| `prevStop`, `nextStop`, `nextStopId`, `nextStopPlannedArrival`, `nextStopArrival` | string\|null | Umgebende Halte und Zeiten (ISO-8601) |
| `bearing`, `speedKmh` | number\|null | Kurs (Grad), geschätzte Geschwindigkeit |
| `source` | string | Geometriequelle der Position: `polyline`, `corridor`, `linear`, `stop` |
| `cancelled`, `loadFactor`, `hasPolyline`, `remarkCount`, `warningCount`, `updatedAt` | – | Ausfall, Auslastung, Polyline vorhanden, Anzahl Hinweise/Warnungen, Zeitpunkt des letzten Ladens |

## Fehlercodes

| HTTP | `code` | Bedeutung |
|---|---|---|
| 400 | `VALIDATION` | Ungültiger Parameter |
| 404 | `NOT_FOUND` | Unbekannte Fahrt/Route |
| 429 | `RATE_LIMITED` | Client-Rate-Limit überschritten oder Kontingent für nutzerausgelöste Upstream-Abrufe (`CLIENT_UPSTREAM_PER_MIN`) bzw. Wetter-Punktabfragen erschöpft |
| 503 | `UPSTREAM_RATE_LIMITED`, `CIRCUIT_OPEN` | Datenquelle vorübergehend nicht abfragbar |
| 502 / 504 | `UPSTREAM_ERROR`, `UPSTREAM_FORMAT`, `UPSTREAM_TIMEOUT` | Fehler der Datenquelle |
| 500 | `INTERNAL` | Interner Fehler (Details nur im Server-Log) |
