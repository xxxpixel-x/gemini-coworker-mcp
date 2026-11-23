import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { GatewayStore } from './db/sqlite.js';
import { WindowsGeminiDesktop } from './core/desktopGateway.js';

async function main() {
  const config = loadConfig(process.env, { transport: 'stdio' });
  if (!config.enableDesktopControl || process.platform !== 'win32') throw new Error('Windows desktop control is required.');
  const store = new GatewayStore(config.databasePath);
  try {
    const desktop = new WindowsGeminiDesktop(store, config.geminiDesktopMode);
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--start-isolated') {
      console.log(JSON.stringify(await desktop.startIsolated()));
      return;
    }
    if (args[0] === '--check') {
      const [,session,scenario] = args;
      if (args.length !== 3 || (scenario !== 'other-app' && scenario !== 'personal-gemini' && scenario !== 'isolated')) throw new Error('Expected --check MCP-name other-app|personal-gemini|isolated');
      if (scenario !== 'isolated') {
        console.log('Starting in eight seconds. Keep the specified foreground app active and type there during the check.');
        await delay(8_000);
      }
      await desktop.check(session, scenario);
      console.log('Passed ' + scenario);
      return;
    }
    const [session, handle, ...extra] = args;
    if (!session && !handle) {
      console.log(JSON.stringify(await desktop.windows(), null, 2));
      console.log('Bind your dedicated Gemini window: npm run desktop:bind -- MCP-codex <handle>');
      return;
    }
    if (!/^MCP-[A-Za-z0-9_-]{1,64}$/.test(session) || !/^\d+$/.test(handle ?? '') || extra.length) {
      throw new Error('Expected MCP-<label> and one window handle from the listing.');
    }
    await desktop.bind(session, Number(handle));
    console.log('Bound ' + session);
  } finally { store.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
