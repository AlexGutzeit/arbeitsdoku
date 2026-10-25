// Kalendertag relativ zu heute (Ortszeit) als 'JJJJ-MM-TT': kalendertag(1) = morgen, kalendertag(-1) = gestern.
//
// NICHT `new Date(Date.now() ± n * 864e5)`: An den Umstellungstagen hat ein Tag 23 oder 25 Stunden. Am 25.10.2026
// um 00:55 ergab „+24 h" denselben Tag — arbeitsbeginn-ui wurde rot, weil „morgen" in Wahrheit heute war (dort
// stand schon ein Eintrag bis 16:00). setDate zählt im Kalender und kennt keine Stunden.
'use strict';

module.exports = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
