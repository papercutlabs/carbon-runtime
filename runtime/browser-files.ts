import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store, StreamFault, type Attachment } from '../stream/store.ts';
import { componentFaults } from '../stream/encode.ts';
import { fault } from '../stream/faults.ts';

export type BrowserAttachmentMetadata = { attachment_id: string; filename: string; mime: string; bytes: number; sha256: string;
  actor_id: string | null; bound_message_id: string | null; kind: 'input' | 'artifact' };
type StagedFile = Attachment & BrowserAttachmentMetadata & { upload_id: string; actor: { id: string; name: string } };
export type BrowserWorkspace = { root: string; evidence: string; analysis: string; output: string };
const digest = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
function refuse(code: string, subject: string, problem: string): never {
  throw new StreamFault([fault(code, subject, problem, 'use the authenticated ticket identity and a valid bounded file')]);
}
export function validateBrowserFilename(filename: string) {
  if (typeof filename !== 'string' || !filename.length || Buffer.byteLength(filename) > 255 || filename === '.' || filename === '..'
    || /[\\/\x00-\x1f\x7f]/.test(filename)) refuse('BROWSER_FILE_NAME_INVALID', 'filename', 'a file name must be a bounded plain name without path components or controls');
}
function fileMap(store: Store, conversationId: string): Record<string, StagedFile> {
  const value = store.readThread(conversationId)?.browser_files;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, StagedFile> : {};
}
function metadata(file: Attachment & { attachment_id: string }): BrowserAttachmentMetadata {
  const staged = file as Partial<StagedFile>;
  return { attachment_id: file.attachment_id, filename: file.filename ?? 'attachment', mime: file.mime, bytes: file.bytes, sha256: file.sha256,
    actor_id: staged.actor?.id ?? null, bound_message_id: staged.bound_message_id ?? null, kind: staged.actor ? 'input' : 'artifact' };
}
type StageInput = { conversationId: string; actor: { id: string; name: string }; uploadId: string; filename: string; mime: string; bytes: Uint8Array; maxBytes: number };
function validateStagingActor(actor: StageInput['actor']) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.length || actor.id.length > 1024 || typeof actor.name !== 'string'
    || !actor.name.length || actor.name.length > 1024) refuse('BROWSER_FILE_ACTOR_INVALID', 'actor', 'a staged file needs its authenticated sender');
}
function validateStagingFields({ actor, mime, bytes, maxBytes }: StageInput) {
  validateStagingActor(actor);
  if (typeof mime !== 'string' || !mime.length || mime.length > 255 || /[\x00-\x20\x7f]/.test(mime)) refuse('BROWSER_FILE_MIME_INVALID', 'mime', 'a file media type must be a bounded string without whitespace or controls');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !(bytes instanceof Uint8Array) || bytes.length > maxBytes)
    refuse('BROWSER_FILE_SIZE_REFUSED', 'bytes', 'file bytes exceed the declared positive deployment limit or are malformed');
}
export function stageBrowserAttachment(store: Store, input: StageInput): BrowserAttachmentMetadata & { duplicate: boolean } {
  const { conversationId, actor, uploadId, filename, mime, bytes } = input;
  const faults = [...componentFaults('conversation_id', conversationId), ...componentFaults('upload_id', uploadId)];
  if (faults.length) throw new StreamFault(faults);
  validateBrowserFilename(filename);
  validateStagingFields(input);
  const attachment_id = `file-${digest(JSON.stringify([conversationId, uploadId]))}`;
  const files = fileMap(store, conversationId);
  const previous = files[attachment_id];
  if (previous) {
    if (previous.upload_id !== uploadId || previous.filename !== filename || previous.mime !== mime || previous.sha256 !== digest(bytes)
      || previous.bytes !== bytes.length || previous.actor.id !== actor.id || previous.actor.name !== actor.name)
      refuse('BROWSER_UPLOAD_ID_CONFLICT', uploadId, 'this upload identity already belongs to different bytes, metadata or sender');
    readBytes(store, previous);
    return { ...metadata(attachmentIn(store, conversationId, attachment_id)), duplicate: true };
  }
  const attachment = store.putAttachment({ conversation_id: conversationId, message_id: `file-${uploadId}` }, bytes, { filename, mime });
  const staged: StagedFile = { ...attachment, attachment_id, filename, actor: { ...actor }, upload_id: uploadId, actor_id: actor.id, bound_message_id: null, kind: 'input' };
  store.writeThread(conversationId, { ...store.readThread(conversationId), browser_files: { ...fileMap(store, conversationId), [attachment_id]: staged } });
  return { ...metadata(staged), duplicate: false };
}
function readBytes(store: Store, attachment: Attachment): Uint8Array {
  const file = store.under(attachment.file);
  assertNoSymlinks(store.dir, file);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('BROWSER_FILE_MISSING', attachment.sha256, 'retained attachment bytes are currently unavailable');
    throw error;
  }
  if (bytes.length !== attachment.bytes || digest(bytes) !== attachment.sha256)
    refuse('BROWSER_FILE_INTEGRITY_FAILED', attachment.sha256, 'stored attachment bytes do not match their retained size and digest');
  return bytes;
}
function acceptedBrowserOutput(record: { source: string; direction: string; delivery?: { status: string }; disposition: string }) {
  return record.source === 'browser' && record.direction === 'outbound' && record.delivery?.status !== 'failed' && record.disposition !== 'parked';
}
function attachmentIn(store: Store, conversationId: string, attachmentId: string): Attachment & { attachment_id: string; bound_message_id?: string | null } {
  const faults = [...componentFaults('conversation_id', conversationId), ...componentFaults('attachment_id', attachmentId)];
  if (faults.length) throw new StreamFault(faults);
  const staged = fileMap(store, conversationId)[attachmentId];
  if (staged) {
    if (!staged.bound_message_id) {
      const bound = store.recordsIn(conversationId).find((record) => record.source === 'browser' && record.direction === 'inbound'
        && record.sender_id === staged.actor.id && record.attachments.some((file) => (file as Attachment).attachment_id === attachmentId));
      if (bound) {
        bindBrowserAttachments(store, { conversationId, actorId: staged.actor.id, attachmentIds: [attachmentId], messageId: bound.message_id });
        return fileMap(store, conversationId)[attachmentId];
      }
    }
    return staged;
  }
  for (const record of store.recordsIn(conversationId)) {
    if (!acceptedBrowserOutput(record)) continue;
    const found = record.attachments.find((one) => one && typeof one === 'object' && (one as { attachment_id?: unknown }).attachment_id === attachmentId);
    if (found) return { ...found as Attachment & { attachment_id: string }, bound_message_id: record.message_id };
  }
  return refuse('BROWSER_FILE_NOT_FOUND', attachmentId, 'no accepted file with this identity belongs to this conversation');
}
export function readBrowserAttachment(store: Store, { conversationId, attachmentId, includeBytes = true }: { conversationId: string; attachmentId: string; includeBytes?: boolean }) {
  const attachment = attachmentIn(store, conversationId, attachmentId);
  try {
    let bytes: Uint8Array | null = null;
    if (includeBytes) bytes = readBytes(store, attachment);
    else {
      const file = store.under(attachment.file);
      assertNoSymlinks(store.dir, file);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size !== attachment.bytes) refuse('BROWSER_FILE_INTEGRITY_FAILED', attachment.sha256, 'stored attachment is not a file with its retained byte count');
    }
    return { metadata: { ...metadata(attachment), state: 'available' as const }, bytes };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof StreamFault && error.faults.length === 1 && error.faults[0].code === 'BROWSER_FILE_MISSING'))
      return { metadata: { ...metadata(attachment), state: 'missing' as const }, bytes: null };
    throw error;
  }
}
export function resolveBrowserAttachments(store: Store, { conversationId, actorId, attachmentIds }: { conversationId: string; actorId: string; attachmentIds: string[] }): Attachment[] {
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 100 || new Set(attachmentIds).size !== attachmentIds.length)
    refuse('BROWSER_FILES_INVALID', 'attachment_ids', 'file references must be a bounded list of distinct staged identities');
  return attachmentIds.map((attachmentId) => {
    const file = fileMap(store, conversationId)[attachmentId];
    if (!file || file.actor.id !== actorId) refuse('BROWSER_FILE_ACTOR_REFUSED', attachmentId, 'a submission may attach only files staged by its authenticated sender in this conversation');
    readBytes(store, file);
    return { file: file.file, mime: file.mime, bytes: file.bytes, sha256: file.sha256, filename: file.filename, attachment_id: file.attachment_id };
  });
}
function capturedFileReferences(record: ReturnType<Store['read']>, actorId: string, attachmentIds: string[]) {
  return record !== null && record.direction === 'inbound' && record.sender_id === actorId
    && attachmentIds.every((id) => record.attachments.some((file) => (file as Attachment).attachment_id === id));
}
export function bindBrowserAttachments(store: Store, { conversationId, actorId, attachmentIds, messageId }: { conversationId: string; actorId: string; attachmentIds: string[]; messageId: string }) {
  if (Array.isArray(attachmentIds) && attachmentIds.length === 0) return;
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 100 || new Set(attachmentIds).size !== attachmentIds.length)
    refuse('BROWSER_FILES_INVALID', 'attachment_ids', 'file references must be a bounded list of distinct staged identities');
  const files = fileMap(store, conversationId);
  for (const id of attachmentIds) if (!files[id] || files[id].actor.id !== actorId)
    refuse('BROWSER_FILE_ACTOR_REFUSED', id, 'a file binding must match its retained sender');
  const record = store.read(conversationId, messageId);
  if (!capturedFileReferences(record, actorId, attachmentIds))
    refuse('BROWSER_FILE_BINDING_REFUSED', messageId, 'files bind only after their sender\'s input and exact attachment references are durably captured');
  if (attachmentIds.every((id) => files[id].bound_message_id)) return;
  for (const id of attachmentIds) files[id] = { ...files[id], bound_message_id: files[id].bound_message_id ?? messageId };
  store.writeThread(conversationId, { ...store.readThread(conversationId), browser_files: files });
}

// These paths are a derived evidence view, never the authoritative Store. Native
// filesystem read enforcement is configured and qualified by the launch owner.
export function assertNoSymlinks(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    refuse('BROWSER_FILE_PATH_REFUSED', 'path', 'file path leaves its current ticket root');
  let cursor = resolvedRoot;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) refuse('BROWSER_FILE_SYMLINK_REFUSED', 'path', 'symbolic links are not accepted in file custody paths'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function browserWorkspace({ work, conversationId, checkout }: { work: string; conversationId: string; checkout: string }): BrowserWorkspace {
  const faults = componentFaults('conversation_id', conversationId);
  if (faults.length) throw new StreamFault(faults);
  const ownedWork = fs.realpathSync(work);
  if (!fs.statSync(ownedWork).isDirectory() || !fs.statSync(fs.realpathSync(checkout)).isDirectory())
    refuse('BROWSER_WORKSPACE_INVALID', 'workspace', 'declared work and client checkout must be existing directories');
  const root = path.join(ownedWork, 'browser-tickets', digest(conversationId));
  const workspace = { root, evidence: path.join(root, 'evidence'), analysis: path.join(root, 'analysis'), output: path.join(root, 'output') };
  for (const dir of Object.values(workspace)) {
    assertNoSymlinks(ownedWork, dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return workspace;
}
function evidencePath(workspace: BrowserWorkspace, attachment: Attachment, bytes: Uint8Array) {
  validateBrowserFilename(attachment.filename ?? 'attachment');
  if (digest(bytes) !== attachment.sha256 || bytes.length !== attachment.bytes)
    refuse('BROWSER_FILE_INTEGRITY_FAILED', attachment.sha256, 'evidence bytes must match their retained digest and size');
  const target = path.join(workspace.evidence, attachment.sha256, attachment.filename ?? 'attachment');
  assertNoSymlinks(workspace.root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isFile() || digest(fs.readFileSync(target)) !== attachment.sha256)
      refuse('BROWSER_EVIDENCE_CONFLICT', attachment.sha256, 'existing evidence bytes differ from the accepted source');
  } else {
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 });
  }
  fs.chmodSync(target, 0o400);
  return target;
}
function currentWorkspace(conversationId: string, workspace: BrowserWorkspace) {
  if (path.basename(workspace.root) !== digest(conversationId)
    || ['evidence', 'analysis', 'output'].some((key) => workspace[key as keyof BrowserWorkspace] !== path.join(workspace.root, key)))
    refuse('BROWSER_WORKSPACE_SCOPE_REFUSED', 'workspace', 'the evidence writer must use the workspace derived for this conversation');
  assertNoSymlinks(path.dirname(workspace.root), workspace.evidence);
}
export function materializeBrowserAttachments(store: Store, { conversationId, attachments, workspace }: { conversationId: string; attachments: Attachment[]; workspace: BrowserWorkspace }): string[] {
  const faults = componentFaults('conversation_id', conversationId);
  if (faults.length) throw new StreamFault(faults);
  currentWorkspace(conversationId, workspace);
  return attachments.map((attachment) => {
    const file = attachment as Attachment & { attachment_id?: string };
    const accepted = file.attachment_id ? attachmentIn(store, conversationId, file.attachment_id) : null;
    if (!accepted || accepted.file !== attachment.file || accepted.sha256 !== attachment.sha256)
      refuse('BROWSER_FILE_SCOPE_REFUSED', 'attachment', 'materialisation requires a retained file from this conversation');
    return evidencePath(workspace, accepted, readBytes(store, accepted));
  });
}
export function createBrowserEvidenceWriter(store: Store, { conversationId, workspace }: { conversationId: string; workspace: BrowserWorkspace }) {
  currentWorkspace(conversationId, workspace);
  return ({ identity, filename, mime, bytes }: { identity: string; filename: string; mime: string; bytes: Uint8Array }) => {
    currentWorkspace(conversationId, workspace);
    validateBrowserFilename(filename);
    const attachment = store.putAttachment({ conversation_id: conversationId, message_id: `source-${digest(identity)}` }, bytes, { filename, mime });
    return { path: evidencePath(workspace, attachment, bytes), sha256: attachment.sha256, bytes: attachment.bytes };
  };
}
