# Architekturentscheidungen (ADR)

Kurzprotokoll der wesentlichen Entscheidungen. Format: Kontext → Entscheidung → Konsequenzen.

## ADR-001: Positionsermittlung durch zeitliche Interpolation statt Radar-Endpunkt

**Kontext.** Der frühere HAFAS-Endpunkt `/radar` (Fahrzeugpositionen in einem Kartenausschnitt) existiert auf
`v6.db.transport.rest` nicht mehr; das Backend (`db-vendo-client`) unterstützt ihn nicht. Die DB-Apps liefern keine
GPS-Positionen über diese Schnittstellen.

**Entscheidung.** Fahrten werden über die Abfahrtstafeln von rund 100 Knotenbahnhöfen entdeckt und anschließend
einzeln über `/trips/:id` (Halte mit Plan-/Ist-Zeiten, optional Polyline) geladen. Die Position zum Zeitpunkt *t* wird
serverseitig aus den Ist-Zeiten der umgebenden Halte entlang der Streckengeometrie interpoliert (Polyline → Korridor →
Luftlinie als Fallback-Kette).

**Konsequenzen.** Positionen sind rechnerisch (± wenige Kilometer), nicht gemessen. Zwischen zwei Aktualisierungen
bewegt sich der Zug dennoch flüssig. Die Genauigkeit hängt von der Aktualität der Verspätungsdaten ab; Datenalter wird
in der UI angezeigt.

## ADR-002: Anfragebudget, Caching und Circuit-Breaker gegenüber transport.rest

**Kontext.** transport.rest erlaubt 100 Anfragen/Minute, das DB-Backend etwa 60/Minute und blockiert bei Überlast. Bei
150–250 gleichzeitig laufenden ICE-Fahrten wäre eine naive Aktualisierung aller Fahrten pro Minute unmöglich.

**Entscheidung.** Ein Token-Bucket (Standard 40/min) begrenzt alle Upstream-Anfragen. Der Poller priorisiert laufende
Fahrten nach Datenalter, hält einen Mindestabstand pro Fahrt ein (Standard 3 min) und reserviert 20 % des Budgets für
Nutzeranfragen (Abfahrtstafeln, Detailaktualisierung). Ein Circuit-Breaker pausiert bei 429/5xx mit exponentiellem
Backoff. Alle Antworten werden serverseitig zwischengespeichert; Clients sprechen ausschließlich mit dem eigenen Server.

**Konsequenzen.** Verspätungsangaben sind im Mittel 2–5 Minuten alt. Die Last auf der Fremd-API ist unabhängig von der
Zahl der Nutzer der Karte (Fair Use).

## ADR-003: MapLibre GL JS + PMTiles statt Leaflet/Raster

**Kontext.** Der Kartenserver des Betreibers liefert Vektorkacheln (`/tiles/europe.pmtiles`, `/style/style.json`,
Glyphen); Rasterkacheln sind nur serverintern erreichbar.

**Entscheidung.** Das Frontend nutzt MapLibre GL JS mit dem PMTiles-Protokoll und lädt den Style direkt vom
Kartenserver. Als Fallback (`MAP_MODE=raster`) proxied die App die Rasterkacheln serverseitig und erzeugt einen
minimalen Raster-Style.

**Konsequenzen.** Der Browser muss den Kartenserver per CORS und HTTP-Range-Requests erreichen (siehe BETRIEB.md).
Overlays (Züge, Korridore, Grenzen) sind GeoJSON-Layer im selben WebGL-Kontext – performant auch bei vielen Objekten.

## ADR-004: Keine externen CDNs, Bibliotheken werden lokal ausgeliefert

**Kontext.** Externe Skript-/Font-Quellen bedeuten Drittanbieter-Requests (DSGVO, Urteil LG München I zu Google Fonts)
und ein Supply-Chain-Risiko.

**Entscheidung.** MapLibre und PMTiles werden aus `node_modules` nach `public/vendor/` kopiert (`npm run vendor`,
automatisch bei `npm install`) und mit strikter Content-Security-Policy ausgeliefert. Keine Web-Fonts, keine Analytics.

**Konsequenzen.** Nur der eigene Server und der eigene Kartenserver werden vom Browser kontaktiert. Updates der
Bibliotheken laufen über `npm`, Versionen sind in `package-lock.json` fixiert.

## ADR-005: Node.js/Express ohne Build-Schritt, minimale Abhängigkeiten

**Kontext.** Wartbarkeit durch eine Person; Sicherheit der Lieferkette.

**Entscheidung.** Laufzeitabhängigkeiten sind ausschließlich `express`, `helmet`, `express-rate-limit` (plus die beiden
Kartenbibliotheken für den Browser). Tests mit dem eingebauten `node:test`, Logging ohne Fremdbibliothek. Frontend in
nativem ES-Modul-JavaScript ohne Bundler.

**Konsequenzen.** Kleine Angriffsfläche, schnelle Audits (`npm audit`), keine Toolchain-Pflege. Verzicht auf
TypeScript-Typprüfung wird durch JSDoc und Tests kompensiert.

## ADR-006: Streckenkorridore als schematische, versionierte GeoJSON-Datei

**Kontext.** Amtliche Streckengeometrien (DB Open Data „Geo-Streckennetz“, OSM-Relationen) sind in der
Entwicklungsumgebung nicht abrufbar und in der App nur als Kontext nötig.

**Entscheidung.** Die ICE-Hauptstrecken werden als Folge von Bahnhöfen/Stützpunkten beschrieben und mit den
Koordinaten des Stationsverzeichnisses zu Linien aufgelöst (`npm run build:corridors`). Sie dienen der Hervorhebung auf
der Karte und als Fallback-Geometrie für die Interpolation.

**Konsequenzen.** Die Linien sind schematisch (Stützpunkte an Bahnhöfen), nicht gleisgenau. Ein Austausch gegen
amtliche Geometrien ist über dieselbe GeoJSON-Schnittstelle möglich (siehe BETRIEB.md).

## ADR-007: Wetter über DWD (Bright Sky) mit Open-Meteo als Fallback

**Kontext.** Wetter und amtliche Unwetterwarnungen sind für den Bahnbetrieb relevant; DWD-Daten sind amtlich und frei
nutzbar (GeoNutzV), aber nur als Rohdateien verfügbar.

**Entscheidung.** Primär Bright Sky (JSON-API über DWD-Daten inkl. Warnungen), sekundär Open-Meteo (ein gebündelter
Request für alle Landeshauptstädte). Provider-Schnittstelle erlaubt weitere Anbieter.

**Konsequenzen.** Quellenvermerke sind Pflicht und werden in der UI angezeigt. Bei Ausfall beider Anbieter bleiben
die letzten Werte bis zu drei Stunden sichtbar (mit Zeitstempel).
