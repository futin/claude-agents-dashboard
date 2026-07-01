/** Run every test module and exit nonzero if any fail. */
import { run as runTranscript } from './transcript.test.js';
import { run as runScan } from './scan.test.js';
import { run as runUsage } from './usage.test.js';
import { run as runAgents } from './agents.test.js';
import { run as runAgentsCache } from './agents-cache.test.js';
import { run as runFilterSort } from './filter-sort.test.js';
import { run as runTokenRefresh } from './token-refresh.test.js';

let failed = 0;
failed += runTranscript();
failed += runScan();
failed += runUsage();
failed += runAgents();
failed += runAgentsCache();
failed += runFilterSort();
failed += await runTokenRefresh();

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
