/**
 * Knotenbahnhöfe, deren Abfahrtstafeln regelmäßig abgefragt werden, um laufende
 * Fernverkehrsfahrten zu entdecken ("Discovery"). Stufe 1 = zentrale ICE-Knoten
 * (häufig abgefragt), Stufe 2 = weitere Halte (seltener abgefragt).
 *
 * Die Auswahl ist so getroffen, dass praktisch jede ICE-/IC-Fahrt innerhalb von
 * 60 Minuten mindestens einen Knoten passiert (Boards liefern nur 1 Stunde).
 */
import { findStation } from './stations.js';
import { capitals } from './capitals.js';

const TIER1 = [
  'Berlin Hbf', 'Berlin Südkreuz', 'Berlin Gesundbrunnen', 'Berlin Spandau', 'Hamburg Hbf', 'München Hbf', 'Köln Hbf', 'Köln Messe/Deutz',
  'Frankfurt (Main) Hbf', 'Frankfurt am Main Flughafen Fernbahnhof', 'Hannover Hbf', 'Stuttgart Hbf', 'Nürnberg Hbf', 'Leipzig Hbf', 'Mannheim Hbf',
  'Düsseldorf Hbf', 'Dortmund Hbf', 'Essen Hbf', 'Duisburg Hbf', 'Karlsruhe Hbf', 'Würzburg Hbf', 'Erfurt Hbf', 'Kassel-Wilhelmshöhe',
  'Fulda', 'Göttingen', 'Bremen Hbf', 'Dresden Hbf', 'Ulm Hbf', 'Augsburg Hbf', 'Freiburg (Breisgau) Hbf', 'Halle (Saale) Hbf',
];

const TIER2 = [
  'Bielefeld Hbf', 'Münster (Westf) Hbf', 'Braunschweig Hbf', 'Wolfsburg Hbf', 'Hildesheim Hbf', 'Ingolstadt Hbf', 'Koblenz Hbf', 'Bonn Hbf',
  'Siegburg/Bonn', 'Montabaur', 'Limburg Süd', 'Aachen Hbf', 'Osnabrück Hbf', 'Kiel Hbf', 'Magdeburg Hbf', 'Mainz Hbf', 'Wiesbaden Hbf',
  'Saarbrücken Hbf', 'Potsdam Hbf', 'Schwerin Hbf', 'Rostock Hbf', 'Regensburg Hbf', 'Passau Hbf', 'Hamm (Westf) Hbf', 'Lüneburg', 'Bamberg',
  'Erlangen', 'Heidelberg Hbf', 'Darmstadt Hbf', 'Oldenburg (Oldb) Hbf', 'Lübeck Hbf', 'Weimar', 'Jena Paradies', 'Eisenach', 'Aschaffenburg Hbf',
  'Hanau Hbf', 'Offenburg', 'Baden-Baden', 'Stendal Hbf', 'Wittenberge', 'Bitterfeld', 'Lutherstadt Wittenberg Hbf', 'Riesa', 'Dresden-Neustadt',
  'Hamburg-Altona', 'Hamburg-Harburg', 'München Ost', 'München-Pasing', 'Stralsund Hbf', 'Emden Hbf', 'Kaiserslautern Hbf', 'Gießen', 'Marburg (Lahn)',
  'Coburg', 'Bad Hersfeld', 'Uelzen', 'Celle', 'Plattling', 'Günzburg', 'Ansbach', 'Rosenheim', 'Chemnitz Hbf', 'Cottbus Hbf',
];

/** @typedef {{id:string,name:string,lat:number,lon:number,tier:1|2,capital:boolean}} Hub */

function resolve(names, tier) {
  const out = [];
  for (const n of names) {
    const s = findStation(n);
    if (!s) throw new Error(`Knotenbahnhof "${n}" konnte nicht aufgelöst werden`);
    out.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, tier, capital: false });
  }
  return out;
}

/** @type {Hub[]} */
export const hubs = (() => {
  const capitalIds = new Set(capitals.map((c) => c.stationId));
  const seen = new Set();
  const all = [];
  for (const h of [...resolve(TIER1, 1), ...resolve(TIER2, 2)]) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    all.push(Object.freeze({ ...h, capital: capitalIds.has(h.id) }));
  }
  // Landeshauptstädte immer enthalten (mindestens Stufe 2)
  for (const c of capitals) {
    if (!seen.has(c.stationId)) {
      seen.add(c.stationId);
      all.push(Object.freeze({ id: c.stationId, name: c.stationName, lat: c.lat, lon: c.lon, tier: 2, capital: true }));
    }
  }
  return all;
})();

export const hubsById = new Map(hubs.map((h) => [h.id, h]));
