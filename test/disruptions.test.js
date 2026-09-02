import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDisruptionAggregator,
  isRelevantRemark,
  categorize,
  assessSeverity,
  normalizeDisruptionText,
  disruptionId,
  extractStopMentions,
  resolveAffectedStops,
  CATEGORIES,
  SEVERITIES,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ITEMS,
  MAX_AFFECTED_TRIPS,
  MAX_AFFECTED_STOPS,
} from '../src/transport/disruptions.js';

// ---------------------------------------------------------------------------
// Testhilfen: Fake-Uhr, Fake-Stationsverzeichnis, Datenbausteine
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-02T10:00:00+02:00');

function fakeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

const S = {
  berlin: { id: '8011160', name: 'Berlin Hbf', lat: 52.525592, lon: 13.369545 },
  spandau: { id: '8010404', name: 'Berlin-Spandau', lat: 52.534648, lon: 13.196898 },
  wolfsburg: { id: '8006552', name: 'Wolfsburg Hbf', lat: 52.429498, lon: 10.787784 },
  hannover: { id: '8000152', name: 'Hannover Hbf', lat: 52.376761, lon: 9.741021 },
  hamburg: { id: '8002549', name: 'Hamburg Hbf', lat: 53.552736, lon: 10.006909 },
  halle: { id: '8010159', name: 'Halle (Saale) Hbf', lat: 51.477509, lon: 11.987085 },
  fulda: { id: '8000115', name: 'Fulda', lat: 50.554723, lon: 9.683977 },
  kassel: { id: '8003200', name: 'Kassel-Wilhelmshöhe', lat: 51.313114, lon: 9.446898 },
  siegburg: { id: '8005556', name: 'Siegburg/Bonn', lat: 50.793915, lon: 7.203026 },
  montabaur: { id: '8000667', name: 'Montabaur', lat: 50.444834, lon: 7.825333 },
  koeln: { id: '8000207', name: 'Köln Hbf', lat: 50.94303, lon: 6.958729 },
  ffmFlughafen: { id: '8070003', name: 'Frankfurt(M) Flughafen Fernbf', lat: 50.053167, lon: 8.570185 },
};

/** Tolerantes Fake-Verzeichnis: Name (ohne Groß-/Kleinschreibung), optional ohne „Hbf“. */
const DIRECTORY = new Map(Object.values(S).map((s) => [s.name.toLowerCase(), s]));
function fakeResolve(name) {
  if (typeof name !== 'string') return null;
  const k = name.trim().toLowerCase();
  return DIRECTORY.get(k) || DIRECTORY.get(`${k} hbf`) || null;
}

function remark({ type = 'warning', summary = null, text = null, code = null, modified = null, priority = null } = {}) {
  return { type, code, summary, text, modified, priority };
}

function stopover(stop, remarks = []) {
  return {
    stop,
    plannedArrival: null, arrival: null, arrivalDelaySec: null,
    plannedDeparture: null, departure: null, departureDelaySec: null,
    plannedArrivalPlatform: null, arrivalPlatform: null, plannedDeparturePlatform: null, departurePlatform: null,
    cancelled: false, loadFactor: null, remarks,
  };
}

function trip({ id = '1|123456|0|80|2092026', lineName = 'ICE 597', stopovers = null, remarks = [] } = {}) {
  const so = stopovers || [stopover(S.berlin), stopover(S.spandau), stopover(S.wolfsburg), stopover(S.hannover), stopover(S.hamburg)];
  return {
    id, lineName, product: 'nationalExpress', productName: 'ICE', fahrtNr: '597', operator: 'DB Fernverkehr AG',
    direction: so[so.length - 1].stop.name, origin: so[0].stop, destination: so[so.length - 1].stop,
    plannedDeparture: null, departure: null, departureDelaySec: null, plannedArrival: null, arrival: null, arrivalDelaySec: null,
    cancelled: false, loadFactor: null, stopovers: so, remarks, polyline: null, realtimeDataUpdatedAt: null, fetchedAt: T0,
  };
}

function departure({ tripId = '1|222222|0|80|2092026', lineName = 'ICE 800', stop = S.berlin, remarks = [] } = {}) {
  return {
    tripId, lineName, product: 'nationalExpress', fahrtNr: '800', direction: 'Hamburg Hbf', stop,
    plannedWhen: null, when: null, delaySec: null, plannedPlatform: null, platform: null, cancelled: false, remarks,
  };
}

const BAU_TEXT = 'Bauarbeiten zwischen Berlin-Spandau und Wolfsburg Hbf. Der Zug wird umgeleitet, es kommt zu Verspätungen von ca. 25 Minuten.';
const BAU_SUMMARY = 'Bauarbeiten zwischen Berlin-Spandau und Wolfsburg Hbf';
const STELLWERK_TEXT = 'Fahrt fällt aus. Grund: Störung an einem Stellwerk in Halle (Saale) Hbf. Bitte nutzen Sie die nachfolgenden Züge.';
const GLEISWECHSEL_TEXT = 'Gleiswechsel: Abfahrt heute von Gleis 14 statt Gleis 12';

function createAggregator(overrides = {}) {
  const clock = fakeClock();
  const agg = createDisruptionAggregator({ now: clock.now, resolveStation: fakeResolve, ...overrides });
  return { agg, clock };
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

test('Konstanten entsprechen dem Brief', () => {
  assert.deepEqual([...CATEGORIES].sort(), ['bau', 'sonstiges', 'strecke', 'wetter', 'zug']);
  assert.deepEqual([...SEVERITIES], ['hoch', 'mittel', 'niedrig']);
  assert.equal(DEFAULT_TTL_MS, 6 * 3600e3);
  assert.equal(DEFAULT_MAX_ITEMS, 500);
  assert.equal(MAX_AFFECTED_TRIPS, 50);
  assert.ok(MAX_AFFECTED_STOPS >= 2);
  assert.ok(Object.isFrozen(CATEGORIES));
});

// ---------------------------------------------------------------------------
// Relevanz
// ---------------------------------------------------------------------------

describe('isRelevantRemark', () => {
  test('warning/status mit Stichwort sind relevant', () => {
    assert.equal(isRelevantRemark(remark({ type: 'warning', text: BAU_TEXT })), true);
    assert.equal(isRelevantRemark(remark({ type: 'status', text: 'Verspätung eines vorausfahrenden Zuges' })), true);
    assert.equal(isRelevantRemark(remark({ type: 'status', summary: 'Fahrt fällt aus' })), true);
    assert.equal(isRelevantRemark(remark({ type: 'status', text: GLEISWECHSEL_TEXT })), true);
    assert.equal(isRelevantRemark(remark({ type: 'status', text: 'Halt entfällt' })), true);
  });

  test('hint wird immer ignoriert, auch mit Stichwort', () => {
    assert.equal(isRelevantRemark(remark({ type: 'hint', text: 'Bauarbeiten: Bordrestaurant geschlossen' })), false);
    assert.equal(isRelevantRemark(remark({ type: 'hint', text: 'Fahrradmitnahme begrenzt möglich' })), false);
  });

  test('Komfort-Statusmeldungen ohne Stichwort sind irrelevant', () => {
    assert.equal(isRelevantRemark(remark({ type: 'status', text: 'Bordrestaurant' })), false);
    assert.equal(isRelevantRemark(remark({ type: 'warning', text: 'Komfort Check-in verfügbar' })), false);
  });

  test('Schreibvarianten (Umlaute, Groß-/Kleinschreibung) werden erkannt', () => {
    assert.equal(isRelevantRemark(remark({ type: 'WARNING', text: 'STOERUNG an der Strecke' })), true);
    assert.equal(isRelevantRemark(remark({ type: ' status ', text: 'Zug faellt aus' })), true);
  });

  test('ungültige Eingaben ergeben false', () => {
    assert.equal(isRelevantRemark(null), false);
    assert.equal(isRelevantRemark('Störung'), false);
    assert.equal(isRelevantRemark([]), false);
    assert.equal(isRelevantRemark({}), false);
    assert.equal(isRelevantRemark(remark({ type: 'warning', text: '' })), false);
    assert.equal(isRelevantRemark(remark({ type: 'warning', text: '   ' })), false);
    assert.equal(isRelevantRemark(remark({ type: 'unknown', text: 'Störung' })), false);
    assert.equal(isRelevantRemark({ type: 'warning', text: 12345 }), false);
    assert.equal(isRelevantRemark({ type: 42, text: 'Störung' }), false);
  });
});

// ---------------------------------------------------------------------------
// Kategorie und Schweregrad
// ---------------------------------------------------------------------------

describe('categorize', () => {
  test('Bauarbeiten/Baustelle → bau', () => {
    assert.equal(categorize(BAU_TEXT), 'bau');
    assert.equal(categorize('Wegen einer Baustelle bei Fulda kommt es zu Verspätungen'), 'bau');
  });

  test('Unwetter/Sturm/Schnee/Hochwasser → wetter', () => {
    assert.equal(categorize('Unwetter: Streckensperrung zwischen Hamburg Hbf und Bremen Hbf'), 'wetter');
    assert.equal(categorize('Sturmschäden an der Oberleitung'), 'wetter');
    assert.equal(categorize('Schneefall führt zu Verspätungen'), 'wetter');
    assert.equal(categorize('Hochwasser: Strecke gesperrt'), 'wetter');
  });

  test('Sperrung/Stellwerk/Oberleitung/Signal/Weiche/Personen im Gleis/Umleitung/Polizei → strecke', () => {
    assert.equal(categorize(STELLWERK_TEXT), 'strecke');
    assert.equal(categorize('Signalstörung bei Kassel-Wilhelmshöhe'), 'strecke');
    assert.equal(categorize('Weichenstörung in Hannover Hbf'), 'strecke');
    assert.equal(categorize('Oberleitungsschaden zwischen Fulda und Würzburg'), 'strecke');
    assert.equal(categorize('Streckensperrung bis auf Weiteres'), 'strecke');
    assert.equal(categorize('Personen im Gleis'), 'strecke');
    assert.equal(categorize('Der Zug wird umgeleitet.'), 'strecke');
    assert.equal(categorize('Fahrt fällt aus. Grund: Polizeieinsatz.'), 'strecke');
    assert.equal(categorize('Notarzteinsatz am Gleis'), 'strecke');
  });

  test('Zug-spezifisch (Ausfall, Verspätung, Gleiswechsel, Wagenreihung, Reparatur) → zug', () => {
    assert.equal(categorize('Fahrt fällt aus'), 'zug');
    assert.equal(categorize('Verspätung eines vorausfahrenden Zuges'), 'zug');
    assert.equal(categorize(GLEISWECHSEL_TEXT), 'zug');
    assert.equal(categorize('Wagenreihung geändert'), 'zug');
    assert.equal(categorize('Verspätung aufgrund einer Reparatur am Zug'), 'zug');
    assert.equal(categorize('Technische Störung am Zug'), 'zug');
    assert.equal(categorize('Halt entfällt: Frankfurt (Main) Flughafen Fernbahnhof'), 'zug');
  });

  test('sonst → sonstiges, auch bei ungültiger Eingabe', () => {
    assert.equal(categorize('Streik'), 'sonstiges');
    assert.equal(categorize('Allgemeiner Hinweis'), 'sonstiges');
    assert.equal(categorize(''), 'sonstiges');
    assert.equal(categorize(null), 'sonstiges');
    assert.equal(categorize(42), 'sonstiges');
  });

  test('Vorrang: Bau vor Wetter vor Strecke vor Zug', () => {
    assert.equal(categorize('Bauarbeiten: Der Zug fällt aus und wird umgeleitet'), 'bau');
    assert.equal(categorize('Sturm: Stellwerk gestört, Zug verspätet'), 'wetter');
    assert.equal(categorize('Stellwerksstörung: Zug verspätet'), 'strecke');
  });
});

describe('assessSeverity', () => {
  test('hoch bei Ausfall, Sperrung, Unwetter, Einsätzen, Streik oder ≥ 60 Minuten', () => {
    assert.equal(assessSeverity('Fahrt fällt aus'), 'hoch');
    assert.equal(assessSeverity(STELLWERK_TEXT), 'hoch');
    assert.equal(assessSeverity('Strecke gesperrt'), 'hoch');
    assert.equal(assessSeverity('Unwetterwarnung'), 'hoch');
    assert.equal(assessSeverity('Polizeieinsatz'), 'hoch');
    assert.equal(assessSeverity('Streik'), 'hoch');
    assert.equal(assessSeverity('Personen im Gleis'), 'hoch');
    assert.equal(assessSeverity('Verspätungen von bis zu 90 Minuten'), 'hoch');
    assert.equal(assessSeverity('Verspätungen von 60 min'), 'hoch');
    assert.equal(assessSeverity('Verspätungen von mehreren Stunden'), 'hoch');
  });

  test('mittel bei Bauarbeiten, Umleitung, Infrastrukturstörung, Halt entfällt oder 16–59 Minuten', () => {
    assert.equal(assessSeverity(BAU_TEXT), 'mittel');
    assert.equal(assessSeverity('Der Zug wird umgeleitet'), 'mittel');
    assert.equal(assessSeverity('Signalstörung'), 'mittel');
    assert.equal(assessSeverity('Halt entfällt'), 'mittel');
    assert.equal(assessSeverity('Verspätungen von ca. 25 Minuten'), 'mittel');
    assert.equal(assessSeverity('Verspätungen von 16 Minuten'), 'mittel');
    assert.equal(assessSeverity('Verspätung aufgrund einer Reparatur am Zug'), 'mittel');
  });

  test('niedrig bei Verspätung/Gleiswechsel ohne weitere Indizien (status)', () => {
    assert.equal(assessSeverity('Verspätung eines vorausfahrenden Zuges'), 'niedrig');
    assert.equal(assessSeverity('Verspätung eines vorausfahrenden Zuges', { type: 'status' }), 'niedrig');
    assert.equal(assessSeverity(GLEISWECHSEL_TEXT), 'niedrig');
    assert.equal(assessSeverity('Verspätungen von 15 Minuten'), 'niedrig');
    assert.equal(assessSeverity('Wagenreihung geändert'), 'niedrig');
  });

  test('Warnungen ohne Indiz gelten als mittel; ungültige Eingaben als niedrig', () => {
    assert.equal(assessSeverity('Wagenreihung geändert', { type: 'warning' }), 'mittel');
    assert.equal(assessSeverity('', { type: 'warning' }), 'mittel');
    assert.equal(assessSeverity(null), 'niedrig');
    assert.equal(assessSeverity(undefined), 'niedrig');
  });
});

// ---------------------------------------------------------------------------
// Normalisierung und ID
// ---------------------------------------------------------------------------

describe('normalizeDisruptionText / disruptionId', () => {
  test('ID hat 12 Hex-Zeichen und ist deterministisch', () => {
    const a = disruptionId(BAU_SUMMARY, BAU_TEXT);
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.equal(disruptionId(BAU_SUMMARY, BAU_TEXT), a);
  });

  test('Groß-/Kleinschreibung, Satzzeichen und Whitespace ändern die ID nicht', () => {
    const a = disruptionId(null, 'Bauarbeiten zwischen Berlin-Spandau und Wolfsburg Hbf.');
    const b = disruptionId(null, '  BAUARBEITEN   zwischen Berlin – Spandau und Wolfsburg Hbf!! ');
    assert.equal(a, b);
    assert.equal(normalizeDisruptionText(null, 'Störung\tan  der\nStrecke.'), 'stoerung an der strecke');
  });

  test('Überschrift, die im Text enthalten ist, wird nicht doppelt gezählt', () => {
    assert.equal(disruptionId(BAU_SUMMARY, BAU_TEXT), disruptionId(null, BAU_TEXT));
    assert.notEqual(disruptionId('Andere Überschrift', BAU_TEXT), disruptionId(null, BAU_TEXT));
  });

  test('verschiedene Texte ergeben verschiedene IDs', () => {
    assert.notEqual(disruptionId(null, GLEISWECHSEL_TEXT), disruptionId(null, STELLWERK_TEXT));
    assert.notEqual(disruptionId(null, 'Gleis 14 statt 12'), disruptionId(null, 'Gleis 15 statt 12'));
  });

  test('ohne Text ergibt sich keine ID', () => {
    assert.equal(disruptionId(null, null), null);
    assert.equal(disruptionId('', '   '), null);
    assert.equal(disruptionId(42, { text: 'x' }), null);
    assert.equal(normalizeDisruptionText(undefined, undefined), '');
    assert.equal(normalizeDisruptionText(null, '!!! ???'), '');
  });

  test('überlange Texte werden begrenzt', () => {
    const base = 'Störung '.repeat(400);
    assert.equal(disruptionId(null, `${base}A`), disruptionId(null, `${base}B`));
  });
});

// ---------------------------------------------------------------------------
// Halt-Erkennung
// ---------------------------------------------------------------------------

describe('extractStopMentions', () => {
  test('„zwischen X und Y“ liefert beide Namen, am Satzende abgeschnitten', () => {
    const m = extractStopMentions(BAU_TEXT);
    assert.deepEqual(m, [
      { phrase: 'Berlin-Spandau', pattern: 'zwischen' },
      { phrase: 'Wolfsburg Hbf', pattern: 'zwischen' },
    ]);
  });

  test('„zwischen den Bahnhöfen X und Y“ wird ebenfalls erkannt', () => {
    const m = extractStopMentions('Sperrung zwischen den Bahnhöfen Fulda und Kassel-Wilhelmshöhe.');
    assert.equal(m.length, 2);
    assert.equal(m[1].phrase, 'Kassel-Wilhelmshöhe');
    assert.ok(m[0].phrase.endsWith('Fulda'));
  });

  test('„in X“ mit Klammern im Namen', () => {
    const m = extractStopMentions(STELLWERK_TEXT);
    assert.deepEqual(m, [{ phrase: 'Halle (Saale) Hbf', pattern: 'ort' }]);
  });

  test('„ab X“, „bis X“, „über X“, „bei X“ sowie satzinitiale Großschreibung', () => {
    assert.deepEqual(extractStopMentions('Ersatzverkehr ab Hannover Hbf.'), [{ phrase: 'Hannover Hbf', pattern: 'ort' }]);
    assert.deepEqual(extractStopMentions('Fahrt endet bis Fulda.'), [{ phrase: 'Fulda', pattern: 'ort' }]);
    assert.deepEqual(extractStopMentions('Umleitung über Wolfsburg Hbf.'), [{ phrase: 'Wolfsburg Hbf', pattern: 'ort' }]);
    assert.deepEqual(extractStopMentions('Signalstörung bei Kassel-Wilhelmshöhe.'), [{ phrase: 'Kassel-Wilhelmshöhe', pattern: 'ort' }]);
    assert.deepEqual(extractStopMentions('Ab Hannover Hbf Ersatzverkehr.'), [{ phrase: 'Hannover Hbf Ersatzverkehr', pattern: 'ort' }]);
  });

  test('„Halt entfällt: X“ und „Der Halt X entfällt“ und „Halte X und Y entfallen“', () => {
    assert.deepEqual(extractStopMentions('Halt entfällt: Frankfurt (Main) Flughafen Fernbahnhof'), [
      { phrase: 'Frankfurt (Main) Flughafen Fernbahnhof', pattern: 'halt' },
    ]);
    assert.deepEqual(extractStopMentions('Der Halt Montabaur entfällt, der Zug wird umgeleitet.'), [
      { phrase: 'Montabaur', pattern: 'halt' },
    ]);
    assert.deepEqual(extractStopMentions('Die Halte Fulda und Kassel-Wilhelmshöhe entfallen heute.'), [
      { phrase: 'Fulda und Kassel-Wilhelmshöhe', pattern: 'halt' },
    ]);
  });

  test('Kleingeschriebene Wörter nach Schlüsselwort und Zahlen werden nicht erfasst', () => {
    assert.deepEqual(extractStopMentions('Es kommt in den nächsten Minuten zu Verspätungen von ca. 25 Minuten.'), []);
    assert.deepEqual(extractStopMentions('Verspätung eines vorausfahrenden Zuges'), []);
  });

  test('„zwischen“-Spanne wird nicht zusätzlich als „in/von“-Fundstelle gezählt', () => {
    const m = extractStopMentions('Bauarbeiten zwischen Berlin Hbf und Hamburg Hbf.');
    assert.equal(m.length, 2);
    assert.ok(m.every((x) => x.pattern === 'zwischen'));
  });

  test('ungültige Eingaben und Obergrenze', () => {
    assert.deepEqual(extractStopMentions(null), []);
    assert.deepEqual(extractStopMentions(42), []);
    assert.deepEqual(extractStopMentions(''), []);
    const many = Array.from({ length: 20 }, (_, i) => `Halt in Ort${i}.`).join(' ');
    assert.ok(extractStopMentions(many).length <= 8);
  });
});

describe('resolveAffectedStops', () => {
  test('„zwischen X und Y“ wird zu zwei Halten mit Koordinaten in Textreihenfolge', () => {
    const stops = resolveAffectedStops(BAU_TEXT, { resolveStation: fakeResolve });
    assert.deepEqual(stops, [S.spandau, S.wolfsburg]);
  });

  test('unbekannte Bahnhöfe ergeben keine Halte', () => {
    assert.deepEqual(resolveAffectedStops('Bauarbeiten zwischen Foo und Bar.', { resolveStation: fakeResolve }), []);
    assert.deepEqual(resolveAffectedStops('Störung in Nirgendwo.', { resolveStation: fakeResolve }), []);
  });

  test('Halte der Fahrt werden bevorzugt und auch in HAFAS-Schreibweise gefunden', () => {
    const text = 'Halt entfällt: Frankfurt (Main) Flughafen Fernbahnhof';
    assert.deepEqual(resolveAffectedStops(text, { resolveStation: fakeResolve }), []);
    const withTrip = resolveAffectedStops(text, { resolveStation: fakeResolve, tripStops: [S.koeln, S.ffmFlughafen] });
    assert.deepEqual(withTrip, [S.ffmFlughafen]);
  });

  test('bei mehreren passenden Fahrt-Halten gewinnt der genaueste („Berlin“ → Berlin Hbf, nicht Berlin-Spandau)', () => {
    const stops = resolveAffectedStops('Störung in Berlin.', { resolveStation: () => null, tripStops: [S.spandau, S.berlin] });
    assert.deepEqual(stops, [S.berlin]);
  });

  test('verkürzte Fenster werden nicht zu einem anderen Bahnhof aufgelöst', () => {
    // Ein Verzeichnis, das (wie findStation) „Frankfurt (Main)“ tolerant auf den Hbf abbildet.
    const resolver = (name) => (name === 'Frankfurt (Main)' ? { id: '8000105', name: 'Frankfurt (Main) Hbf', lat: 50.1, lon: 8.66 } : null);
    assert.deepEqual(resolveAffectedStops('Halt entfällt: Frankfurt (Main) Flughafen Fernbahnhof', { resolveStation: resolver }), []);
    assert.equal(resolveAffectedStops('Störung in Frankfurt (Main) heute.', { resolveStation: resolver }).length, 1);
  });

  test('Richtungsangaben („in Richtung Hamburg“) nennen keine betroffenen Halte', () => {
    const stops = resolveAffectedStops('Es kommt in Richtung Hamburg Hbf zu Ausfällen. Ersatzverkehr ab Hannover Hbf.', { resolveStation: fakeResolve });
    assert.deepEqual(stops, [S.hannover]);
  });

  test('Stoppwörter werden auch dann verworfen, wenn das Verzeichnis sie kennt', () => {
    const resolver = (name) => (['Kürze', 'Fragen', 'Richtung'].includes(name) ? { id: '1', name, lat: 1, lon: 1 } : fakeResolve(name));
    const stops = resolveAffectedStops('In Kürze mehr. Bei Fragen wenden Sie sich an uns. Ersatz ab Fulda.', { resolveStation: resolver });
    assert.deepEqual(stops, [S.fulda]);
  });

  test('mehrere Halte in einer Phrase und Dedup', () => {
    const stops = resolveAffectedStops('Die Halte Fulda und Kassel-Wilhelmshöhe entfallen. Ersatz ab Fulda.', { resolveStation: fakeResolve });
    assert.deepEqual(stops, [S.fulda, S.kassel]);
  });

  test('Halt-Objekt der Fahrt mit gleicher ID ersetzt den Verzeichnis-Treffer', () => {
    const tripStop = { id: S.fulda.id, name: 'Fulda', lat: 50.5548, lon: 9.684 };
    const stops = resolveAffectedStops('Ersatz ab Fulda.', { resolveStation: fakeResolve, tripStops: [tripStop] });
    assert.deepEqual(stops, [tripStop]);
  });

  test('robust gegen werfende oder fehlende Auflöser und Halte ohne Koordinaten', () => {
    assert.deepEqual(resolveAffectedStops(BAU_TEXT, { resolveStation: () => { throw new Error('kaputt'); } }), []);
    assert.deepEqual(resolveAffectedStops(BAU_TEXT, { resolveStation: 'nein' }), []);
    const noCoords = resolveAffectedStops('Störung in Fulda.', { resolveStation: () => ({ id: '8000115', name: 'Fulda' }) });
    assert.deepEqual(noCoords, [{ id: '8000115', name: 'Fulda', lat: null, lon: null }]);
    const badCoords = resolveAffectedStops('Störung in Fulda.', { resolveStation: () => ({ id: '8000115', name: 'Fulda', lat: 999, lon: 9 }) });
    assert.equal(badCoords[0].lat, null);
    assert.deepEqual(resolveAffectedStops('Störung in Fulda.', { resolveStation: () => ({ lat: 1, lon: 2 }) }), []);
    assert.deepEqual(resolveAffectedStops(null, { resolveStation: fakeResolve }), []);
    assert.deepEqual(resolveAffectedStops(BAU_TEXT, { resolveStation: fakeResolve, tripStops: 'x' }), [S.spandau, S.wolfsburg]);
  });

  test('Standard-Auflöser ist das Stationsverzeichnis', () => {
    const stops = resolveAffectedStops('Bauarbeiten zwischen Berlin Hbf und Hamburg Hbf.');
    assert.equal(stops.length, 2);
    assert.equal(stops[0].id, '8011160');
    assert.equal(stops[1].id, '8002549');
    assert.ok(Number.isFinite(stops[0].lat) && Number.isFinite(stops[1].lon));
  });
});

// ---------------------------------------------------------------------------
// Aggregator: Aufnahme von Fahrten
// ---------------------------------------------------------------------------

describe('createDisruptionAggregator – ingestTrip', () => {
  test('nimmt Warnungen auf Fahrt- und Halt-Ebene auf, ignoriert Hinweise', () => {
    const { agg } = createAggregator();
    const t = trip({
      remarks: [
        remark({ type: 'warning', code: 'HIM-123', summary: BAU_SUMMARY, text: BAU_TEXT, modified: '2026-09-02T07:30:00+02:00', priority: 2 }),
        remark({ type: 'hint', text: 'Bordrestaurant' }),
      ],
      stopovers: [
        stopover(S.berlin), stopover(S.spandau), stopover(S.wolfsburg), stopover(S.hannover),
        stopover(S.hamburg, [remark({ type: 'status', summary: 'Gleiswechsel', text: 'Gleiswechsel: Ankunft heute auf Gleis 6 statt Gleis 4' })]),
      ],
    });
    assert.equal(agg.ingestTrip(t), 2);
    assert.equal(agg.size(), 2);
    const items = agg.list();
    assert.equal(items.length, 2);

    const bau = items.find((d) => d.category === 'bau');
    assert.ok(bau, 'Bau-Störung vorhanden');
    assert.match(bau.id, /^[0-9a-f]{12}$/);
    assert.equal(bau.type, 'warning');
    assert.equal(bau.severity, 'mittel');
    assert.equal(bau.summary, BAU_SUMMARY);
    assert.equal(bau.text, BAU_TEXT);
    assert.equal(bau.priority, 2);
    assert.equal(bau.modified, '2026-09-02T07:30:00+02:00');
    assert.equal(bau.firstSeen, T0);
    assert.equal(bau.lastSeen, T0);
    assert.equal(bau.active, true);
    assert.deepEqual(bau.affectedTrips, [{ tripId: t.id, lineName: 'ICE 597' }]);
    assert.deepEqual(bau.affectedStops, [S.spandau, S.wolfsburg]);
    assert.deepEqual(bau.segment, [[S.spandau.lon, S.spandau.lat], [S.wolfsburg.lon, S.wolfsburg.lat]]);

    const gw = items.find((d) => d.category === 'zug');
    assert.ok(gw, 'Gleiswechsel vorhanden');
    assert.equal(gw.type, 'status');
    assert.equal(gw.severity, 'niedrig');
    assert.equal(gw.segment, null);
    assert.deepEqual(gw.affectedStops, [S.hamburg], 'ohne erkannten Halt gilt der Halt der Meldung');
    assert.equal(gw.priority, null);
    assert.equal(gw.modified, null);
  });

  test('Halte werden gegen die Halte der Fahrt abgeglichen (HAFAS-Schreibweise, ohne Verzeichnis-Treffer)', () => {
    const { agg } = createAggregator();
    const t = trip({
      stopovers: [stopover(S.koeln), stopover(S.ffmFlughafen)],
      remarks: [remark({ type: 'status', summary: 'Halt entfällt', text: 'Halt entfällt: Frankfurt (Main) Flughafen Fernbahnhof' })],
    });
    agg.ingestTrip(t);
    const [d] = agg.list();
    assert.deepEqual(d.affectedStops, [S.ffmFlughafen]);
    assert.equal(d.segment, null);
  });

  test('Segment nur bei genau zwei erkannten Halten mit Koordinaten', () => {
    const { agg } = createAggregator();
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Sperrung in Fulda.' })] }));
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: 'Sperrung zwischen Fulda und Kassel-Wilhelmshöhe. Umleitung über Hannover Hbf.' })] }));
    const resolverNoCoords = (n) => (n === 'Fulda' ? { id: S.fulda.id, name: 'Fulda' } : fakeResolve(n));
    const other = createDisruptionAggregator({ now: () => T0, resolveStation: resolverNoCoords });
    other.ingestTrip(trip({ id: 'c', remarks: [remark({ text: 'Sperrung zwischen Fulda und Kassel-Wilhelmshöhe.' })] }));

    const one = agg.list().find((d) => d.affectedStops.length === 1);
    const three = agg.list().find((d) => d.affectedStops.length === 3);
    assert.ok(one && three);
    assert.equal(one.segment, null);
    assert.equal(three.segment, null);
    const [noCoords] = other.list();
    assert.equal(noCoords.affectedStops.length, 2);
    assert.equal(noCoords.segment, null);
  });

  test('ungültige Fahrten werden ignoriert', () => {
    const { agg } = createAggregator();
    assert.equal(agg.ingestTrip(null), 0);
    assert.equal(agg.ingestTrip('x'), 0);
    assert.equal(agg.ingestTrip({}), 0);
    assert.equal(agg.ingestTrip({ id: 123, remarks: [remark({ text: BAU_TEXT })] }), 0);
    assert.equal(agg.ingestTrip({ id: '   ', remarks: [remark({ text: BAU_TEXT })] }), 0);
    assert.equal(agg.ingestTrip({ id: 'x'.repeat(600), remarks: [remark({ text: BAU_TEXT })] }), 0);
    assert.equal(agg.ingestTrip({ id: 'ok', remarks: 'keine Liste', stopovers: 'keine Liste' }), 0);
    assert.equal(agg.ingestTrip({ id: 'ok', remarks: [null, 'x', 42, remark({ type: 'hint', text: 'Störung' })], stopovers: [null, 'x', { stop: null, remarks: null }] }), 0);
    assert.equal(agg.size(), 0);
  });

  test('Fahrt ohne Halt-Koordinaten und ohne Verzeichnis-Treffer ergibt Halte mit null-Koordinaten', () => {
    const { agg } = createAggregator({ resolveStation: () => null });
    const t = trip({
      stopovers: [stopover({ id: null, name: 'Irgendwo', lat: null, lon: null }, [remark({ text: 'Gleiswechsel' })])],
      remarks: [],
    });
    agg.ingestTrip(t);
    const [d] = agg.list();
    assert.deepEqual(d.affectedStops, [{ id: null, name: 'Irgendwo', lat: null, lon: null }]);
  });

  test('Trip-ID wird auch aus dem Feld tripId gelesen; Zeilennamen werden begrenzt', () => {
    const { agg } = createAggregator();
    agg.ingestTrip({ tripId: '1|9|0|80|2092026', lineName: 'X'.repeat(200), remarks: [remark({ text: 'Fahrt fällt aus' })] });
    const [d] = agg.list();
    assert.equal(d.affectedTrips[0].tripId, '1|9|0|80|2092026');
    assert.equal(d.affectedTrips[0].lineName.length, 64);
  });
});

// ---------------------------------------------------------------------------
// Aggregator: Dedup, Zusammenführung, Obergrenzen
// ---------------------------------------------------------------------------

describe('createDisruptionAggregator – Dedup und Zusammenführung', () => {
  test('gleicher Text über mehrere Fahrten ergibt einen Eintrag mit allen betroffenen Fahrten', () => {
    const { agg, clock } = createAggregator();
    const r = () => remark({ type: 'warning', summary: BAU_SUMMARY, text: BAU_TEXT });
    agg.ingestTrip(trip({ id: 'trip-1', lineName: 'ICE 597', remarks: [r()] }));
    clock.advance(60e3);
    agg.ingestTrip(trip({ id: 'trip-2', lineName: 'ICE 599', remarks: [r()] }));
    clock.advance(60e3);
    agg.ingestTrip(trip({ id: 'trip-2', lineName: 'ICE 599', remarks: [r()] }));
    agg.ingestTrip(trip({ id: 'trip-3', lineName: 'IC 2431', remarks: [r()] }));
    assert.equal(agg.size(), 1);
    const [d] = agg.list();
    assert.deepEqual(d.affectedTrips.map((x) => x.tripId), ['trip-1', 'trip-2', 'trip-3']);
    assert.equal(d.firstSeen, T0);
    assert.equal(d.lastSeen, T0 + 120e3);
    assert.deepEqual(d.affectedStops, [S.spandau, S.wolfsburg]);
    assert.ok(d.segment);
  });

  test('gleicher Text mit abweichender Interpunktion/Schreibung wird zusammengeführt', () => {
    const { agg } = createAggregator();
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus.' })] }));
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: 'FAHRT FÄLLT AUS' })] }));
    agg.ingestTrip(trip({ id: 'c', remarks: [remark({ summary: 'Fahrt fällt aus', text: 'Fahrt fällt aus' })] }));
    assert.equal(agg.size(), 1);
    assert.equal(agg.list()[0].affectedTrips.length, 3);
  });

  test('betroffene Fahrten sind auf 50 begrenzt', () => {
    const { agg } = createAggregator();
    for (let i = 0; i < 60; i++) agg.ingestTrip(trip({ id: `trip-${i}`, remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    assert.equal(agg.list()[0].affectedTrips.length, MAX_AFFECTED_TRIPS);
  });

  test('betroffene Halte sind begrenzt und dedupliziert', () => {
    const { agg } = createAggregator();
    for (let i = 0; i < MAX_AFFECTED_STOPS + 10; i++) {
      const stop = { id: `90000${i}`, name: `Bahnhof ${i}`, lat: 50 + i / 100, lon: 8 + i / 100 };
      agg.ingestDepartures(stop, [departure({ tripId: `t-${i}`, stop, remarks: [remark({ type: 'status', text: GLEISWECHSEL_TEXT })] })]);
      agg.ingestDepartures(stop, [departure({ tripId: `t-${i}`, stop, remarks: [remark({ type: 'status', text: GLEISWECHSEL_TEXT })] })]);
    }
    assert.equal(agg.size(), 1);
    assert.equal(agg.list()[0].affectedStops.length, MAX_AFFECTED_STOPS);
  });

  test('Zusammenführung: warning gewinnt, Schweregrad steigt, neuestes modified, letzte priority, fehlende Felder werden ergänzt', () => {
    const { agg, clock } = createAggregator();
    const text = 'Wagenreihung geändert';
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ type: 'status', text, modified: '2026-09-02T08:00:00+02:00', priority: 5 })] }));
    let [d] = agg.list();
    assert.equal(d.type, 'status');
    assert.equal(d.severity, 'niedrig');
    assert.equal(d.summary, null);
    clock.advance(1000);
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ type: 'warning', summary: 'Wagenreihung geändert', text, modified: '2026-09-02T09:00:00+02:00', priority: 1 })] }));
    [d] = agg.list();
    assert.equal(d.type, 'warning');
    assert.equal(d.severity, 'mittel');
    assert.equal(d.modified, '2026-09-02T09:00:00+02:00');
    assert.equal(d.priority, 1);
    assert.equal(d.summary, 'Wagenreihung geändert');
    // Älteres modified und fehlende priority ändern nichts; status stuft nicht zurück.
    agg.ingestTrip(trip({ id: 'c', remarks: [remark({ type: 'status', text, modified: '2026-09-02T06:00:00+02:00' })] }));
    [d] = agg.list();
    assert.equal(d.type, 'warning');
    assert.equal(d.modified, '2026-09-02T09:00:00+02:00');
    assert.equal(d.priority, 1);
    assert.equal(d.severity, 'mittel');
  });

  test('Segment bleibt erhalten, wenn spätere Meldungen keines liefern', () => {
    const { agg } = createAggregator();
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: BAU_TEXT })] }));
    // Ohne Verzeichnis-Treffer und ohne Halte der Fahrt gibt es kein Segment …
    const noResolve = createDisruptionAggregator({ now: () => T0, resolveStation: () => null });
    noResolve.ingestTrip({ id: 'a', remarks: [remark({ text: BAU_TEXT })], stopovers: [] });
    assert.equal(noResolve.list()[0].segment, null);
    assert.deepEqual(noResolve.list()[0].affectedStops, []);
    // … aber die Halte der Fahrt genügen für die Erkennung.
    noResolve.ingestTrip(trip({ id: 'b', remarks: [remark({ text: BAU_TEXT })] }));
    assert.deepEqual(noResolve.list()[0].segment, [[S.spandau.lon, S.spandau.lat], [S.wolfsburg.lon, S.wolfsburg.lat]]);
    // Zweite Aufnahme mit Auflöser, der nichts findet, darf das Segment nicht löschen.
    const stopsBefore = agg.list()[0].segment;
    agg.ingestTrip({ id: 'b', remarks: [remark({ text: BAU_TEXT })], stopovers: [] });
    assert.deepEqual(agg.list()[0].segment, stopsBefore);
  });

  test('ungültige modified-/priority-Werte werden zu null; modified als Zahl wird zu ISO', () => {
    const { agg } = createAggregator();
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus', modified: 'kein Datum', priority: 'hoch' })] }));
    assert.equal(agg.list()[0].modified, null);
    assert.equal(agg.list()[0].priority, null);
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: 'Zug verspätet', modified: T0, priority: 3.6 })] }));
    const d = agg.list().find((x) => x.text === 'Zug verspätet');
    assert.equal(d.modified, new Date(T0).toISOString());
    assert.equal(d.priority, 4);
  });

  test('Texte werden bereinigt (Steuerzeichen, Whitespace) und begrenzt', () => {
    const { agg } = createAggregator();
    const long = `Störung ${'x'.repeat(3000)}`;
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ summary: 'Stö\u0000rung\tan der\n\nStrecke', text: long })] }));
    const [d] = agg.list();
    assert.equal(d.summary, 'Stö rung an der Strecke');
    assert.equal(d.text.length, 2000);
  });
});

// ---------------------------------------------------------------------------
// Aggregator: Abfahrtstafeln
// ---------------------------------------------------------------------------

describe('createDisruptionAggregator – ingestDepartures', () => {
  test('Ausfall mit Ursache an anderem Bahnhof, Gleiswechsel am Tafel-Bahnhof, Hinweise ignoriert', () => {
    const { agg } = createAggregator();
    const deps = [
      departure({ tripId: 'd1', lineName: 'ICE 1001', remarks: [remark({ type: 'status', summary: 'Fahrt fällt aus', text: STELLWERK_TEXT })] }),
      departure({ tripId: 'd2', lineName: 'IC 2431', remarks: [remark({ type: 'status', summary: 'Gleiswechsel', text: GLEISWECHSEL_TEXT })] }),
      departure({ tripId: 'd3', lineName: 'ICE 800', remarks: [remark({ type: 'hint', text: 'Komfort Check-in verfügbar' })] }),
      departure({ tripId: 'd4', lineName: 'ICE 802', remarks: [] }),
    ];
    assert.equal(agg.ingestDepartures(S.berlin, deps), 2);
    const items = agg.list();
    assert.equal(items.length, 2);
    const ausfall = items.find((d) => d.severity === 'hoch');
    assert.equal(ausfall.category, 'strecke');
    assert.equal(ausfall.type, 'status');
    assert.deepEqual(ausfall.affectedStops, [S.halle]);
    assert.deepEqual(ausfall.affectedTrips, [{ tripId: 'd1', lineName: 'ICE 1001' }]);
    assert.equal(ausfall.segment, null);
    const gw = items.find((d) => d.category === 'zug');
    assert.deepEqual(gw.affectedStops, [S.berlin]);
    assert.deepEqual(gw.affectedTrips, [{ tripId: 'd2', lineName: 'IC 2431' }]);
    assert.equal(items[0].severity, 'hoch', 'Sortierung: hoch zuerst');
  });

  test('Tafel-Bahnhof aus Parameter, wenn der Departure-Stop keine Koordinaten hat', () => {
    const { agg } = createAggregator();
    const bare = { id: '8011160', name: 'Berlin Hbf', lat: null, lon: null };
    agg.ingestDepartures(S.berlin, [departure({ stop: bare, remarks: [remark({ type: 'status', text: GLEISWECHSEL_TEXT })] })]);
    assert.deepEqual(agg.list()[0].affectedStops, [S.berlin]);

    const { agg: agg2 } = createAggregator();
    agg2.ingestDepartures(null, [departure({ stop: bare, remarks: [remark({ type: 'status', text: GLEISWECHSEL_TEXT })] })]);
    assert.deepEqual(agg2.list()[0].affectedStops, [bare]);

    const { agg: agg3 } = createAggregator();
    agg3.ingestDepartures(undefined, [departure({ stop: null, remarks: [remark({ type: 'status', text: GLEISWECHSEL_TEXT })] })]);
    assert.deepEqual(agg3.list()[0].affectedStops, []);
  });

  test('ungültige Eingaben', () => {
    const { agg } = createAggregator();
    assert.equal(agg.ingestDepartures(S.berlin, null), 0);
    assert.equal(agg.ingestDepartures(S.berlin, 'x'), 0);
    assert.equal(agg.ingestDepartures(S.berlin, [null, 'x', 42, { remarks: 'x' }]), 0);
    assert.equal(agg.ingestDepartures('kein Objekt', []), 0);
    assert.equal(agg.size(), 0);
  });

  test('Departure ohne Trip-ID wird aufgenommen, aber ohne Fahrt-Zuordnung', () => {
    const { agg } = createAggregator();
    assert.equal(agg.ingestDepartures(S.berlin, [{ stop: S.berlin, remarks: [remark({ text: 'Fahrt fällt aus' })] }]), 1);
    assert.deepEqual(agg.list()[0].affectedTrips, []);
  });

  test('Tafel-Meldung und Fahrt-Meldung mit gleichem Text werden zusammengeführt', () => {
    const { agg } = createAggregator();
    agg.ingestDepartures(S.berlin, [departure({ tripId: 'x', remarks: [remark({ summary: BAU_SUMMARY, text: BAU_TEXT })] })]);
    agg.ingestTrip(trip({ id: 'x', remarks: [remark({ summary: BAU_SUMMARY, text: BAU_TEXT })] }));
    agg.ingestTrip(trip({ id: 'y', remarks: [remark({ summary: BAU_SUMMARY, text: BAU_TEXT })] }));
    assert.equal(agg.size(), 1);
    assert.deepEqual(agg.list()[0].affectedTrips.map((t) => t.tripId), ['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// Aggregator: list, TTL, prune, Obergrenze, stats
// ---------------------------------------------------------------------------

describe('createDisruptionAggregator – list/TTL/prune/stats', () => {
  test('list sortiert nach Schweregrad, dann jüngste zuerst, und liefert Kopien', () => {
    const { agg, clock } = createAggregator();
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ type: 'status', text: 'Verspätung eines vorausfahrenden Zuges' })] }));
    clock.advance(1000);
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    clock.advance(1000);
    agg.ingestTrip(trip({ id: 'c', remarks: [remark({ text: BAU_TEXT })] }));
    clock.advance(1000);
    agg.ingestTrip(trip({ id: 'd', remarks: [remark({ text: 'Streckensperrung bei Fulda.' })] }));
    const items = agg.list();
    assert.deepEqual(items.map((d) => d.severity), ['hoch', 'hoch', 'mittel', 'niedrig']);
    assert.equal(items[0].text, 'Streckensperrung bei Fulda.', 'jüngere hoch-Störung zuerst');
    items[0].affectedTrips.push({ tripId: 'fremd', lineName: null });
    items[0].affectedStops[0].name = 'manipuliert';
    items[0].severity = 'niedrig';
    const again = agg.list();
    assert.equal(again[0].affectedTrips.length, 1);
    assert.equal(again[0].affectedStops[0].name, 'Fulda');
    assert.equal(again[0].severity, 'hoch');
  });

  test('Einträge laufen nach ttlMs ab und werden durch erneute Aufnahme verlängert', () => {
    const { agg, clock } = createAggregator({ ttlMs: 60e3 });
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    clock.advance(59e3);
    assert.equal(agg.list().length, 1);
    clock.advance(1000);
    assert.equal(agg.list().length, 0);
    assert.equal(agg.size(), 1, 'ohne prune bleibt der Eintrag gespeichert');
    const all = agg.list({ activeOnly: false });
    assert.equal(all.length, 1);
    assert.equal(all[0].active, false);
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    const [d] = agg.list();
    assert.equal(d.active, true);
    assert.equal(d.firstSeen, T0);
    assert.equal(d.lastSeen, T0 + 60e3);
    assert.equal(d.affectedTrips.length, 2);
  });

  test('prune entfernt abgelaufene Einträge und meldet die Anzahl', () => {
    const { agg, clock } = createAggregator({ ttlMs: 60e3 });
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    clock.advance(30e3);
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: BAU_TEXT })] }));
    assert.equal(agg.prune(), 0);
    clock.advance(30e3);
    assert.equal(agg.prune(), 1);
    assert.equal(agg.size(), 1);
    assert.equal(agg.list()[0].category, 'bau');
    clock.advance(30e3);
    assert.equal(agg.prune(), 1);
    assert.equal(agg.size(), 0);
    assert.equal(agg.prune(), 0);
  });

  test('maxItems: älteste Einträge (lastSeen) werden verdrängt', () => {
    const { agg, clock } = createAggregator({ maxItems: 3 });
    for (let i = 0; i < 5; i++) {
      agg.ingestTrip(trip({ id: `t${i}`, remarks: [remark({ text: `Störung Nummer ${i}` })] }));
      clock.advance(1000);
    }
    assert.equal(agg.size(), 3);
    assert.deepEqual(agg.list().map((d) => d.text).sort(), ['Störung Nummer 2', 'Störung Nummer 3', 'Störung Nummer 4']);
    // Erneute Aufnahme einer alten Meldung macht sie wieder zur jüngsten.
    agg.ingestTrip(trip({ id: 'x', remarks: [remark({ text: 'Störung Nummer 2' })] }));
    agg.ingestTrip(trip({ id: 'y', remarks: [remark({ text: 'Störung Nummer 5' })] }));
    assert.deepEqual(agg.list().map((d) => d.text).sort(), ['Störung Nummer 2', 'Störung Nummer 4', 'Störung Nummer 5']);
  });

  test('stats liefert Kennzahlen', () => {
    const { agg, clock } = createAggregator({ ttlMs: 60e3, maxItems: 10 });
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: BAU_TEXT })] }));
    const s = agg.stats();
    assert.equal(s.size, 2);
    assert.equal(s.active, 2);
    assert.equal(s.byCategory.zug, 1);
    assert.equal(s.byCategory.bau, 1);
    assert.equal(s.bySeverity.hoch, 1);
    assert.equal(s.bySeverity.mittel, 1);
    assert.equal(s.ttlMs, 60e3);
    assert.equal(s.maxItems, 10);
    clock.advance(61e3);
    assert.equal(agg.stats().active, 0);
    assert.equal(agg.stats().size, 2);
  });

  test('ungültige Optionen fallen auf Standardwerte zurück', () => {
    const agg = createDisruptionAggregator({ ttlMs: -1, maxItems: 0, resolveStation: 'nein', logger: {}, now: () => { throw new Error('kaputt'); } });
    const s = agg.stats();
    assert.equal(s.ttlMs, DEFAULT_TTL_MS);
    assert.equal(s.maxItems, DEFAULT_MAX_ITEMS);
    const before = Date.now();
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Bauarbeiten zwischen Berlin Hbf und Hamburg Hbf.' })] }));
    const [d] = agg.list();
    assert.ok(d.firstSeen >= before && d.firstSeen <= Date.now(), 'Zeit-Fallback auf Date.now()');
    assert.equal(d.affectedStops.length, 2, 'Standard-Auflöser (Stationsverzeichnis)');
    assert.ok(d.segment);
    const nanClock = createDisruptionAggregator({ now: () => NaN });
    nanClock.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    assert.ok(Number.isFinite(nanClock.list()[0].lastSeen));
  });

  test('ohne Optionen nutzbar; leerer Aggregator', () => {
    const agg = createDisruptionAggregator();
    assert.deepEqual(agg.list(), []);
    assert.equal(agg.size(), 0);
    assert.equal(agg.prune(), 0);
    assert.equal(agg.stats().active, 0);
  });

  test('Logger erhält debug-Einträge nur für neue Störungen', () => {
    const calls = [];
    const logger = { debug: (msg, meta) => calls.push({ msg, meta }), info() {}, warn() {}, error() {} };
    const { agg } = createAggregator({ logger });
    agg.ingestTrip(trip({ id: 'a', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    agg.ingestTrip(trip({ id: 'b', remarks: [remark({ text: 'Fahrt fällt aus' })] }));
    const created = calls.filter((c) => c.msg === 'Neue Störung erfasst');
    assert.equal(created.length, 1);
    assert.match(created[0].meta.id, /^[0-9a-f]{12}$/);
  });
});
