#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runMcp2025ComplianceAudit, type ComplianceAuditReport } from './index.js';
import { startReferenceServer } from './reference-server.js';

export function printScorecard(report: ComplianceAuditReport): void {
  console.log(`\nMCP 2025-11-25 compliance audit: ${report.targetUrl}`);
  console.log(`Score: ${report.score} | Total latency: ${report.totalLatencyMs} ms`);
  console.log('─'.repeat(94));
  console.log(`${'Result'.padEnd(9)} ${'Check'.padEnd(51)} ${'HTTP'.padEnd(6)} Latency`);
  console.log('─'.repeat(94));
  for (const item of report.checks) {
    console.log(`${(item.passed ? 'PASS' : 'FAIL').padEnd(9)} ${item.name.padEnd(51)} ${String(item.statusCode ?? '—').padEnd(6)} ${item.latencyMs} ms`);
    if (!item.passed) console.log(`  ↳ ${item.details}`);
  }
  console.log('─'.repeat(94));
  console.log('\nJSON report:');
  console.log(JSON.stringify(report, null, 2));
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const [command, maybeUrl, ...rest] = args;
  if (rest.length || !['audit', 'selftest'].includes(command ?? '') ||
    (command === 'selftest' && maybeUrl)) {
    console.error('Usage: alexa-mcp-2025-kit audit [http(s)://host/mcp]\n       alexa-mcp-2025-kit selftest');
    return 2;
  }
  let reference: Awaited<ReturnType<typeof startReferenceServer>> | undefined;
  try {
    if (command === 'selftest' || !maybeUrl) {
      reference = await startReferenceServer();
      console.log(`Started ephemeral reference server at ${reference.url}`);
    }
    const report = await runMcp2025ComplianceAudit(reference?.url ?? maybeUrl!,
      !reference && process.env.MCP_AUDIT_BEARER_TOKEN ? { bearerToken: process.env.MCP_AUDIT_BEARER_TOKEN } : {});
    printScorecard(report);
    return report.overallPassed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await reference?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
