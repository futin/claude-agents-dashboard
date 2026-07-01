'use strict';

/** Run every test module and exit nonzero if any fail. */
const modules = ['./transcript.test', './scan.test'];

let failed = 0;
for (const m of modules) {
  const mod = require(m);
  failed += mod.run();
}

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
