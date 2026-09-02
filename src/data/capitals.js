/**
 * Die 16 Landeshauptstädte mit ihrem jeweiligen Hauptbahnhof (EVA-Nummer).
 * Koordinaten stammen aus dem Stationsverzeichnis (einzige Wahrheitsquelle).
 */
import { findStation } from './stations.js';

const LIST = [
  { stateId: 'DE-BW', state: 'Baden-Württemberg', city: 'Stuttgart', stationId: '8000096', cityState: false },
  { stateId: 'DE-BY', state: 'Bayern', city: 'München', stationId: '8000261', cityState: false },
  { stateId: 'DE-BE', state: 'Berlin', city: 'Berlin', stationId: '8011160', cityState: true },
  { stateId: 'DE-BB', state: 'Brandenburg', city: 'Potsdam', stationId: '8012666', cityState: false },
  { stateId: 'DE-HB', state: 'Bremen', city: 'Bremen', stationId: '8000050', cityState: true },
  { stateId: 'DE-HH', state: 'Hamburg', city: 'Hamburg', stationId: '8002549', cityState: true },
  { stateId: 'DE-HE', state: 'Hessen', city: 'Wiesbaden', stationId: '8000250', cityState: false },
  { stateId: 'DE-MV', state: 'Mecklenburg-Vorpommern', city: 'Schwerin', stationId: '8010324', cityState: false },
  { stateId: 'DE-NI', state: 'Niedersachsen', city: 'Hannover', stationId: '8000152', cityState: false },
  { stateId: 'DE-NW', state: 'Nordrhein-Westfalen', city: 'Düsseldorf', stationId: '8000085', cityState: false },
  { stateId: 'DE-RP', state: 'Rheinland-Pfalz', city: 'Mainz', stationId: '8000240', cityState: false },
  { stateId: 'DE-SL', state: 'Saarland', city: 'Saarbrücken', stationId: '8000323', cityState: false },
  { stateId: 'DE-SN', state: 'Sachsen', city: 'Dresden', stationId: '8010085', cityState: false },
  { stateId: 'DE-ST', state: 'Sachsen-Anhalt', city: 'Magdeburg', stationId: '8010224', cityState: false },
  { stateId: 'DE-SH', state: 'Schleswig-Holstein', city: 'Kiel', stationId: '8000199', cityState: false },
  { stateId: 'DE-TH', state: 'Thüringen', city: 'Erfurt', stationId: '8010101', cityState: false },
];

/** @typedef {{stateId:string,state:string,city:string,stationId:string,stationName:string,lat:number,lon:number,cityState:boolean}} Capital */

/** @type {Capital[]} */
export const capitals = LIST.map((c) => {
  const st = findStation(c.stationId);
  if (!st) throw new Error(`Landeshauptstadt ${c.city}: Station ${c.stationId} nicht im Verzeichnis`);
  return Object.freeze({ ...c, stationName: st.name, lat: st.lat, lon: st.lon });
});

export const capitalsByStationId = new Map(capitals.map((c) => [c.stationId, c]));

/** GeoJSON-FeatureCollection der Landeshauptstädte. */
export function capitalsGeoJson() {
  return {
    type: 'FeatureCollection',
    features: capitals.map((c) => ({
      type: 'Feature',
      id: c.stateId,
      properties: { stateId: c.stateId, state: c.state, city: c.city, stationId: c.stationId, stationName: c.stationName, cityState: c.cityState },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    })),
  };
}
