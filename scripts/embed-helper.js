#!/usr/bin/env node
// Copies helper/helper.js into main.js (HELPER_SOURCE), so main.js stays a single
// self-contained file that Obsidian can load without a build step.
// Usage: node scripts/embed-helper.js [--check]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const helper = fs.readFileSync(path.join(root, 'helper', 'helper.js'), 'utf8');
const mainPath = path.join(root, 'main.js');
const main = fs.readFileSync(mainPath, 'utf8');
const re = /const HELPER_SOURCE = ".*";/;
if (!re.test(main)) { console.error('HELPER_SOURCE line not found in main.js'); process.exit(1); }
const next = main.replace(re, () => 'const HELPER_SOURCE = ' + JSON.stringify(helper) + ';');
if (process.argv.includes('--check')) {
  if (next !== main) { console.error('main.js is out of date — run: node scripts/embed-helper.js'); process.exit(1); }
  console.log('helper embedded: up to date');
} else {
  fs.writeFileSync(mainPath, next);
  console.log('helper embedded into main.js');
}
