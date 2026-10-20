import 'dotenv/config';
import { ConfigStore } from './config/store.js';

try {
  const store = new ConfigStore(process.env.CONFIG_PATH ?? './config/bot.json');
  await store.load();
  console.log('Configuration is valid. A default file was created if missing.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration check failed');
  process.exitCode = 1;
}
