/** Run every test module and exit nonzero if any fail. */
import { run as runTranscript } from './transcript.test.js';
import { run as runScan } from './scan.test.js';
import { run as runFilterSort } from './filter-sort.test.js';

let failed = 0;
failed += runTranscript();
failed += runScan();
failed += runFilterSort();

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
