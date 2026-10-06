import fs from 'node:fs';
import path from 'node:path';
import {generate,checkGenerated} from '@pcl/routes/generate';
import {Store} from '../stream/store.ts';
import {evidenceAgentRoutes} from '../runtime/browser-evidence-routes.ts';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'generated/browser-evidence');
const {description}=evidenceAgentRoutes(new Store('/unopened-contract-only'),'contract-only');
await generate(description,out);const faults=await checkGenerated(description,out);if(faults.length)throw Error(JSON.stringify(faults));
console.log(`Generated ${description.operations.length} native evidence API/CLI/MCP operations from canonical schemas.`);
