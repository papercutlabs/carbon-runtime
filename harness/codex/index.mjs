// The one entry module of the Codex harness. Everything outside harness/ imports
// from here and from nowhere else, and what it gets is six operations: install,
// start, turn, inject, tools, events. A second harness is a second directory beside
// this one exporting the same six names.
//
// harness/README.md states the interface. This file is the interface.

export {
  install,
  generateProtocolSchema,
  checkProtocolSchema,
  pinFromLocalBinary,
  SCHEMA_COMMAND,
  SCHEMA_DOCUMENT_NAME
} from './install.mjs';

export {
  connect,
  openThread,
  resumeThread,
  Session,
  HarnessFault,
  CLIENT_INFO
} from './session.mjs';

export {
  turn,
  steer,
  interrupt,
  policyFor,
  workspaceWritePolicy,
  readOnlyPolicy,
  inputItems,
  agentMessageFrom,
  tokenUsageFrom
} from './turn.mjs';

export { inject, createInjectLog, INJECT_FAULT_CODE } from './inject.mjs';

export {
  renderConfigToml,
  writeConfigToml,
  listToolServerStatus,
  holdsRelease,
  onToolServerStatus
} from './tools.mjs';

// One read beside the six operations: which skills the harness found for itself in
// a working directory. It is not a seventh operation, because nothing depends on
// it to run an agent; it is how a caller records what the agent was carrying.
export { listSkills } from './skills.mjs';

export { EventStream, mapNotification, VOCABULARY } from './events.mjs';

export {
  REQUESTS,
  NOTIFICATIONS,
  CLIENT_NOTIFICATIONS,
  allSentRequests,
  allListenedNotifications,
  assertMethodsExist,
  methodsInSchema,
  readPinnedSchema,
  readSchemaPin,
  bundleManifest,
  bundleSha256,
  sha256
} from './methods.mjs';

// The kind of harness this directory is, as the declaration spells it. The runtime
// picks a harness directory by this value and by nothing else.
export const HARNESS_KIND = 'codex-app-server';
