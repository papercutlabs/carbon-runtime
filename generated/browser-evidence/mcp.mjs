import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcp } from '@pcl/routes/mcp';

const here = dirname(fileURLToPath(import.meta.url));
const description = JSON.parse(readFileSync(join(here, 'api.json'), 'utf8'));
await runMcp(description);
