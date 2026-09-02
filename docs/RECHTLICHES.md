# Rechtliche Einordnung der DB-ICE-Live-Karte

Stand: September 2026. Betreiber: Privatperson, eigener Server, Domain `paulbartsch.de`.
Dieses Dokument ordnet das Projekt nach deutschem und europäischem Recht ein und leitet
konkrete Maßnahmen ab. **Es ersetzt keine Rechtsberatung.** Bei Monetarisierung, Abmahnung
oder Kontaktaufnahme durch die Deutsche Bahn AG ist anwaltlicher Rat einzuholen.

## 1. Zusammenfassung (Ampel)

| Themenfeld | Bewertung | Kernaussage | Handlung |
|---|---|---|---|
| Datenschutz (DSGVO, BDSG, TDDDG) | 🟢 grün | Minimalprinzip umgesetzt: keine Cookies, kein Tracking, keine Drittanbieter im Browser, IP-Anonymisierung. | Datenschutzerklärung aus `public/datenschutz.html` ausfüllen; Log-Rotation 7 Tage auch am Reverse-Proxy. |
| Impressum (§ 5 DDG, § 18 MStV) | 🟡 gelb | Öffentlich erreichbares Angebot außerhalb rein persönlicher Zwecke → Name und Anschrift nach § 18 Abs. 1 MStV; Art. 13 DSGVO verlangt ohnehin Identität und Kontakt. | Vollständiges Impressum in `public/impressum.html` ausfüllen, von jeder Seite in zwei Klicks erreichbar. |
| Fahrplandaten über `v6.db.transport.rest` | 🟡 gelb (privat) / 🔴 rot (kommerziell) | Inoffizielle API ohne Erlaubnis der DB; Datenbankschutz §§ 87a ff. UrhG; Blockierungsrisiko. Für ein privates, nicht-kommerzielles Angebot mit konservativen Limits vertretbar, aber nie „rechtssicher“. | Fair Use einhalten, Kontakt im `USER_AGENT`, Abschaltpfad bereithalten, mittelfristig auf DB API Marketplace oder DELFI-GTFS-RT migrieren. |
| Markenrecht („ICE“, „IC“, „DB“) | 🟢 grün | Beschreibende Nennung nach § 23 Abs. 1 Nr. 2 und 3 MarkenG; keine Logos, kein Corporate Design, Disclaimer vorhanden. | Domain ohne „db“/„deutschebahn“; Disclaimer sichtbar im Footer und Info-Tab. |
| Lizenzen (OSM, DWD, CC BY, BSD, ISC) | 🟢 grün | Alle Quellen permissiv; Pflichten beschränken sich auf Namensnennung und Lizenzhinweise. | Attributionstexte aus Abschnitt 5 wörtlich übernehmen. |
| Bundesländer-Geometrie (GADM-Rohdaten) | 🟡 gelb | Repository „Unlicense“, Rohdaten laut README aber GADM/DIVA-GIS (nur nicht-kommerziell). | Für jede kommerzielle Nutzung durch BKG VG2500 (dl-de/by-2-0) ersetzen. |
| Haftung | 🟢 grün | Unentgeltliches Angebot, keine Reiseauskunft, Hinweis „ohne Gewähr“. | Disclaimer-Text aus Abschnitt 6 verwenden. |
| Barrierefreiheit | 🟢 grün | BFSG und BITV erfassen das private, unentgeltliche Angebot nicht; WCAG-Orientierung freiwillig. | ARIA/Kontrast/Tastaturbedienung wie im Brief umsetzen. |

## 2. Datenschutz

### 2.1 Anwendbarkeit

Die DSGVO gilt, sobald personenbezogene Daten verarbeitet werden. IP-Adressen sind
personenbezogen (EuGH, C-582/14 „Breyer“). Die Haushaltsausnahme des Art. 2 Abs. 2 lit. c DSGVO
greift für eine öffentlich zugängliche Website nicht (EuGH, C-101/01 „Lindqvist“). Der Betreiber
ist Verantwortlicher im Sinne des Art. 4 Nr. 7 DSGVO. Ein Datenschutzbeauftragter ist nicht
erforderlich (§ 38 Abs. 1 BDSG: erst ab 20 ständig beschäftigten Personen). Eine
Datenschutz-Folgenabschätzung (Art. 35 DSGVO) ist mangels hohen Risikos nicht nötig.

### 2.2 Verarbeitungsübersicht

| Verarbeitung | Daten | Zweck | Rechtsgrundlage | Speicherdauer | Empfänger |
|---|---|---|---|---|---|
| Auslieferung der Seite (HTTP) | IP-Adresse, User-Agent, angeforderte URL, Zeitpunkt | Bereitstellung des Dienstes, Sicherheit | Art. 6 Abs. 1 lit. f DSGVO (Erwägungsgrund 49) | Nur für die Dauer der Verbindung | Hoster (Auftragsverarbeiter, Art. 28 DSGVO) |
| Server-Log der Anwendung | Methode, Pfad ohne Query-String, Status, Dauer, **anonymisierte** IP (`anonymizeIp`) | Fehleranalyse, Missbrauchserkennung | Art. 6 Abs. 1 lit. f DSGVO | 7 Tage, dann Löschung (Rotation) | keine |
| Rate-Limiting (`express-rate-limit`) | IP-Adresse als Zähler im Arbeitsspeicher | Schutz vor Überlastung und Missbrauch | Art. 6 Abs. 1 lit. f DSGVO | Zeitfenster 60 s, flüchtig | keine |
| Reverse-Proxy-Log (nginx/Caddy) | ggf. vollständige IP | Betrieb | Art. 6 Abs. 1 lit. f DSGVO | **Ebenfalls auf 7 Tage begrenzen und anonymisieren** | keine |
| Local Storage (`dbkarte.*`) | Theme, aktive Ebenen | Vom Nutzer gewählte UI-Einstellungen | § 25 Abs. 2 Nr. 2 TDDDG; keine personenbezogenen Daten | Bis zur Löschung durch den Nutzer | keine (verlässt das Gerät nicht) |
| Serverseitige Upstream-Abfragen (transport.rest, Bright Sky, Open-Meteo) | Keine Nutzerdaten; nur Bahnhofs-IDs, Trip-IDs, Zugkoordinaten | Datenbeschaffung | entfällt (keine personenbezogenen Daten) | – | Server-IP des Betreibers wird an die Quelle übermittelt |

Das Interesse des Betreibers (funktionsfähiger, sicherer Betrieb) überwiegt die Interessen der
Nutzer, weil die Daten sofort anonymisiert werden, keine Profilbildung stattfindet und die
Nutzer mit einer solchen Verarbeitung rechnen müssen (Art. 6 Abs. 1 lit. f, Erwägungsgrund 47).

### 2.3 Endgeräte-Zugriff (§ 25 TDDDG)

§ 25 Abs. 1 TDDDG (Telekommunikation-Digitale-Dienste-Datenschutz-Gesetz, seit 14.05.2024
Nachfolger des TTDSG) verlangt eine Einwilligung für jede Speicherung von Informationen auf dem
Endgerät und jeden Zugriff darauf, technologieneutral, also auch für Local Storage. Die Ausnahme
in § 25 Abs. 2 Nr. 2 TDDDG erfasst Speicherungen, die „unbedingt erforderlich“ sind, um einen vom
Nutzer „ausdrücklich gewünschten“ Dienst bereitzustellen. Die Orientierungshilfe der
Datenschutzkonferenz für Telemedien (Version 1.1, Dezember 2022) ordnet vom Nutzer aktiv gewählte
Einstellungen (Sprache, Darstellung) dieser Ausnahme zu. Theme und Ebenenauswahl fallen darunter,
weil sie erst durch eine bewusste Nutzerhandlung geschrieben werden. **Ein Consent-Banner ist
nicht erforderlich.** Es werden keine Cookies gesetzt; `helmet`, `express-rate-limit` und
`express.static` setzen keine. Zu prüfen ist, ob die eingesetzte MapLibre-Version die
Browser-Cache-API für Kacheln nutzt; falls ja, gilt dies als technisch notwendig und ist in der
Datenschutzerklärung zu nennen.

### 2.4 Keine Drittanbieter, keine Drittlandtransfers

Der Browser lädt ausschließlich Ressourcen vom eigenen Server und vom eigenen Kartenserver
`maps.paulbartsch.de` (durch die CSP erzwungen). Alle Abfragen bei Datenquellen erfolgen
serverseitig; dabei werden keine Nutzerdaten übermittelt. Ein Transfer in Drittländer
(Kapitel V DSGVO) findet nicht statt, sofern der Server in der EU/im EWR steht. Open-Meteo
betreibt Server in der Schweiz (Angemessenheitsbeschluss vorhanden); da ohnehin keine
personenbezogenen Daten übermittelt werden, ist dies unerheblich. Mit dem Hoster ist ein
Auftragsverarbeitungsvertrag (Art. 28 Abs. 3 DSGVO) zu schließen, sofern nicht eigene Hardware
betrieben wird.

### 2.5 Informationspflichten und Betroffenenrechte

Art. 13 DSGVO verlangt zum Zeitpunkt der Erhebung: Identität und Kontakt des Verantwortlichen,
Zwecke, Rechtsgrundlage, berechtigte Interessen, Empfänger, Speicherdauer, Betroffenenrechte
(Art. 15–21), Beschwerderecht bei einer Aufsichtsbehörde (Art. 77), Hinweis auf das
Widerspruchsrecht (Art. 21, hervorgehoben). Die Vorlage `public/datenschutz.html` deckt diese
Punkte ab; Platzhalter `[[BETREIBER_NAME]]`, `[[ANSCHRIFT]]`, `[[E_MAIL]]`, `[[HOSTING_ANBIETER]]`
sind auszufüllen. Ein einfaches Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO) ist zu
empfehlen, weil Server-Logs „nicht nur gelegentlich“ anfallen und die Ausnahme des
Art. 30 Abs. 5 damit unsicher ist; die Tabelle in 2.2 genügt als Grundlage.

### 2.6 Impressumspflicht

* **§ 5 Abs. 1 DDG** (Digitale-Dienste-Gesetz, seit 14.05.2024, vormals § 5 TMG) gilt für
  „geschäftsmäßige, in der Regel gegen Entgelt angebotene“ digitale Dienste. Ein rein privates,
  unentgeltliches Angebot ohne Werbung oder Spendenaufruf mit Gegenleistung fällt grundsätzlich
  nicht darunter. Die Grenze ist unscharf; bereits Sponsoring-Links oder Affiliate-Elemente
  können Geschäftsmäßigkeit begründen.
* **§ 18 Abs. 1 MStV** verpflichtet alle Anbieter von Telemedien, die „nicht ausschließlich
  persönlichen oder familiären Zwecken dienen“, zur Angabe von Name und Anschrift. Eine
  öffentliche Live-Karte dient nicht ausschließlich persönlichen Zwecken. **Diese Pflicht greift.**
  § 18 Abs. 2 MStV (Verantwortlicher für journalistisch-redaktionelle Inhalte) ist nicht
  einschlägig.
* Art. 13 Abs. 1 lit. a DSGVO verlangt unabhängig davon Name und Kontaktdaten.

Ergebnis: Ein vollständiges Impressum mit Name, ladungsfähiger Anschrift (kein Postfach) und
E-Mail-Adresse ist anzulegen; es muss „leicht erkennbar, unmittelbar erreichbar und ständig
verfügbar“ sein (§ 5 Abs. 1 DDG; BGH, I ZR 228/03: zwei Klicks). Wer die Privatanschrift nicht
veröffentlichen will, kann eine c/o-Anschrift eines Impressumsdienstes verwenden; die
Rechtsprechung akzeptiert dies nur, wenn Zustellungen dort zuverlässig ankommen.

## 3. Nutzung der Fahrplan- und Echtzeitdaten

### 3.1 Sachverhalt

`v6.db.transport.rest` ist ein von einer Privatperson betriebener REST-Wrapper (Software:
`db-rest`, ISC-Lizenz) um `db-vendo-client`, der die nicht öffentlich dokumentierten Backend-APIs
von DB Navigator und bahn.de anspricht. Die README von `db-vendo-client` stellt fest: „Strictly
speaking, permission is necessary to use this library with the DB APIs.“ Eine solche Erlaubnis
liegt weder dem Wrapper-Betreiber noch diesem Projekt vor. Die Daten stammen von der Deutschen
Bahn AG (bzw. DB InfraGO AG / DB Fernverkehr AG).

### 3.2 Rechtliche Einordnung

1. **Vertragsrecht.** Die Nutzungsbedingungen von bahn.de und der DB-Navigator-App sehen die
   Nutzung über die Website bzw. App vor; automatisierte Abfragen durch Dritte sind nicht Gegenstand
   der eingeräumten Nutzung. Der Betreiber dieser App schließt jedoch keinen Vertrag mit der DB und
   akzeptiert keine AGB; ein „virtuelles Hausrecht“ ist in der Rechtsprechung nicht anerkannt.
   Vertragliche Ansprüche der DB gegen den Betreiber sind daher unwahrscheinlich; das Risiko liegt
   beim Betreiber des Wrappers.
2. **Datenbankherstellerrecht (§§ 87a ff. UrhG).** Fahrplan- und Echtzeitdaten sind als reine
   Tatsachen nicht urheberrechtlich geschützt (§ 2 Abs. 2 UrhG), die Fahrplandatenbank der DB ist
   aber eine Datenbank mit wesentlicher Investition (§ 87a Abs. 1 UrhG). Nach § 87b Abs. 1 S. 1
   UrhG ist die Vervielfältigung eines nach Art oder Umfang wesentlichen Teils dem Hersteller
   vorbehalten; nach § 87b Abs. 1 S. 2 UrhG steht dem die „wiederholte und systematische“
   Entnahme unwesentlicher Teile gleich, wenn sie einer normalen Auswertung zuwiderläuft oder die
   berechtigten Interessen des Herstellers unzumutbar beeinträchtigt (EuGH, C-203/02 „BHB/William
   Hill“; EuGH, C-202/12 „Innoweb/Wegener“ zu Meta-Suchmaschinen). Die App entnimmt laufend
   Abfahrtstafeln von rund 100 Knoten und einige hundert Fahrten pro Stunde, gemessen am
   Gesamtfahrplan ein unwesentlicher Teil. Ob die dauerhafte Wiederholung die Schwelle des
   S. 2 überschreitet, ist offen; für einen privaten, nicht-kommerziellen Zweck mit begrenztem
   Volumen und ohne Substitution des DB-Angebots (keine Fahrplanauskunft, kein Ticketverkauf)
   spricht Vieles gegen eine „unzumutbare Beeinträchtigung“. Die Schranke des § 87c Abs. 1 Nr. 1
   UrhG (privater Gebrauch) gilt ausdrücklich nicht für elektronische Datenbanken. Der Schutz
   erneuert sich bei wesentlichen Aktualisierungen (§ 87a Abs. 1 S. 2, § 87d UrhG), Fahrpläne sind
   also dauerhaft geschützt.
3. **Lauterkeitsrecht (UWG).** Screen Scraping ist nicht per se unlauter (BGH, I ZR 224/12
   „Flugvermittlung im Internet“); unlauter wird es bei Umgehung technischer Schutzmaßnahmen
   (§ 4 Nr. 4 UWG). Ansprüche setzen ein Wettbewerbsverhältnis voraus (§ 8 Abs. 3 Nr. 1 UWG),
   das bei einem privaten, unentgeltlichen Angebot fehlt. Bei Monetarisierung entsteht es sofort.
4. **Strafrecht.** § 202a StGB (Ausspähen von Daten) scheidet aus, weil kein Zugangsschutz
   überwunden wird; § 303b StGB (Computersabotage) nur bei gezielter Überlastung.
5. **Faktisches Risiko.** Die DB blockiert „teils aggressiv“ nach IP; der Wrapper kann jederzeit
   abgeschaltet werden. Eine Abmahnung mit Unterlassungsanspruch (§ 97 Abs. 1 UrhG) ist bei
   Privatnutzung selten, aber möglich; Schadensersatz (§ 97 Abs. 2 UrhG) setzt Verschulden voraus
   und wäre mangels Gewinn gering.

### 3.3 Unterschied privat vs. kommerziell

| Kriterium | Privat, nicht-kommerziell (aktueller Zustand) | Kommerziell (Werbung, Bezahlschranke, Dienst für Dritte) |
|---|---|---|
| Wettbewerbsverhältnis (UWG) | nein | ja |
| § 87b Abs. 1 S. 2 UrhG | eher nicht erfüllt | erhöhte Wahrscheinlichkeit |
| Bereitschaft der DB zum Vorgehen | gering | hoch |
| Empfehlung | Betrieb mit Fair Use vertretbar | Nur mit lizenzierter Quelle (Abschnitt 3.4) |

### 3.4 Rechtssichere Alternativen

* **DB API Marketplace** (`developers.deutschebahn.com`): Registrierung, API-Schlüssel, ausdrückliche
  Nutzungsbedingungen. Geeignet: *RIS::Boards* (Abfahrten/Ankünfte bis 12 h, Störungsmeldungen),
  *Timetables* (IRIS, XML). Keine Polylines, keine Auslastung; Trip-IDs im RIS-Format. Kostenloser
  Basisplan mit Quoten; Quellenvermerk gemäß den jeweiligen Bedingungen.
* **DELFI GTFS + GTFS-RT** über die mobilithek (Registrierung kostenlos, Lizenz CC BY 4.0). Die
  delegierte Verordnung (EU) 2017/1926 (MMTIS) in der Fassung der Verordnung (EU) 2024/490
  verpflichtet Verkehrsunternehmen schrittweise zur Bereitstellung dynamischer Daten über den
  nationalen Zugangspunkt, sodass die Qualität dieser Quelle steigt. Lokale Auswertung mit
  MOTIS oder Nutzung von Transitous (Usage Policy beachten). Das ist die einzige echte
  Open-Data-Quelle für Echtzeitdaten.
* **Eigene db-rest-Instanz**: technisch unabhängiger vom Wrapper-Betreiber, rechtlich identisch
  (die DB-APIs werden dann direkt vom eigenen Server angesprochen; das Blockierungsrisiko trifft
  die eigene IP).

Der Datenquellenadapter (`src/transport/transport-rest-client.js` + `normalize.js`) ist der einzige
Ort, der beim Wechsel angepasst werden muss (siehe `docs/DATENQUELLEN.md`).

### 3.5 Fair Use und Kennzeichnung

Verbindlich: `UPSTREAM_MAX_RPM` höchstens 40 (Limit des Wrappers 100/min, des Backends ca.
60/min), `HUB_POLL_INTERVAL_SEC` mindestens 600, `TRIP_REFRESH_MIN_SEC` mindestens 180, Caching,
Circuit-Breaker mit Backoff, sofortiger Stopp bei HTTP 429. `USER_AGENT` mit Projekt-URL **und**
E-Mail-Adresse, damit Wrapper-Betreiber und DB Kontakt aufnehmen können, bevor sie blockieren.
Jede Anzeige trägt den Hinweis „Alle Angaben ohne Gewähr“, und die App bietet keine
Verbindungsauskunft, um nicht in den Kernbereich des DB-Angebots einzugreifen.

## 4. Markenrecht

„ICE“, „IC“, „DB“, „Deutsche Bahn“ und das DB-Logo sind eingetragene Marken der Deutschen Bahn AG
(deutsche Marken und Unionsmarken). Schutz: § 14 Abs. 2 MarkenG, Art. 9 Abs. 2 UMV; bekannte
Marken zusätzlich § 14 Abs. 2 Nr. 3 MarkenG, Art. 9 Abs. 2 lit. c UMV.

* **Beschreibende Benutzung ist zulässig.** § 23 Abs. 1 Nr. 2 MarkenG und Art. 14 Abs. 1 lit. b
  UMV erlauben Angaben über Merkmale der Dienstleistung, § 23 Abs. 1 Nr. 3 MarkenG und
  Art. 14 Abs. 1 lit. c UMV den Hinweis auf die Bestimmung, sofern die Benutzung „den anständigen
  Gepflogenheiten in Gewerbe oder Handel entspricht“ (§ 23 Abs. 2 MarkenG). Eine Karte, die zeigt,
  wo ICE-Züge fahren, muss „ICE“ nennen dürfen; das ist Bestimmungsangabe, nicht markenmäßige
  Benutzung. Dasselbe gilt für die Quellenangabe „Deutsche Bahn“.
* **Ob „geschäftlicher Verkehr“ vorliegt** (§ 14 Abs. 2 MarkenG), ist bei einem privaten,
  unentgeltlichen Angebot bereits fraglich; darauf sollte man sich aber nicht verlassen.
* **Grenzen:** keine Logos, kein DB-Rot als Leitfarbe, keine Nachbildung der Hausschrift oder des
  App-Layouts (§ 4 Nr. 3 UWG, § 5 Abs. 2 UWG bei Herkunftstäuschung), keine Bezeichnung, die eine
  Verbindung zur DB suggeriert. Der Titel „ICE-Live-Karte“ ist beschreibend und unbedenklich;
  „DB-Live-Karte“ als öffentlicher Titel wäre es nicht.
* **Domain:** keine Domain mit „db“, „deutschebahn“, „bahn“ als prägendem Bestandteil
  (§ 14, § 15 MarkenG, § 12 BGB). `ice.paulbartsch.de` oder `bahnkarte.paulbartsch.de` als
  Subdomain der eigenen Domain sind vertretbar; der Name des Betreibers bleibt prägend.
* **Disclaimer** (Footer, Info-Tab, Impressum): „Inoffizielles Angebot – nicht mit der Deutschen
  Bahn AG verbunden. ICE, IC und DB sind Marken der Deutschen Bahn AG. Alle Angaben ohne Gewähr.“

## 5. Lizenzen und Attribution

### 5.1 Übersicht

| Quelle | Lizenz | Pflichten | Pflichttext (wörtlich) | Platzierung |
|---|---|---|---|---|
| OpenStreetMap-Daten (über `maps.paulbartsch.de`) | ODbL 1.0 | Sichtbarer Hinweis auf der Karte (OSMF Attribution Guidelines) mit Link auf `openstreetmap.org/copyright` | `© OpenStreetMap-Mitwirkende` | Karten-Attribution (MapLibre-Control, dauerhaft sichtbar), Quellen-Seite |
| Kachelschema/Style (falls OpenMapTiles/Planetiler) | CC BY 4.0 | Namensnennung | `© OpenMapTiles` | Karten-Attribution |
| MapLibre GL JS 6.7 | BSD-3-Clause | Copyright- und Lizenztext in der Distribution | Datei `public/vendor/LICENSE-maplibre-gl.txt` | Ausgeliefert; Nennung im Info-Tab freiwillig |
| PMTiles 4.5 | BSD-3-Clause | wie oben | Datei `public/vendor/LICENSE-pmtiles.txt` | wie oben |
| DWD-Wetterdaten über Bright Sky | GeoNutzV (§ 3: Quellenvermerk, Änderungen kennzeichnen); Bright Sky: MIT | Quellenvermerk „Deutscher Wetterdienst“, Warnungstexte unverändert wiedergeben | `Datenbasis: Deutscher Wetterdienst (DWD), bereitgestellt über Bright Sky` | Wetter-Tab, Wetter-Chips (Tooltip), Quellen-Seite |
| Open-Meteo (Fallback) | CC BY 4.0 (Daten); API nur nicht-kommerziell kostenlos | Namensnennung mit Link | `Wetterdaten: Open-Meteo.com (CC BY 4.0)` | Wetter-Tab, wenn aktiv; Quellen-Seite |
| Fahrplan-/Echtzeitdaten (Deutsche Bahn über transport.rest) | keine Lizenz eingeräumt (siehe Abschnitt 3); Wrapper-Software ISC | keine Lizenzpflicht; Quellenangabe aus Transparenz und Markenrecht (§ 23 MarkenG) geboten | `Fahrplan- und Echtzeitdaten: Deutsche Bahn AG, abgerufen über v6.db.transport.rest (inoffizielle Community-API). Alle Angaben ohne Gewähr.` | Info-Tab, Quellen-Seite |
| Stationsverzeichnis (`db-stations` 5.0.2) | Software ISC; Daten CC BY 4.0 (DB StaDa Open Data) | Namensnennung, Lizenzlink, Änderungshinweis (CC BY 4.0 Ziff. 3 lit. a) | `Stationsdaten: © Deutsche Bahn AG / DB InfraGO AG (Station Data, StaDa), CC BY 4.0, aufbereitet über db-stations; gekürzt und umformatiert.` | Info-Tab, Quellen-Seite |
| Bundesländergrenzen (`isellsoap/deutschlandGeoJSON`) | Repository: Unlicense (Public Domain); Rohdaten laut README DIVA-GIS/GADM (nur nicht-kommerziell) | Unlicense: keine; GADM: keine kommerzielle Nutzung, keine Weitergabe ohne Erlaubnis | `Bundesländergrenzen: deutschlandGeoJSON (isellsoap), Rohdaten GADM/DIVA-GIS` | Quellen-Seite |
| BKG VG2500 (Ersatz für kommerzielle Nutzung) | dl-de/by-2-0 | Quellenvermerk mit Jahr und Lizenzlink | `© GeoBasis-DE / BKG (2025) dl-de/by-2-0` | Quellen-Seite |
| Eigener Code | MIT | LICENSE-Datei im Repository | – | Repository |

### 5.2 Lizenzkompatibilität

Alle Software-Lizenzen (MIT, ISC, BSD-3-Clause) sind untereinander und mit der MIT-Lizenz des
Projekts kompatibel; die Lizenztexte der ausgelieferten Browser-Bibliotheken liegen bereits in
`public/vendor/`. Datenlizenzen (CC BY 4.0, dl-de/by-2-0, GeoNutzV) sind Namensnennungslizenzen
ohne Copyleft; sie verlangen nur Attribution und Änderungshinweise. Die ODbL enthält
Share-alike, das aber nur für **abgeleitete Datenbanken** gilt (ODbL 4.4), nicht für „Produced
Works“ wie die gerenderte Karte (ODbL 4.3). Solange keine OSM-Daten in die eigenen Datensätze
(Korridore, Stationen, Grenzen) gemischt werden, entsteht keine Share-alike-Pflicht. Für den
Kartenserver selbst gilt: Die PMTiles-Datei ist eine abgeleitete Datenbank; bei öffentlicher
Nutzung ist nach ODbL 4.6 anzubieten, sie oder das Erzeugungsrezept auf Anfrage
bereitzustellen. Die MIT-Lizenz des Codes erstreckt sich **nicht** auf die Datendateien in
`src/data/`; die README muss die abweichenden Datenlizenzen nennen. Eigene Datensätze (Korridore,
Landeshauptstädte, Knoten) sollten ausdrücklich lizenziert werden (Empfehlung: CC BY 4.0 oder
CC0).

### 5.3 Unlicense-Repository vs. GADM-Rohdaten

Der Autor von `deutschlandGeoJSON` konnte die Geometrie nur insoweit unter Unlicense stellen, wie
er selbst Rechte daran hatte. GADM erlaubt nur akademische und andere nicht-kommerzielle Nutzung
und untersagt die Weitergabe ohne Erlaubnis. Für die private App ist die Nutzung unkritisch; bei
jeder kommerziellen Nutzung ist die Datei durch BKG VG2500 (dl-de/by-2-0, kostenfrei, amtlich)
oder durch OSM-Grenzen (ODbL) zu ersetzen. Die `_meta`-Angabe in `src/data/bundeslaender.geo.json`
dokumentiert dies bereits.

## 6. Haftung, Barrierefreiheit, Urheberrecht am eigenen Werk

### 6.1 Haftung

Das DDG enthält, anders als § 7 Abs. 1 TMG a. F., keine eigene Vorschrift über die
Verantwortlichkeit für eigene Inhalte mehr; sie richtet sich nach den allgemeinen Gesetzen
(§§ 823 ff. BGB). Die Haftungsprivilegien für fremde Inhalte stehen seit dem 17.02.2024 in
Art. 4–6 der Verordnung (EU) 2022/2065 (DSA) und sind hier nicht einschlägig, weil die App eigene
Inhalte darstellt. Das Angebot ist unentgeltlich; ein Vertrag mit Nutzern kommt nicht zustande,
sodass keine vertragliche Haftung für Richtigkeit oder Verfügbarkeit besteht (§ 675 Abs. 2 BGB
für bloße Auskünfte). Deliktisch haftet der Betreiber nur für Vorsatz oder Fahrlässigkeit bei
Verletzung absoluter Rechtsgüter (§ 823 Abs. 1 BGB); reine Vermögensschäden (verpasster Zug) sind
nicht erfasst. Ein Haftungsausschluss kann diese Grenzen nicht weiter absenken (Wertung des
§ 309 Nr. 7 BGB), erfüllt aber eine Warnfunktion und beseitigt den Anschein einer
Reiseauskunft. Empfohlener Text (Info-Tab, Impressum):

> „Diese Karte ist ein privates, inoffizielles Angebot und keine Reiseauskunft. Positionen sind
> aus Fahrplan- und Echtzeitdaten berechnet und können von der tatsächlichen Lage abweichen.
> Verbindliche Fahrplan-, Gleis- und Störungsinformationen erhalten Sie ausschließlich von der
> Deutschen Bahn. Eine Gewähr für Richtigkeit, Vollständigkeit und Verfügbarkeit wird nicht
> übernommen.“

### 6.2 Barrierefreiheit

Das BFSG (in Kraft seit 28.06.2025) erfasst Dienstleistungen für Verbraucher, darunter Elemente
von Personenbeförderungsdiensten einschließlich Echtzeit-Reiseinformationen (§ 1 Abs. 3 Nr. 2
BFSG) und Dienstleistungen im elektronischen Geschäftsverkehr (§ 1 Abs. 3 Nr. 5 BFSG). Adressat
sind Wirtschaftsakteure, also der Beförderer bzw. der Anbieter einer entgeltlichen
Verbraucherdienstleistung. Ein privates, unentgeltliches Informationsangebot ohne
Verbrauchervertrag ist kein Wirtschaftsakteur; zudem sind Kleinstunternehmen für
Dienstleistungen ausgenommen (§ 3 Abs. 3 BFSG). Die BITV 2.0 und § 12a BGG binden nur
öffentliche Stellen des Bundes. Eine Rechtspflicht besteht daher nicht; die im Brief
vorgesehene Umsetzung (ARIA, Tastaturbedienung, Kontrast, `prefers-reduced-motion`) orientiert
sich freiwillig an WCAG 2.1 AA und wird empfohlen, weil sie bei späterer Monetarisierung ohnehin
nötig würde.

### 6.3 Urheberrecht am eigenen Code und an eigenen Daten

Der Quellcode ist als Computerprogramm geschützt (§ 69a UrhG); die Korridorliste und die
Knotenauswahl können als Datenbankwerk (§ 4 Abs. 2 UrhG) oder Datenbank (§ 87a UrhG) geschützt
sein. `package.json` nennt MIT, eine `LICENSE`-Datei fehlt noch. Die MIT-Lizenz verlangt bei
Weitergabe die Beibehaltung des Copyright-Vermerks und schließt Gewährleistung aus. Beiträge
Dritter unterliegen automatisch derselben Lizenz, sofern die README das klarstellt.

### 6.4 Anbieterkennzeichnung im Kartenkontext

Die OSM-Attribution ist keine Höflichkeit, sondern Lizenzbedingung (ODbL 4.3) und laut OSMF
Attribution Guidelines dauerhaft, ohne Interaktion sichtbar auf der Karte selbst anzubringen.
Der MapLibre-`AttributionControl` darf daher nicht eingeklappt oder ausgeblendet werden
(`compact: false` oder explizite Attribution im Kartenrand). Zusätzlich gehört eine
Quellen-Seite (`/quellen` oder Info-Tab) mit allen Texten aus 5.1 dazu.

## 7. Checkliste vor Inbetriebnahme

- [ ] `public/impressum.html`: Name, ladungsfähige Anschrift, E-Mail eingetragen; von jeder Seite in maximal zwei Klicks erreichbar.
- [ ] `public/datenschutz.html`: alle Platzhalter ersetzt; Abschnitte Server-Logs (7 Tage, IP-Anonymisierung), Local Storage (§ 25 Abs. 2 Nr. 2 TDDDG), eigener Kartenserver, serverseitige Abfragen, Betroffenenrechte, Beschwerderecht, Hoster als Auftragsverarbeiter; Aufsichtsbehörde des Wohnsitzlandes genannt.
- [ ] Auftragsverarbeitungsvertrag mit dem Hoster geschlossen (entfällt bei eigener Hardware).
- [ ] Attribution geprüft: OSM-Hinweis dauerhaft auf der Karte sichtbar; Texte aus 5.1 im Info-Tab und auf der Quellen-Seite; ggf. „© OpenMapTiles“.
- [ ] Disclaimer aus 4 und 6.1 im Footer, Info-Tab und Impressum.
- [ ] `USER_AGENT` mit Projekt-URL und E-Mail-Adresse gesetzt, z. B. `db-ice-live-karte/0.1.0 (+https://paulbartsch.de/ice; [[E_MAIL]])`.
- [ ] Rate-Limits konservativ: `UPSTREAM_MAX_RPM` ≤ 40, `UPSTREAM_CONCURRENCY` ≤ 2, `HUB_POLL_INTERVAL_SEC` ≥ 600, `TRIP_REFRESH_MIN_SEC` ≥ 180, `TRIP_MAX_TRACKED` ≤ 400; Circuit-Breaker aktiv.
- [ ] `WEATHER_REFRESH_SEC` ≥ 600, `WEATHER_POINT_QUERIES_PER_MIN` ≤ 30; Open-Meteo nur als Fallback und nur bei nicht-kommerziellem Betrieb.
- [ ] Log-Rotation 7 Tage für Anwendungs- **und** Proxy-Logs; Proxy-Log ohne Query-Strings, IP anonymisiert.
- [ ] HTTPS mit gültigem Zertifikat am Reverse-Proxy; `HSTS_ENABLED=true` erst, wenn TLS dauerhaft gesichert ist; `TRUST_PROXY` korrekt gesetzt, damit Rate-Limit und Anonymisierung die Client-IP treffen.
- [ ] Im Browser geprüft (DevTools, Netzwerk): keine Requests außer zu eigener Domain und `maps.paulbartsch.de`; keine Cookies.
- [ ] Kontaktadresse für Beschwerden (DB, Wrapper-Betreiber, Nutzer) im Impressum und im User-Agent; Verfahren festgelegt: bei Aufforderung der DB sofortige Abschaltung des Upstream-Adapters (`DEMO_MODE=true` oder Dienst stoppen).
- [ ] `LICENSE`-Datei (MIT) angelegt; README nennt die abweichenden Datenlizenzen und die Lizenz der eigenen Datensätze.
- [ ] Bei jeder Form von Monetarisierung: Datenquelle auf DB API Marketplace oder DELFI-GTFS-RT umgestellt, Bundesländer durch BKG VG2500 ersetzt, Open-Meteo-Abonnement oder Abschaltung, BFSG-Prüfung wiederholt, Impressum nach § 5 DDG erweitert.
