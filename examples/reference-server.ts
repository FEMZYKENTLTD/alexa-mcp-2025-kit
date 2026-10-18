/** Runnable reference server + status dashboard. Run: npm run reference-server */
import { startReferenceServer } from '../src/reference-server.js';

const reference = await startReferenceServer(3001, '0.0.0.0');
console.log('Dashboard: http://localhost:3001/');
console.log(`MCP endpoint: ${reference.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void reference.close().then(() => process.exit(0)); });
}
