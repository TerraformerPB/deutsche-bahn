# Sicherheitshinweise und Meldeweg

## Sicherheitslücke melden

Bitte melden Sie Sicherheitslücken **nicht** über öffentliche Issues, sondern vertraulich per E-Mail an
**[[SICHERHEITS_E_MAIL]]** (bevorzugt verschlüsselt; PGP-Schlüssel auf Anfrage bzw. unter `/.well-known/security.txt`,
falls eingerichtet). Bitte beschreiben Sie:

* betroffene Komponente und Version (Commit-Hash),
* Schritte zur Reproduktion oder einen Proof of Concept,
* mögliche Auswirkungen.

Sie erhalten innerhalb von **3 Werktagen** eine Eingangsbestätigung. Bestätigte Lücken mit hoher Kritikalität werden
innerhalb von **14 Tagen** behoben; über den Fortschritt informieren wir Sie. Wir bitten um verantwortungsvolle
Offenlegung (Coordinated Disclosure) und nennen Meldende auf Wunsch in den Release-Notes.

## Unterstützte Versionen

| Version | Unterstützt |
|---|---|
| `main` bzw. neuester Release | ja |
| ältere Commits | nein |

## Grundsätze

* Keine Geheimnisse im Repository; Konfiguration ausschließlich über Umgebungsvariablen.
* Nur lesende Endpunkte, keine Nutzerkonten, keine Cookies.
* Strikte Content-Security-Policy, Rate-Limits, Eingabevalidierung, Origin-Allowlist für ausgehende Anfragen.
* Abhängigkeiten minimal, per Lockfile fixiert, `npm audit` in der CI, Dependabot aktiv.
* Container unprivilegiert und schreibgeschützt; systemd-Unit gehärtet.

Ausführlich: [docs/SICHERHEIT.md](docs/SICHERHEIT.md).
