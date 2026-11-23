#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { createGatewayRuntime } from './app.js';
import { loadConfig } from './config.js';
import { startStdioMcpServer } from './mcp/server.js';
import type { ToolProfile, TransportMode } from './types.js';

function parseCliTransport(argv: string[]): TransportMode | undefined {
  if (argv.includes('--stdio') || argv.includes('--transport=stdio')) return 'stdio';
  if (argv.includes('--http') || argv.includes('--transport=http')) return 'http';
  return undefined;
}

function parseCliToolProfile(argv: string[]): ToolProfile | undefined {
  if (argv.includes('--gemini-only') || argv.includes('--profile=gemini_only')) return 'gemini_only';
  if (argv.includes('--full') || argv.includes('--profile=full')) return 'full';
  return undefined;
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  const cliTransport = parseCliTransport(cliArgs);
  const cliProfile = parseCliToolProfile(cliArgs);
  const config = loadConfig(process.env, {
    transport: cliTransport,
    toolProfile: cliProfile,
  });
  const runtime = createGatewayRuntime(config);

  const handleShutdown = async (signal: string) => {
    process.stderr.write(`[gemini-coworker-mcp] Received ${signal}, shutting down...\n`);
    const forceTimer = setTimeout(() => process.exit(1), 5000);
    forceTimer.unref();
    await runtime.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void handleShutdown('SIGINT'));
  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

  if (config.transport === 'stdio') {
    await startStdioMcpServer(runtime.ctx);
    process.stderr.write(
      `[gemini-coworker-mcp] Running in stdio mode (${runtime.toolNames.length} tools registered)\n`,
    );
    return;
  }

  serve(
    {
      fetch: runtime.app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      process.stderr.write(
        `[gemini-coworker-mcp] HTTP Streamable MCP listening on http://${info.address}:${info.port}/mcp (auth=${config.authMode}, tools=${runtime.toolNames.length})\n`,
      );
    },
  );
}

main().catch((err) => {
  process.stderr.write(
    `[gemini-coworker-mcp] Fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
