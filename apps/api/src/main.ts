import { bootstrap } from './bootstrap';

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start API: ${message}`);
  process.exit(1);
});
