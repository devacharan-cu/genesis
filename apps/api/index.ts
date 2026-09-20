/**
 * The GENESIS console API.
 *
 * A thin server over the real system: it creates projects, starts factory runs
 * and streams what the ledger records. Everything it reports is derived from
 * the ledger, so nothing here can claim something the system did not do.
 */

import { createServer } from './src/server.js';

const PORT = Number(process.env['GENESIS_API_PORT'] ?? 3001);

const app = createServer();

app.listen(PORT, () => {
  console.warn(`[genesis-api] listening on http://127.0.0.1:${PORT}`);
  console.warn('[genesis-api] reasoning: deterministic-local · ledger: in-memory, hash-chained');
});
