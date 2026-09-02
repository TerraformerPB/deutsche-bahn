/**
 * Quelldefinition der ICE-/IC-Hauptkorridore (Schnellfahrstrecken, Ausbaustrecken,
 * Hauptstrecken des Fernverkehrs).
 *
 * Aus dieser Liste erzeugt `scripts/build-corridors.js` reproduzierbar die Datei
 * `src/data/ice-corridors.geo.json`. Die Geometrie ist schematisch: jede Stadt bzw.
 * jeder Bahnhof entlang der realen Strecke dient als Stützpunkt; Schnellfahrstrecken
 * folgen ihren realen Trassen über zusätzliche Koordinaten (Tunnel, Autobahn-Parallel-
 * führung, Abzweige). Auslandsziele und Grenzpunkte sind als Koordinaten hinterlegt.
 *
 * Stützpunkt-Formen (`via`):
 *  - `'Bahnhofsname'`            → wird über `findStation()` aufgelöst (wird als Halt markiert)
 *  - `[lon, lat]`                → reine Koordinate (Trassenpunkt ohne Namen)
 *  - `{ name, lonlat: [lon, lat] }` → benannte Koordinate (Ausland, Abzweig, Grenze)
 *
 * Koordinaten stets in GeoJSON-Reihenfolge `[lon, lat]`.
 *
 * @typedef {string | [number, number] | {name: string, lonlat: [number, number]}} ViaPoint
 * @typedef {{id: string, name: string, kind: 'SFS'|'ABS'|'Hauptstrecke', vmax: number, lines: string[], via: ViaPoint[]}} CorridorSource
 */

/** Benannte Koordinate (Abzweig, Grenzpunkt, ausländischer Bahnhof). */
const pt = (name, lon, lat) => ({ name, lonlat: [lon, lat] });

/** Gemeinsam genutzte Abzweig-/Verknüpfungspunkte (identische Koordinaten in mehreren Korridoren). */
const SORSUM = pt('Abzweig Sorsum (SFS)', 9.875, 52.135);
const BRECKENHEIM = pt('Abzweig Breckenheim (SFS)', 8.36, 50.09);
const PLANENA = pt('Abzweig Planena (Saale-Elster-Talbrücke)', 11.97, 51.41);
const DIEBSTEICH = pt('Hamburg-Diebsteich', 9.93, 53.565);

export const KINDS = Object.freeze(['SFS', 'ABS', 'Hauptstrecke']);

/** @type {CorridorSource[]} */
export const corridorSources = [
  // ---------------------------------------------------------------- Nord / Ost
  {
    id: 'hamburg-berlin',
    name: 'Hamburg – Berlin (ABS 230)',
    kind: 'ABS',
    vmax: 230,
    lines: ['ICE 18', 'ICE 28', 'IC 27'],
    via: [
      'Hamburg Hbf', 'Hamburg-Bergedorf', 'Schwarzenbek', 'Büchen', 'Boizenburg (Elbe)', 'Hagenow Land',
      'Ludwigslust', 'Wittenberge', 'Glöwen', 'Neustadt (Dosse)', 'Friesack (Mark)', 'Nauen',
      'Wustermark', 'Berlin-Spandau', 'Berlin Hbf',
    ],
  },
  {
    id: 'hamburg-hannover',
    name: 'Hamburg – Lüneburg – Uelzen – Hannover',
    kind: 'ABS',
    vmax: 200,
    lines: ['ICE 20', 'ICE 22', 'ICE 25', 'IC 26'],
    via: [
      'Hamburg Hbf', 'Hamburg-Harburg', 'Winsen (Luhe)', 'Lüneburg', 'Bienenbüttel', 'Bad Bevensen', 'Uelzen',
      'Suderburg', 'Unterlüß', 'Eschede', 'Celle', 'Hannover Hbf',
    ],
  },
  {
    id: 'hamburg-altona-hbf',
    name: 'Hamburg-Altona – Dammtor – Hamburg Hbf',
    kind: 'Hauptstrecke',
    vmax: 100,
    lines: ['ICE 20', 'ICE 22', 'ICE 25', 'ICE 28'],
    via: ['Hamburg-Altona', 'Hamburg Dammtor', 'Hamburg Hbf'],
  },
  {
    id: 'hamburg-kiel',
    name: 'Hamburg – Neumünster – Kiel',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 20', 'ICE 28', 'IC 26'],
    via: ['Hamburg Hbf', 'Hamburg Dammtor', DIEBSTEICH, 'Pinneberg', 'Elmshorn', 'Neumünster', [10.06, 54.19], 'Kiel Hbf'],
  },
  {
    id: 'hamburg-flensburg',
    name: 'Hamburg – Neumünster – Schleswig – Flensburg (– Dänemark)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 76', 'IC 76'],
    via: [
      'Hamburg Hbf', 'Hamburg Dammtor', DIEBSTEICH, 'Pinneberg', 'Elmshorn', 'Neumünster', 'Rendsburg', 'Schleswig',
      'Flensburg', pt('Grenze Dänemark (Padborg)', 9.365, 54.83),
    ],
  },
  {
    id: 'hamburg-luebeck',
    name: 'Hamburg – Bad Oldesloe – Lübeck',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 28', 'IC 29'],
    via: ['Hamburg Hbf', [10.09, 53.58], 'Ahrensburg', 'Bad Oldesloe', 'Reinfeld (Holst)', 'Lübeck Hbf'],
  },
  {
    id: 'hamburg-bremen-dortmund',
    name: 'Hamburg – Bremen – Osnabrück – Münster – Hamm – Dortmund (Rollbahn)',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 31', 'IC 30', 'IC 31'],
    via: [
      'Hamburg Hbf', 'Hamburg-Harburg', 'Buchholz (Nordheide)', 'Tostedt', 'Rotenburg (Wümme)', [9.10, 53.06], 'Bremen Hbf',
      'Kirchweyhe', 'Bassum', 'Twistringen', 'Barnstorf (Han)', 'Diepholz', 'Lemförde', 'Bohmte', 'Osnabrück Hbf',
      'Lengerich (Westf)', 'Münster (Westf) Hbf', 'Drensteinfurt', 'Hamm (Westf) Hbf', 'Kamen', 'Dortmund Hbf',
    ],
  },
  {
    id: 'muenster-essen',
    name: 'Münster – Recklinghausen – Gelsenkirchen – Essen',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 31', 'IC 30', 'IC 31'],
    via: ['Münster (Westf) Hbf', 'Dülmen', 'Haltern am See', 'Recklinghausen Hbf', 'Gelsenkirchen Hbf', 'Essen Hbf'],
  },
  {
    id: 'bremen-hannover',
    name: 'Bremen – Verden – Nienburg – Hannover',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['IC 56', 'ICE 56'],
    via: ['Bremen Hbf', 'Achim', 'Verden (Aller)', [9.21, 52.78], 'Nienburg (Weser)', 'Neustadt a Rübenberge', 'Wunstorf', 'Hannover Hbf'],
  },
  {
    id: 'bremen-emden',
    name: 'Bremen – Oldenburg – Leer – Emden',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 56', 'IC 35'],
    via: [
      'Bremen Hbf', 'Delmenhorst', 'Hude', 'Oldenburg (Oldb) Hbf', 'Bad Zwischenahn', 'Westerstede-Ocholt', [7.67, 53.21],
      'Leer (Ostfriesl)', 'Emden Hbf',
    ],
  },
  {
    id: 'hannover-berlin',
    name: 'Hannover – Wolfsburg – Stendal – Berlin (SFS)',
    kind: 'SFS',
    vmax: 250,
    lines: ['ICE 10', 'ICE 12', 'ICE 13', 'IC 77'],
    via: [
      'Hannover Hbf', 'Lehrte', [10.35, 52.40], 'Wolfsburg Hbf', 'Oebisfelde', [11.35, 52.50], 'Stendal Hbf', 'Rathenow',
      [12.70, 52.58], 'Wustermark', 'Berlin-Spandau', 'Berlin Hbf',
    ],
  },
  {
    id: 'berlin-magdeburg-hannover',
    name: 'Berlin – Potsdam – Magdeburg – Braunschweig – Hannover',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 56', 'IC 77'],
    via: [
      'Berlin Hbf', 'Berlin Zoologischer Garten', 'Berlin-Charlottenburg', 'Berlin-Wannsee', 'Potsdam Hbf', 'Werder (Havel)',
      'Brandenburg Hbf', 'Genthin', 'Burg (b Magdeburg)', 'Magdeburg Hbf', [11.32, 52.20], 'Helmstedt', 'Braunschweig Hbf',
      'Peine', 'Lehrte', 'Hannover Hbf',
    ],
  },
  {
    id: 'berlin-stadtbahn',
    name: 'Berlin Ostbahnhof – Berlin Hbf – Berlin-Spandau (Stadtbahn)',
    kind: 'Hauptstrecke',
    vmax: 120,
    lines: ['ICE 10', 'ICE 12', 'ICE 13', 'ICE 28'],
    via: ['Berlin Ostbahnhof', 'Berlin Hbf', 'Berlin Zoologischer Garten', 'Berlin-Charlottenburg', 'Berlin-Spandau'],
  },
  {
    id: 'berlin-rostock',
    name: 'Berlin – Neustrelitz – Waren – Rostock',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 17', 'IC 17'],
    via: [
      'Berlin Hbf', 'Berlin Gesundbrunnen', 'Oranienburg', 'Löwenberg (Mark)', 'Gransee', 'Fürstenberg (Havel)', 'Neustrelitz Hbf',
      [12.90, 53.43], 'Waren (Müritz)', pt('Lalendorf', 12.38, 53.75), pt('Plaaz', 12.36, 53.83), 'Laage (Meckl)', 'Rostock Hbf',
    ],
  },
  {
    id: 'berlin-stralsund',
    name: 'Berlin – Eberswalde – Pasewalk – Greifswald – Stralsund',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 27', 'IC 27'],
    via: [
      'Berlin Hbf', 'Berlin Gesundbrunnen', 'Bernau (b Berlin)', 'Eberswalde Hbf', 'Angermünde', 'Prenzlau', 'Pasewalk',
      'Anklam', 'Züssow', 'Greifswald', 'Stralsund Hbf',
    ],
  },
  {
    id: 'berlin-frankfurt-oder',
    name: 'Berlin – Fürstenwalde – Frankfurt (Oder) (– Polen)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['EC 95', 'IC 95'],
    via: [
      'Berlin Hbf', 'Berlin Ostbahnhof', pt('Berlin Ostkreuz', 13.469, 52.503), 'Erkner', 'Fürstenwalde (Spree)',
      'Frankfurt (Oder)', pt('Grenze Polen (Oderbrücke)', 14.575, 52.335),
    ],
  },
  {
    id: 'berlin-dresden',
    name: 'Berlin – Elsterwerda – Dresden (Dresdner Bahn)',
    kind: 'ABS',
    vmax: 200,
    lines: ['ICE 17', 'ICE 27', 'EC 27'],
    via: [
      'Berlin Hbf', 'Berlin Südkreuz', 'Blankenfelde (Kr Teltow-Fläming)', 'Rangsdorf', 'Zossen', 'Wünsdorf-Waldstadt',
      'Baruth (Mark)', 'Golßen (Niederlausitz)', 'Luckau-Uckro', 'Doberlug-Kirchhain', 'Elsterwerda',
      pt('Großenhain Berl Bf', 13.535, 51.30), 'Coswig (Bz Dresden)', 'Radebeul Ost', 'Dresden-Neustadt', 'Dresden Hbf',
    ],
  },
  {
    id: 'dresden-leipzig',
    name: 'Dresden – Riesa – Leipzig',
    kind: 'ABS',
    vmax: 200,
    lines: ['ICE 50', 'IC 55', 'IC 61'],
    via: [
      'Dresden Hbf', 'Dresden-Neustadt', 'Radebeul Ost', 'Coswig (Bz Dresden)', 'Priestewitz', 'Riesa', 'Oschatz',
      'Dahlen (Sachs)', 'Wurzen', 'Borsdorf (Sachs)', 'Leipzig Hbf',
    ],
  },
  {
    id: 'dresden-bad-schandau',
    name: 'Dresden – Pirna – Bad Schandau (– Tschechien)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['EC 27'],
    via: ['Dresden Hbf', 'Heidenau', 'Pirna', 'Bad Schandau', 'Schöna', pt('Grenze Tschechien (Dolní Žleb)', 14.255, 50.87)],
  },
  // ---------------------------------------------------------------- VDE 8
  {
    id: 'vde8-3-leipzig-berlin',
    name: 'Leipzig – Bitterfeld – Lutherstadt Wittenberg – Berlin (VDE 8.3)',
    kind: 'ABS',
    vmax: 200,
    lines: ['ICE 18', 'ICE 28', 'ICE 29', 'IC 56'],
    via: [
      'Leipzig Hbf', 'Leipzig Messe', 'Delitzsch unt Bf', 'Bitterfeld', 'Gräfenhainichen', 'Lutherstadt Wittenberg Hbf', 'Zahna',
      'Jüterbog', 'Luckenwalde', 'Trebbin', 'Ludwigsfelde', 'Berlin Südkreuz', 'Berlin Hbf',
    ],
  },
  {
    id: 'halle-bitterfeld',
    name: 'Halle (Saale) – Landsberg – Bitterfeld (VDE 8.3, Halle-Ast)',
    kind: 'ABS',
    vmax: 160,
    lines: ['ICE 18', 'ICE 29', 'ICE 15'],
    via: ['Halle (Saale) Hbf', 'Landsberg (b Halle/Saale)', 'Bitterfeld'],
  },
  {
    id: 'vde8-2-erfurt-halle',
    name: 'Erfurt – Halle (Saale) (SFS VDE 8.2)',
    kind: 'SFS',
    vmax: 300,
    lines: ['ICE 18', 'ICE 29', 'ICE 15'],
    via: [
      'Erfurt Hbf', pt('Vieselbach', 11.15, 51.00), [11.30, 51.06], pt('Buttstädt (SFS)', 11.42, 51.12), pt('Finnetunnel', 11.55, 51.19),
      pt('Saaletal Karsdorf', 11.65, 51.26), pt('Bad Lauchstädt', 11.87, 51.38), PLANENA, 'Halle-Ammendorf', 'Halle (Saale) Hbf',
    ],
  },
  {
    id: 'vde8-2-erfurt-leipzig',
    name: 'Erfurt – Leipzig (SFS VDE 8.2)',
    kind: 'SFS',
    vmax: 300,
    lines: ['ICE 11', 'ICE 28', 'ICE 50'],
    via: [
      'Erfurt Hbf', pt('Vieselbach', 11.15, 51.00), [11.30, 51.06], pt('Buttstädt (SFS)', 11.42, 51.12), pt('Finnetunnel', 11.55, 51.19),
      pt('Saaletal Karsdorf', 11.65, 51.26), pt('Bad Lauchstädt', 11.87, 51.38), PLANENA, pt('Gröbers (SFS-Ende)', 12.117, 51.432),
      'Schkeuditz', 'Leipzig-Wahren', 'Leipzig Hbf',
    ],
  },
  {
    id: 'halle-leipzig',
    name: 'Halle (Saale) – Flughafen Leipzig/Halle – Leipzig',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 56', 'ICE 18'],
    via: ['Halle (Saale) Hbf', [12.05, 51.44], 'Gröbers', 'Flughafen Leipzig/Halle', 'Schkeuditz', 'Leipzig-Wahren', 'Leipzig Hbf'],
  },
  {
    id: 'vde8-1-nuernberg-erfurt',
    name: 'Nürnberg – Bamberg – Coburg – Erfurt (SFS VDE 8.1)',
    kind: 'SFS',
    vmax: 300,
    lines: ['ICE 18', 'ICE 28', 'ICE 29'],
    via: [
      'Nürnberg Hbf', 'Fürth (Bay) Hbf', 'Erlangen', 'Forchheim (Oberfr)', 'Bamberg', 'Ebensfeld', [10.94, 50.17], 'Coburg',
      [11.03, 50.33], pt('Grümpentalbrücke', 11.05, 50.40), pt('Truckenthal', 11.04, 50.46), pt('Goldisthal', 11.02, 50.52),
      pt('Masserberg (Tunnel Bleßberg)', 10.97, 50.58), pt('Ilmenau-Wolfsberg', 10.95, 50.68), pt('Arnstadt-Ost', 10.97, 50.84),
      'Erfurt Hbf',
    ],
  },
  {
    id: 'magdeburg-halle',
    name: 'Magdeburg – Köthen – Halle (Saale)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 56'],
    via: ['Magdeburg Hbf', 'Schönebeck (Elbe)', [11.83, 51.90], 'Köthen', [12.02, 51.62], 'Halle (Saale) Hbf'],
  },
  // ---------------------------------------------------------------- Mitte / Hannover–Würzburg
  {
    id: 'hannover-wuerzburg',
    name: 'Hannover – Göttingen – Kassel – Fulda – Würzburg (SFS)',
    kind: 'SFS',
    vmax: 280,
    lines: ['ICE 20', 'ICE 22', 'ICE 25', 'ICE 26', 'ICE 91'],
    via: [
      'Hannover Hbf', 'Rethen (Leine)', 'Sarstedt', [9.885, 52.18], SORSUM, [9.88, 52.08], pt('Sibbesse', 9.90, 52.05),
      pt('Escherbergtunnel', 9.90, 51.99), 'Freden (Leine)', 'Kreiensen', 'Northeim (Han)', [9.95, 51.62], 'Göttingen',
      pt('Rauhebergtunnel', 9.80, 51.47), pt('Mündener Tunnel', 9.62, 51.40), [9.50, 51.34], 'Kassel-Wilhelmshöhe',
      'Guxhagen', 'Melsungen', [9.62, 51.06], pt('Knüllwald', 9.53, 50.93), pt('Kirchheim (Hessen)', 9.57, 50.83),
      pt('Niederaula', 9.61, 50.80), pt('Dietershantunnel', 9.67, 50.68), 'Fulda', 'Flieden', pt('Landrückentunnel', 9.60, 50.35),
      pt('Sinntal-Mottgers', 9.62, 50.26), 'Burgsinn', pt('Rieneck', 9.66, 50.09), pt('Abzweig Nantenbach', 9.63, 50.00),
      pt('Einmalbergtunnel', 9.72, 49.95), pt('Rohrbachtunnel', 9.82, 49.87), 'Würzburg Hbf',
    ],
  },
  {
    id: 'hannover-hildesheim',
    name: 'Hannover – Hildesheim – Hildesheimer Schleife (Anschluss SFS)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 25', 'IC 26'],
    via: ['Hannover Hbf', 'Rethen (Leine)', 'Sarstedt', [9.90, 52.19], 'Hildesheim Hbf', [9.975, 52.14], [9.94, 52.115], [9.90, 52.125], SORSUM],
  },
  {
    id: 'thueringer-bahn-erfurt-fulda',
    name: 'Erfurt – Gotha – Eisenach – Bebra – Fulda (Thüringer Bahn)',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 11', 'ICE 15', 'ICE 50'],
    via: [
      'Erfurt Hbf', 'Neudietendorf', 'Gotha', [10.50, 50.95], 'Eisenach', 'Gerstungen', 'Bebra', 'Bad Hersfeld', [9.74, 50.77],
      'Hünfeld', 'Fulda',
    ],
  },
  {
    id: 'kinzigtal-fulda-frankfurt',
    name: 'Fulda – Schlüchtern – Hanau – Frankfurt (Kinzigtalbahn)',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 11', 'ICE 15', 'ICE 20', 'ICE 50'],
    via: [
      'Fulda', 'Neuhof (Kr Fulda)', 'Flieden', 'Schlüchtern', 'Steinau (Straße)', 'Bad Soden-Salmünster', 'Wächtersbach',
      'Gelnhausen', 'Langenselbold', 'Hanau Hbf', 'Offenbach (Main) Hbf', 'Frankfurt (Main) Süd', 'Frankfurt (Main) Hbf',
    ],
  },
  {
    id: 'main-weser-frankfurt-kassel',
    name: 'Frankfurt – Gießen – Marburg – Kassel (Main-Weser-Bahn)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 26', 'IC 26'],
    via: [
      'Frankfurt (Main) Hbf', 'Frankfurt (Main) West', 'Bad Vilbel', 'Friedberg (Hess)', 'Butzbach', 'Gießen', 'Marburg (Lahn)',
      'Stadtallendorf', 'Treysa', 'Wabern (Bz Kassel)', [9.42, 51.23], 'Kassel-Wilhelmshöhe',
    ],
  },
  {
    id: 'main-spessart-frankfurt-wuerzburg',
    name: 'Frankfurt – Hanau – Aschaffenburg – Würzburg (Main-Spessart-Bahn)',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 41', 'ICE 91', 'IC 31'],
    via: [
      'Frankfurt (Main) Hbf', 'Frankfurt (Main) Süd', 'Offenbach (Main) Hbf', 'Hanau Hbf', [9.05, 50.07], 'Aschaffenburg Hbf',
      'Laufach', 'Heigenbrücken', 'Partenstein', 'Lohr Bahnhof', 'Gemünden (Main)', 'Karlstadt (Main)', [9.88, 49.87], 'Würzburg Hbf',
    ],
  },
  {
    id: 'wuerzburg-nuernberg',
    name: 'Würzburg – Kitzingen – Neustadt (Aisch) – Fürth – Nürnberg',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 25', 'ICE 41', 'ICE 91'],
    via: [
      'Würzburg Hbf', 'Rottendorf', 'Kitzingen', 'Iphofen', [10.42, 49.64], 'Neustadt (Aisch) Bahnhof', 'Emskirchen', [10.87, 49.51],
      'Fürth (Bay) Hbf', 'Nürnberg Hbf',
    ],
  },
  // ---------------------------------------------------------------- West / Rhein
  {
    id: 'koeln-rhein-main',
    name: 'Köln – Siegburg/Bonn – Montabaur – Limburg Süd – Frankfurt Flughafen – Frankfurt (SFS 300)',
    kind: 'SFS',
    vmax: 300,
    lines: ['ICE 41', 'ICE 42', 'ICE 43', 'ICE 45', 'ICE 47', 'ICE 49', 'ICE 78', 'ICE 79'],
    via: [
      'Köln Hbf', 'Köln Messe/Deutz', pt('Köln Steinstraße', 7.01, 50.92), pt('Porz-Wahn', 7.08, 50.86), 'Siegburg/Bonn',
      pt('Aegidienberg', 7.30, 50.68), pt('Windhagen', 7.40, 50.60), [7.55, 50.57], pt('Dierdorf', 7.66, 50.54), 'Montabaur',
      [7.95, 50.41], 'Limburg Süd', pt('Bad Camberg', 8.26, 50.30), pt('Idstein', 8.27, 50.22), pt('Niedernhausen', 8.31, 50.16),
      BRECKENHEIM, pt('Wallau', 8.43, 50.07), [8.53, 50.06], 'Frankfurt am Main Flughafen Fernbahnhof', 'Frankfurt am Main Stadion',
      'Frankfurt (Main) Hbf',
    ],
  },
  {
    id: 'sfs-ast-wiesbaden',
    name: 'Wiesbaden – Breckenheim (Anschluss SFS Köln–Rhein/Main)',
    kind: 'SFS',
    vmax: 160,
    lines: ['ICE 45', 'ICE 50'],
    via: ['Wiesbaden Hbf', 'Wiesbaden Ost', [8.31, 50.06], BRECKENHEIM],
  },
  {
    id: 'frankfurt-flughafen-riedbahn',
    name: 'Frankfurt Flughafen Fernbahnhof – Zeppelinheim (Anschluss Riedbahn)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 42', 'ICE 43', 'ICE 47'],
    via: ['Frankfurt am Main Flughafen Fernbahnhof', [8.59, 50.045], 'Zeppelinheim'],
  },
  {
    id: 'riedbahn-frankfurt-mannheim',
    name: 'Frankfurt – Groß-Gerau – Biblis – Mannheim (Riedbahn)',
    kind: 'ABS',
    vmax: 200,
    lines: ['ICE 11', 'ICE 12', 'ICE 20', 'ICE 22', 'ICE 42', 'ICE 43'],
    via: [
      'Frankfurt (Main) Hbf', 'Frankfurt am Main Stadion', 'Zeppelinheim', 'Walldorf (Hess)', 'Mörfelden', 'Groß Gerau-Dornberg',
      'Riedstadt-Goddelau', 'Gernsheim', 'Biblis', 'Lampertheim', 'Mannheim-Waldhof', 'Mannheim Hbf',
    ],
  },
  {
    id: 'frankfurt-mainz',
    name: 'Frankfurt – Rüsselsheim – Mainz (Mainbahn)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 45', 'IC 31', 'IC 32'],
    via: [
      'Frankfurt (Main) Hbf', pt('Frankfurt-Niederrad', 8.64, 50.085), 'Kelsterbach', 'Raunheim', 'Rüsselsheim', 'Mainz-Bischofsheim',
      [8.31, 50.005], 'Mainz Hbf',
    ],
  },
  {
    id: 'frankfurt-flughafen-mainz',
    name: 'Frankfurt Flughafen Fernbahnhof – Rüsselsheim – Mainz',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 45', 'IC 31'],
    via: ['Frankfurt am Main Flughafen Fernbahnhof', 'Kelsterbach', 'Raunheim', 'Rüsselsheim', 'Mainz-Bischofsheim', [8.31, 50.005], 'Mainz Hbf'],
  },
  {
    id: 'frankfurt-wiesbaden',
    name: 'Frankfurt – Höchst – Mainz-Kastel – Wiesbaden',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 50', 'IC 50'],
    via: ['Frankfurt (Main) Hbf', 'Frankfurt-Höchst', 'Hattersheim (Main)', 'Hochheim (Main)', 'Mainz-Kastel', 'Wiesbaden Hbf'],
  },
  {
    id: 'linke-rheinstrecke',
    name: 'Mainz – Bingen – Koblenz – Bonn – Köln (linke Rheinstrecke)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 45', 'IC 31', 'IC 32', 'IC 35', 'EC 30'],
    via: [
      'Mainz Hbf', 'Ingelheim', 'Bingen (Rhein) Hbf', 'Bacharach', 'Oberwesel', 'St Goar', 'Boppard Hbf', 'Koblenz Hbf', 'Andernach',
      [7.31, 50.51], 'Remagen', [7.15, 50.66], 'Bonn Hbf', [7.03, 50.87], 'Köln Hbf',
    ],
  },
  {
    id: 'koeln-aachen',
    name: 'Köln – Düren – Aachen (– Belgien)',
    kind: 'ABS',
    vmax: 250,
    lines: ['ICE 79', 'ICE 15'],
    via: [
      'Köln Hbf', 'Köln-Ehrenfeld', 'Horrem', 'Düren', 'Langerwehe', 'Eschweiler Hbf', 'Aachen Hbf',
      pt('Grenze Belgien (Hergenrath)', 6.06, 50.73),
    ],
  },
  {
    id: 'koeln-emmerich',
    name: 'Köln – Düsseldorf – Duisburg – Oberhausen – Emmerich (– Niederlande)',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 78', 'IC 78'],
    via: [
      'Köln Hbf', 'Köln-Mülheim', 'Leverkusen Mitte', [6.92, 51.14], 'Düsseldorf Hbf', 'Düsseldorf Flughafen', 'Duisburg Hbf',
      'Oberhausen Hbf', 'Dinslaken', 'Wesel', 'Haldern (Rheinl)', 'Emmerich', pt('Grenze Niederlande (Elten)', 6.16, 51.87),
    ],
  },
  {
    id: 'hannover-koeln',
    name: 'Hannover – Bielefeld – Hamm – Dortmund – Essen – Duisburg – Düsseldorf – Köln',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 10', 'IC 55', 'IC 77'],
    via: [
      'Hannover Hbf', 'Wunstorf', 'Haste (Han)', 'Stadthagen', 'Bückeburg', 'Minden (Westf)', 'Porta Westfalica', 'Bad Oeynhausen',
      'Löhne (Westf)', 'Herford', 'Bielefeld Hbf', 'Gütersloh Hbf', 'Rheda-Wiedenbrück', 'Oelde', 'Ahlen (Westf)', 'Hamm (Westf) Hbf',
      'Kamen', 'Dortmund Hbf', 'Bochum Hbf', 'Essen Hbf', 'Mülheim (Ruhr) Hbf', 'Duisburg Hbf', 'Düsseldorf Flughafen', 'Düsseldorf Hbf',
      [6.92, 51.14], 'Leverkusen Mitte', 'Köln-Mülheim', 'Köln Hbf',
    ],
  },
  {
    id: 'dortmund-wuppertal-koeln',
    name: 'Dortmund – Hagen – Wuppertal – Solingen – Köln',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 41', 'ICE 42', 'ICE 47', 'IC 32'],
    via: [
      'Dortmund Hbf', 'Witten Hbf', 'Hagen Hbf', 'Schwelm', 'Wuppertal-Oberbarmen', 'Wuppertal Hbf', 'Wuppertal-Vohwinkel',
      'Solingen Hbf', 'Opladen', 'Leverkusen Mitte', 'Köln-Mülheim', 'Köln Hbf',
    ],
  },
  // ---------------------------------------------------------------- Südwest
  {
    id: 'mannheim-stuttgart',
    name: 'Mannheim – Vaihingen (Enz) – Stuttgart (SFS)',
    kind: 'SFS',
    vmax: 250,
    lines: ['ICE 11', 'ICE 22', 'ICE 42', 'ICE 47', 'IC 62'],
    via: [
      'Mannheim Hbf', pt('Pfingstbergtunnel', 8.52, 49.42), 'Hockenheim', [8.57, 49.22], pt('Forst', 8.58, 49.16),
      pt('Rollenbergtunnel (Bruchsal)', 8.63, 49.12), pt('Kraichtal', 8.76, 49.10), pt('Zaisenhausen', 8.82, 49.05), [8.88, 49.00],
      'Vaihingen (Enz)', pt('Markgröningen', 9.08, 48.90), 'Stuttgart-Zuffenhausen', 'Stuttgart Hbf',
    ],
  },
  {
    id: 'mannheim-heidelberg-stuttgart',
    name: 'Mannheim – Heidelberg – Bruchsal – Mühlacker – Stuttgart',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 62', 'ICE 22'],
    via: [
      'Mannheim Hbf', [8.57, 49.45], 'Heidelberg Hbf', 'Wiesloch-Walldorf', [8.64, 49.21], 'Bruchsal', 'Bretten', 'Mühlacker',
      'Vaihingen (Enz)', 'Bietigheim-Bissingen', 'Ludwigsburg', 'Kornwestheim', 'Stuttgart-Zuffenhausen', 'Stuttgart Hbf',
    ],
  },
  {
    id: 'mannheim-karlsruhe',
    name: 'Mannheim – Schwetzingen – Graben-Neudorf – Karlsruhe',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 12', 'ICE 20', 'ICE 43', 'IC 60'],
    via: ['Mannheim Hbf', [8.52, 49.44], 'Schwetzingen', 'Hockenheim', 'Waghäusel', 'Graben-Neudorf', [8.44, 49.06], 'Karlsruhe Hbf'],
  },
  {
    id: 'stuttgart-karlsruhe',
    name: 'Stuttgart – Bietigheim – Mühlacker – Pforzheim – Karlsruhe',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 60', 'IC 61', 'ICE 60'],
    via: [
      'Stuttgart Hbf', 'Stuttgart-Zuffenhausen', 'Kornwestheim', 'Ludwigsburg', 'Bietigheim-Bissingen', 'Vaihingen (Enz)', 'Mühlacker',
      'Pforzheim Hbf', [8.58, 48.94], 'Karlsruhe-Durlach', 'Karlsruhe Hbf',
    ],
  },
  {
    id: 'rheintalbahn-karlsruhe-basel',
    name: 'Karlsruhe – Offenburg – Freiburg – Basel (Rheintalbahn)',
    kind: 'ABS',
    vmax: 250,
    lines: ['ICE 12', 'ICE 20', 'ICE 43', 'IC 60', 'EC 30'],
    via: [
      'Karlsruhe Hbf', 'Rastatt', 'Baden-Baden', 'Bühl (Baden)', 'Achern', 'Appenweier', 'Offenburg', 'Lahr (Schwarzw)',
      'Ringsheim/Europa-Park', 'Kenzingen', 'Emmendingen', 'Freiburg (Breisgau) Hbf', 'Bad Krozingen', 'Müllheim (Baden)',
      'Efringen-Kirchen', 'Weil am Rhein', pt('Basel Bad Bf', 7.608, 47.568), pt('Basel SBB', 7.589, 47.548),
    ],
  },
  {
    id: 'mannheim-saarbruecken',
    name: 'Mannheim – Kaiserslautern – Saarbrücken (– Frankreich)',
    kind: 'Hauptstrecke',
    vmax: 200,
    lines: ['ICE 82', 'TGV 82', 'IC 62'],
    via: [
      'Mannheim Hbf', 'Ludwigshafen (Rhein) Hbf', 'Schifferstadt', 'Neustadt (Weinstr) Hbf', [7.95, 49.39], 'Kaiserslautern Hbf',
      'Landstuhl', 'Homburg (Saar) Hbf', 'St Ingbert', 'Saarbrücken Hbf', pt('Grenze Frankreich (Forbach)', 6.92, 49.20),
    ],
  },
  {
    id: 'stuttgart-ulm',
    name: 'Stuttgart – Wendlingen – Merklingen – Ulm (SFS Wendlingen–Ulm)',
    kind: 'SFS',
    vmax: 250,
    lines: ['ICE 11', 'ICE 42', 'ICE 47', 'IC 60'],
    via: [
      'Stuttgart Hbf', 'Stuttgart-Bad Cannstatt', 'Esslingen (Neckar)', 'Plochingen', 'Wendlingen (Neckar)', pt('Albvorlandtunnel', 9.45, 48.65),
      pt('Aichelberg', 9.56, 48.64), pt('Filstalbrücke (Mühlhausen im Täle)', 9.65, 48.58), pt('Hohenstadt', 9.67, 48.55),
      pt('Merklingen - Schwäbische Alb', 9.756, 48.512), [9.85, 48.51], pt('Dornstadt', 9.94, 48.47), 'Ulm Hbf',
    ],
  },
  {
    id: 'nuernberg-stuttgart',
    name: 'Nürnberg – Ansbach – Crailsheim – Schwäbisch Hall – Stuttgart',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 61', 'ICE 61'],
    via: [
      'Nürnberg Hbf', [10.83, 49.40], 'Ansbach', 'Dombühl', 'Crailsheim', 'Schwäbisch Hall-Hessental', [9.65, 49.02], 'Murrhardt',
      'Backnang', 'Waiblingen', 'Stuttgart-Bad Cannstatt', 'Stuttgart Hbf',
    ],
  },
  // ---------------------------------------------------------------- Süd / Bayern
  {
    id: 'ulm-muenchen',
    name: 'Ulm – Günzburg – Augsburg – München',
    kind: 'ABS',
    vmax: 200,
    lines: ['ICE 11', 'ICE 42', 'ICE 47', 'IC 60', 'EC 62'],
    via: [
      'Ulm Hbf', 'Neu-Ulm', 'Günzburg', 'Burgau (Schwab)', 'Dinkelscherben', 'Augsburg Hbf', 'Mering', [11.16, 48.24], 'Olching',
      'München-Pasing', 'München Hbf',
    ],
  },
  {
    id: 'nuernberg-ingolstadt-muenchen',
    name: 'Nürnberg – Ingolstadt – München (SFS)',
    kind: 'SFS',
    vmax: 300,
    lines: ['ICE 25', 'ICE 28', 'ICE 29', 'ICE 41', 'ICE 91'],
    via: [
      'Nürnberg Hbf', pt('Nürnberg-Fischbach', 11.16, 49.42), 'Feucht', 'Allersberg (Rothsee)', [11.30, 49.12], 'Kinding (Altmühltal)',
      [11.41, 48.88], 'Ingolstadt Nord', 'Ingolstadt Hbf', pt('Reichertshofen', 11.47, 48.66), 'Rohrbach (Ilm)', 'Pfaffenhofen (Ilm)',
      'Petershausen (Oberbay)', 'Röhrmoos', 'Dachau', 'München Hbf',
    ],
  },
  {
    id: 'nuernberg-augsburg',
    name: 'Nürnberg – Treuchtlingen – Donauwörth – Augsburg',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['IC 61', 'ICE 25'],
    via: ['Nürnberg Hbf', 'Roth', [10.98, 49.10], 'Treuchtlingen', 'Donauwörth', [10.85, 48.55], 'Augsburg Hbf'],
  },
  {
    id: 'nuernberg-regensburg-passau',
    name: 'Nürnberg – Regensburg – Plattling – Passau (– Österreich)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['ICE 31', 'ICE 91', 'IC 31'],
    via: [
      'Nürnberg Hbf', 'Feucht', 'Neumarkt (Oberpf)', 'Parsberg', 'Regensburg Hbf', 'Straubing', 'Plattling', 'Osterhofen (Niederbay)',
      'Vilshofen (Niederbay)', 'Passau Hbf', pt('Grenze Österreich (Passau/Inn)', 13.49, 48.58),
    ],
  },
  {
    id: 'muenchen-salzburg',
    name: 'München – Rosenheim – Traunstein – Salzburg (– Österreich)',
    kind: 'Hauptstrecke',
    vmax: 160,
    lines: ['EC 88', 'EC 89', 'IC 62', 'RJ 90'],
    via: [
      'München Hbf', 'München Ost', 'Grafing Bahnhof', 'Rosenheim', 'Prien am Chiemsee', 'Traunstein', 'Freilassing',
      pt('Salzburg Hbf', 13.045, 47.813),
    ],
  },
];
