// Pfad zum Test-Browser (chrome-headless-shell) für die Puppeteer-Tests.
//
//   const CHROME = require('./hilfen/chrome');
//
// Die Version nennt Puppeteer selbst (PUPPETEER_REVISIONS). Nach einem Puppeteer-Update muss deshalb nur der
// passende Browser geladen werden (tests/README.md), kein Test angefasst. Bis 24.10.2026 stand der Pfad mit
// fester Version in 161 Testdateien. CHROME_BIN überschreibt ihn.
'use strict';
const path = require('path'); const os = require('os');
const { PUPPETEER_REVISIONS } = require('puppeteer');

const VERSION = PUPPETEER_REVISIONS['chrome-headless-shell'];
module.exports = process.env.CHROME_BIN || path.join(os.homedir(),
  `.cache/puppeteer/chrome-headless-shell/linux-${VERSION}/chrome-headless-shell-linux64/chrome-headless-shell`);
