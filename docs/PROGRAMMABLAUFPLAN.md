# Programmablaufplan (PAP)

Die Diagramme sind in [Mermaid](https://mermaid.js.org/) notiert und werden von GitHub, GitLab und den meisten
Markdown-Editoren gerendert. Symbole nach DIN 66001: Rechteck = Verarbeitung, Raute = Entscheidung, abgerundet =
Start/Ende, Parallelogramm = Ein-/Ausgabe.

## 1. Gesamtsystem (Datenfluss)

```mermaid
flowchart LR
    subgraph Browser["Browser (Nutzer)"]
        UI[MapLibre-Karte + Seitenleiste]
    end
    subgraph App["DB-ICE-Live-Karte (Node.js)"]
        API[/HTTP-API: /api/*, /map/*/]
        STORE[(Trip-Store<br/>Board-Cache<br/>Wetter-Cache)]
        POLL[Poller]
        POS[Positionsinterpolation]
        DIS[Störungsaggregation]
        WX[Wetterdienst]
        HC[HTTP-Client<br/>Allowlist · Timeout · Budget · Breaker]
    end
    subgraph Extern["Externe Quellen (nur serverseitig)"]
        TR[(v6.db.transport.rest)]
        BS[(Bright Sky / DWD)]
        OM[(Open-Meteo)]
    end
    subgraph Karte["Eigener Kartenserver"]
        TILES[(style.json · PMTiles · Glyphen)]
    end
    UI -- "GET /api/trains alle 15 s" --> API
    UI -- "Style, Kacheln (Range), Glyphen" --> TILES
    API --> STORE
    API --> POS
    POLL --> HC
    WX --> HC
    HC --> TR
    HC --> BS
    HC --> OM
    POLL --> STORE
    POLL --> DIS
    WX --> STORE
```

## 2. Serverstart

```mermaid
flowchart TD
    A([Start: node src/server.js]) --> B[Umgebungsvariablen lesen und validieren<br/>config.js]
    B --> C{Konfiguration gültig?}
    C -- nein --> C1[/Fehlermeldung ausgeben/] --> C2([Ende, Exit-Code 1])
    C -- ja --> D[Logger erzeugen<br/>IP-Anonymisierung aktiv]
    D --> E[Statische Daten laden:<br/>Stationen · Landeshauptstädte · Knoten · Korridore · Bundesländer]
    E --> F[Dienste erzeugen:<br/>HTTP-Client, Token-Bucket, Circuit-Breaker,<br/>Upstream-Adapter, Trip-Store, Störungen,<br/>Poller, Wetterdienst]
    F --> G[Express-App erzeugen:<br/>Helmet/CSP · Rate-Limit · Routen · Static]
    G --> H[HTTP-Server lauscht auf HOST:PORT]
    H --> I[Poller starten<br/>Wetterdienst starten]
    I --> J{Signal SIGTERM/SIGINT?}
    J -- nein --> J
    J -- ja --> K[Poller und Timer stoppen]
    K --> L[Server schließen<br/>max. SHUTDOWN_TIMEOUT_MS warten]
    L --> M([Ende, Exit-Code 0])
```

## 3. Poller-Zyklus (Discovery, Aktualisierung, Bereinigung)

```mermaid
flowchart TD
    A([Tick beginnt]) --> B{Läuft bereits ein Tick?}
    B -- ja --> Z([Ende])
    B -- nein --> C{Circuit-Breaker offen?}
    C -- ja --> C1[Backoff verdoppeln, max. 10 min] --> Z
    C -- nein --> D[Knotenbahnhöfe wählen,<br/>deren Abfrage fällig ist<br/>Stufe 1: alle 10 min · Stufe 2: alle 20 min<br/>gleichmäßig verteilt]
    D --> E[/Abfahrtstafeln abrufen<br/>Produkte: ICE bzw. ICE+IC/]
    E --> F{Fehler 429/5xx/Timeout?}
    F -- ja --> F1[Breaker: Fehler zählen<br/>ggf. öffnen] --> Z
    F -- nein --> G[Board in Cache ablegen<br/>neue Trip-IDs als Seed im Store<br/>Remarks an Störungsaggregation]
    G --> H[Fahrten priorisieren:<br/>1. nie geladen und Abfahrt in ≤ 20 min oder vergangen<br/>2. laufend, ältestes Datenalter zuerst<br/>3. übrige]
    H --> I{Budget verfügbar?<br/>Token-Bucket, 20 % Reserve}
    I -- nein --> M
    I -- ja --> J{Mindestabstand seit<br/>letzter Aktualisierung eingehalten?}
    J -- nein --> H
    J -- ja --> K[/GET /trips/:id<br/>stopovers · remarks · polyline/]
    K --> L{Antwort gültig?}
    L -- nein --> L1[Fehlerzähler erhöhen<br/>≥ 5 → Fahrt verwerfen] --> H
    L -- ja --> L2[Trip normalisieren und speichern<br/>Remarks an Störungsaggregation] --> H
    M[Bereinigung:<br/>beendete Fahrten nach 10 min entfernen<br/>Größe auf TRIP_MAX_TRACKED begrenzen<br/>abgelaufene Störungen löschen]
    M --> N[Statistik aktualisieren<br/>nächsten Tick mit Jitter planen]
    N --> Z
```

## 4. Positionsberechnung einer Fahrt (computePosition)

```mermaid
flowchart TD
    A([Eingabe: Trip, Zeitpunkt t]) --> B[Halte filtern:<br/>nicht ausgefallen, mit Koordinaten]
    B --> C{Fahrt ganz ausgefallen<br/>oder < 2 Halte?}
    C -- ja --> C1[Zustand cancelled/unknown<br/>Position am ersten bekannten Halt] --> Z([Ausgabe Position])
    C -- nein --> D[Streckengeometrie bestimmen]
    D --> D1{Polyline vorhanden<br/>und plausibel?<br/>jeder Halt < 5 km vom Stützpunkt}
    D1 -- ja --> D2[Quelle: polyline<br/>Halte monoton auf Stützpunkte abbilden]
    D1 -- nein --> D3{Halte-Paar auf gemeinsamem<br/>ICE-Korridor?}
    D3 -- ja --> D4[Quelle: corridor<br/>Teilstrecke aus Korridor]
    D3 -- nein --> D5[Quelle: linear<br/>Luftlinie zwischen Halten]
    D2 --> E
    D4 --> E
    D5 --> E
    E[Je Halt: Ist-Zeit vor Plan-Zeit<br/>fehlende Abfahrt = Ankunft und umgekehrt]
    E --> F{t vor erster Abfahrt?}
    F -- ja --> F1[Zustand scheduled<br/>Position Startbahnhof] --> Z
    F -- nein --> G{t nach letzter Ankunft?}
    G -- ja --> G1[Zustand finished<br/>Position Zielbahnhof] --> Z
    G -- nein --> H[Segment i finden mit<br/>Abfahrt_i ≤ t ≤ Ankunft_i+1]
    H --> I{t zwischen Ankunft und<br/>Abfahrt desselben Halts?}
    I -- ja --> I1[Zustand at_stop<br/>Position = Halt] --> K
    I -- nein --> J[Anteil f = t − Abfahrt_i / Ankunft_i+1 − Abfahrt_i<br/>Punkt bei f · Segmentlänge entlang Geometrie<br/>Kurs aus Segment]
    J --> J1[Zustand en_route<br/>Geschwindigkeit = Segmentlänge / Fahrzeit]
    J1 --> K[Verspätung = Ankunftsverspätung des nächsten Halts<br/>Status: ≤ 5 min pünktlich · 6–15 leicht · 16–60 verspätet · > 60 stark]
    K --> Z
```

## 5. Bearbeitung einer Client-Anfrage (GET /api/trains)

```mermaid
flowchart TD
    A([Anfrage trifft ein]) --> B[Sicherheits-Header setzen<br/>Helmet/CSP]
    B --> C{Rate-Limit der Client-IP<br/>überschritten?}
    C -- ja --> C1[/429 JSON/] --> Z([Antwort gesendet])
    C -- nein --> D[Query-Parameter validieren<br/>product · bbox · includeScheduled]
    D --> E{gültig?}
    E -- nein --> E1[/400 JSON mit Fehlercode/] --> Z
    E -- ja --> F[Alle Fahrten aus dem Trip-Store lesen]
    F --> G[Für jede Fahrt: computePosition t = jetzt]
    G --> H[Filter anwenden:<br/>Produkt · Bounding-Box · Zustand]
    H --> I[GeoJSON-FeatureCollection erzeugen<br/>meta: generatedAt, count, dataAgeSec]
    I --> J[/200 JSON, Cache-Control: no-store/]
    J --> K[Zugriff protokollieren:<br/>Methode · Pfad ohne Query · Status · Dauer · IP anonymisiert]
    K --> Z
```

## 6. Störungsaggregation (ingestTrip)

```mermaid
flowchart TD
    A([Trip mit Remarks]) --> B[Für jeden Remark]
    B --> C{Typ warning oder status<br/>und Text mit Störungs-Stichwort?}
    C -- nein --> B
    C -- ja --> D[Kategorie bestimmen:<br/>bau · wetter · strecke · zug · sonstiges]
    D --> E[ID = Hash des normalisierten Textes]
    E --> F{ID bereits bekannt?}
    F -- ja --> F1[lastSeen aktualisieren<br/>Fahrt zu affectedTrips ergänzen]
    F -- nein --> G[Betroffene Halte erkennen:<br/>„zwischen X und Y“ · „in X“<br/>Abgleich mit Halten der Fahrt und Stationsverzeichnis]
    G --> H{Genau zwei Halte erkannt?}
    H -- ja --> H1[Segment X–Y setzen]
    H -- nein --> H2[nur Halte-Marker]
    H1 --> I[Störung speichern<br/>firstSeen = lastSeen = jetzt]
    H2 --> I
    F1 --> B
    I --> B
    B -- alle verarbeitet --> Z([Ende])
```

## 7. Wetteraktualisierung

```mermaid
flowchart TD
    A([Timer: alle 10 min]) --> B[Punkte = 16 Landeshauptstädte]
    B --> C[Provider-Kette: Bright Sky → Open-Meteo]
    C --> D[/Provider abfragen<br/>Bright Sky: 1 Request je Punkt<br/>Open-Meteo: 1 gebündelter Request/]
    D --> E{Erfolg?}
    E -- nein, nächster Provider vorhanden --> C
    E -- nein, keiner mehr --> E1[Alte Werte behalten<br/>max. 3 h, Zeitstempel sichtbar] --> Z([Ende])
    E -- ja --> F[Werte normalisieren<br/>Icon-Set, km/h, mm, Quellenvermerk]
    F --> G{Warnungen aktiviert<br/>und Provider = Bright Sky?}
    G -- ja --> G1[/DWD-Warnungen je Punkt abrufen/] --> H
    G -- nein --> H[Cache aktualisieren<br/>updatedAt setzen]
    H --> Z
```

## 8. Frontend-Aktualisierungsschleife

```mermaid
flowchart TD
    A([Seite geladen]) --> B[/GET /api/config/]
    B --> C[Karte initialisieren:<br/>PMTiles-Protokoll · Style-URL · Zoom/Center]
    C --> D[/Statische Ebenen laden:<br/>/api/bundeslaender · /api/corridors · /api/capitals/]
    D --> E[/Live-Daten laden:<br/>/api/trains · /api/disruptions · /api/stations · /api/weather · /api/status/]
    E --> F{Fehler?}
    F -- ja --> F1[Banner „Datenquelle nicht erreichbar“<br/>letzte Daten behalten] --> G
    F -- nein --> F2[Ebenen aktualisieren<br/>Positionen über 15 s tweenen<br/>Listen und Status-Chip aktualisieren] --> G
    G[Warten: Züge 15 s · Störungen 60 s · Bahnhöfe 60 s · Wetter 5 min]
    G --> E
```
