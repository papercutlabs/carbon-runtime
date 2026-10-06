import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '@pcl/routes/cli';

const here = dirname(fileURLToPath(import.meta.url));
const description = JSON.parse(readFileSync(join(here, 'api.json'), 'utf8'));
const code = await runCli(description);
process.exit(code);
