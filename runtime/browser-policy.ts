// The owning launcher supplies its actual private paths. A profile declaration
// and native readback do not replace installed enforcement qualification.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserThreadOptions } from './loop.ts';
import type { BrowserWorkspace } from './browser-files.ts';
import { RuntimeFault, fault } from './faults.ts';
export function createBrowserThreadOptions({ work, checkout, readRoots, privateRoots, sourceConfig }: {
  work: string; checkout: string; readRoots: string[]; privateRoots: string[];
  sourceConfig?: (input: { conversationId: string; workspace: BrowserWorkspace }) => { config: Record<string, unknown> };
}): BrowserThreadOptions {
  for (const root of [work, checkout, ...readRoots, ...privateRoots]) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new RuntimeFault(fault('BROWSER_PROFILE_PATH_INVALID', String(root),
      'native permission roots must be explicit absolute launcher paths', 'supply the owning deployment paths'));
  }
  if (!privateRoots.length) throw new RuntimeFault(fault('BROWSER_PRIVATE_ROOTS_ABSENT', 'privateRoots',
    'no private authority paths were supplied for the browser permission profile', 'include the actual store, model home, source authority, private runtime and database socket roots'));
  const ownedWork = fs.realpathSync(work);
  const clientCheckout = fs.realpathSync(checkout);
  return (input) => {
    const { conversationId, workspace } = input;
    const profile = `carbon-browser-${crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 24)}`;
    const filesystem: Record<string, string> = { ':minimal': 'read' };
    for (const root of readRoots) filesystem[root] = 'read';
    filesystem[clientCheckout] = 'read';
    filesystem[path.join(ownedWork, 'browser-tickets')] = 'deny';
    filesystem[workspace.evidence] = 'read';
    filesystem[workspace.analysis] = 'write';
    filesystem[workspace.output] = 'write';
    // These are the actual client guidance copies placed by the shared runtime.
    filesystem[path.join(workspace.analysis, 'AGENTS.md')] = 'read';
    filesystem[path.join(workspace.analysis, '.agents')] = 'read';
    for (const root of privateRoots) filesystem[root] = 'deny';
    const source = sourceConfig?.(input)?.config ?? {};
    if ('permissions' in source || 'sandbox_mode' in source || 'sandbox_workspace_write' in source)
      throw new RuntimeFault(fault('BROWSER_PROFILE_OVERRIDE_REFUSED', 'sourceConfig',
        'a source transport cannot override the selected filesystem profile', 'supply only its per-thread source server configuration'));
    return { permissions: profile, config: { ...source, permissions: { [profile]: { filesystem, network: { enabled: false } } } } };
  };
}
