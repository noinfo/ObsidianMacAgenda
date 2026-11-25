// Runs the plain-Node tests (no dependencies). Usage: node test/run.js
const path = require('path');
process.env.NODE_PATH = path.join(__dirname, 'node_modules');
require('module').Module._initPaths();
require('./recurrence.test.js');
