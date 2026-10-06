// purpose: the six operations that are the only thing outside this directory may use, and the Codex app-server protocol they are spoken over.
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
} from './install.ts';

export {
  connect,
  openThread,
  resumeThread,
  Session,
  HarnessFault,
  CLIENT_INFO
} from './session.ts';

// One read beside the six operations, as `listSkills` is: which provider account
// the open session is signed in to and what is left of its allowance. It asks the
// app-server the runtime already holds, with refreshToken false, and returns no
// token; it is not a seventh operation, because nothing depends on it to run an
// agent.
export { readAccount, rateLimitsFrom, readThread } from './session.ts';
export type { AccountRead, AccountIdentity, RateLimitsRecord, RateLimitWindowRecord, AccountReadError } from './session.ts';

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
} from './turn.ts';

export { inject, createInjectLog, INJECT_FAULT_CODE } from './inject.ts';

export {
  renderConfigToml,
  writeConfigToml,
  listToolServerStatus,
  holdsRelease,
  onToolServerStatus
} from './tools.ts';

// One read beside the six operations: which skills the harness found for itself in
// a working directory. It is not a seventh operation, because nothing depends on
// it to run an agent; it is how a caller records what the agent was carrying.
export { listSkills } from './skills.ts';

export { EventStream, mapNotification, VOCABULARY } from './events.ts';

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
} from './methods.ts';

// The kind of harness this directory is, as the declaration spells it. The runtime
// picks a harness directory by this value and by nothing else.
export const HARNESS_KIND = 'codex-app-server';

export { redactNativeReason, nativeFailureEvidence } from './reasons.ts';
