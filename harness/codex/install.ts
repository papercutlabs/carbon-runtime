// install — the first of the six operations. Fetch the pinned release, prove where
// it came from, unpack it to a version-named directory, generate the protocol
// schema from the binary that was just unpacked, and refuse on any digest that does
// not match what carbon pinned.
//
// The order matters and is the one Debian uses: verify, then unpack. Nothing is
// written under the version directory until the signature has verified, so a
// tampered asset never becomes a file the unit could start.
//
// The schema is generated from the unpacked binary and not downloaded, because a
// schema fetched separately proves nothing about the binary that will run.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fault } from '../../lib/faults.ts';
import { HarnessFault, asRecord } from './session.ts';
import {
  sha256, bundleManifest, bundleSha256, assertMethodsExist, readSchemaPin
} from './methods.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VERIFY_RELEASE = path.join(HERE, '..', '..', 'tools', 'verify-release.mjs');

// The subcommand 0.153.4 offers. Recorded as a constant because a version that
// renames it must fail loudly here rather than produce an empty bundle.
export const SCHEMA_COMMAND = ['app-server', 'generate-json-schema', '--out'];
export const SCHEMA_DOCUMENT_NAME = 'codex_app_server_protocol.schemas.json';

type GeneratedProtocolSchema = {
  command: string;
  document_path: string;
  document_sha256: string;
  bundle_sha256: string;
  bundle_files: number;
};
type CarbonFault = { code: unknown; subject: unknown; problem: unknown; fix: unknown };

function verificationFaults(error: unknown, asset: string): unknown[] {
  const caught = asRecord(error);
  const lines = String(caught?.stdout ?? '').split('\n').filter(Boolean);
  const reported: unknown[] = lines
    .map((line): unknown => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  return reported.length ? reported : [fault('HARNESS_RELEASE_UNVERIFIED', asset,
    String(caught?.message), 'read tools/verify-release.mjs --help and run it by hand against this tag')];
}

// The archives hold exactly one file, so the first ustar header is enough. The same
// reader lives in tools/verify-release.mjs, which reads the member to hash it; this
// one reads it to write it out.
function singleFileFromTarGz(archive: Buffer): { name: string; bytes: Buffer } {
  const tar = zlib.gunzipSync(archive);
  const name = tar.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const size = parseInt(tar.subarray(124, 136).toString('utf8').replace(/[\0 ]/g, ''), 8);
  if (!Number.isInteger(size) || size <= 0) throw new Error('the archive has no readable first member');
  return { name, bytes: tar.subarray(512, 512 + size) };
}

// Runs `codex app-server generate-json-schema --out <dir>` against the binary that
// will actually run, and returns the bundle's two digests. `bundle_sha256` covers
// every file the subcommand wrote, through a manifest; `document_sha256` covers the
// one merged document carbon checks its method names against.
export function generateProtocolSchema(binary: string, outDir: string): GeneratedProtocolSchema {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(binary, [...SCHEMA_COMMAND, outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const documentPath = path.join(outDir, SCHEMA_DOCUMENT_NAME);
  if (!fs.existsSync(documentPath)) {
    throw new HarnessFault(fault('HARNESS_SCHEMA_DOCUMENT_ABSENT', documentPath,
      `${binary} wrote a schema bundle with no ${SCHEMA_DOCUMENT_NAME} in it`,
      'stop at this version; the generate subcommand changed its output shape'));
  }
  const manifest = bundleManifest(outDir);
  fs.writeFileSync(path.join(outDir, 'MANIFEST.sha256'), manifest);
  // The manifest is written after it is computed, so it never covers itself.
  return {
    command: `${path.basename(binary)} ${SCHEMA_COMMAND.join(' ')} ${outDir}`,
    document_path: documentPath,
    document_sha256: sha256(fs.readFileSync(documentPath)),
    bundle_sha256: sha256(Buffer.from(manifest, 'utf8')),
    bundle_files: manifest.split('\n').filter(Boolean).length
  };
}

// Compares a generated schema against what carbon pinned, and against the method
// names the harness sends. Returns every fault at once.
export function checkProtocolSchema(generated: GeneratedProtocolSchema, {
  pin = null, documentPath = null
}: { pin?: unknown; documentPath?: string | null } = {}): CarbonFault[] {
  const faults: CarbonFault[] = [];
  const expected = asRecord(pin ?? readSchemaPin()) ?? {};
  const expectedBundleDigest = expected.bundle_sha256;
  const expectedDocumentDigest = expected.document_sha256;
  if (expectedBundleDigest && expectedBundleDigest !== generated.bundle_sha256) {
    faults.push(fault('HARNESS_PROTOCOL_SCHEMA_MOVED', 'protocol schema bundle',
      `carbon pins ${String(expectedBundleDigest)} and this binary generates ${generated.bundle_sha256}`,
      'diff the bundle against harness/codex/schema, change harness/codex for what moved, then repin'));
  }
  if (expectedDocumentDigest && expectedDocumentDigest !== generated.document_sha256) {
    faults.push(fault('HARNESS_PROTOCOL_DOCUMENT_MOVED', SCHEMA_DOCUMENT_NAME,
      `carbon pins ${String(expectedDocumentDigest)} and this binary generates ${generated.document_sha256}`,
      'diff the document against harness/codex/schema, change harness/codex for what moved, then repin'));
  }
  const source = documentPath ?? generated.document_path;
  const document: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
  faults.push(...assertMethodsExist(document, path.basename(source)));
  return faults;
}

// The whole operation. `dest` is the harness root on the box,
// /srv/carbon/<id>/harness; the binary lands at <dest>/<version>/codex and the
// schema beside it at <dest>/<version>/protocol-schema/.
export function install({
  version, tag, asset, artifactSha256, dest, cache,
  offlineAsset = null, offlineBundle = null, pin = null
}: {
  version: string;
  tag: string;
  asset: string;
  artifactSha256: string;
  dest: string;
  cache: string;
  offlineAsset?: string | null;
  offlineBundle?: string | null;
  pin?: unknown;
}): {
  installed: boolean;
  faults: unknown[];
  binary?: string;
  binary_sha256?: unknown;
  asset_sha256?: unknown;
  signature?: Record<string, unknown>;
  schema?: GeneratedProtocolSchema;
} {
  const faults: unknown[] = [];
  for (const [name, value] of Object.entries({ version, tag, asset, artifactSha256, dest, cache })) {
    if (!value) {
      faults.push(fault('MISSING_ARGUMENT', name,
        'install takes every argument explicitly and guesses none', 'pass it; see --help'));
    }
  }
  if (faults.length) return { installed: false, faults };

  fs.mkdirSync(cache, { recursive: true });
  const verifyArgs: Array<string | null> = [VERIFY_RELEASE, '--tag', tag, '--asset', asset, '--sha256', artifactSha256, '--out', cache];
  if (offlineAsset) verifyArgs.push('--offline-asset', offlineAsset, '--offline-bundle', offlineBundle);
  let verdict: unknown;
  try {
    // Keep the original nullable argument behavior: when an offline asset is given
    // without its bundle, execFileSync rejects the null exactly as it did in JS.
    verdict = JSON.parse(execFileSync(process.execPath, verifyArgs as string[], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  } catch (error) {
    return { installed: false, faults: verificationFaults(error, asset) };
  }

  const assetPath = offlineAsset ?? path.join(cache, asset);
  const { name, bytes } = singleFileFromTarGz(fs.readFileSync(assetPath));
  const verdictRecord = asRecord(verdict);
  if (sha256(bytes) !== verdictRecord?.signed_blob_sha256) {
    return { installed: false, faults: [fault('HARNESS_BINARY_DIGEST_MISMATCH', name,
      'the binary unpacked here does not hash to what the verifier signed off on',
      'refuse the release and re-fetch')] };
  }

  const versionDir = path.join(dest, version);
  fs.mkdirSync(versionDir, { recursive: true });
  const binary = path.join(versionDir, 'codex');
  fs.writeFileSync(binary, bytes, { mode: 0o755 });

  const schemaDir = path.join(versionDir, 'protocol-schema');
  const generated = generateProtocolSchema(binary, schemaDir);
  const schemaFaults = checkProtocolSchema(generated, { pin });
  if (schemaFaults.length) return { installed: false, faults: schemaFaults, binary, schema: generated };

  return {
    installed: true,
    faults: [],
    binary,
    binary_sha256: verdictRecord?.signed_blob_sha256,
    asset_sha256: verdictRecord?.asset_sha256,
    signature: {
      verified: verdictRecord?.verified,
      identity_san: verdictRecord?.identity_san,
      identity_issuer: verdictRecord?.identity_issuer,
      rekor_log_index: verdictRecord?.rekor_log_index,
      not_verified: verdictRecord?.not_verified
    },
    schema: generated
  };
}

// Records a schema pin from a binary already on this machine. This is how the pin
// under harness/codex/schema/ is produced and re-produced; a box install never uses
// it, because a box installs from a verified release and nothing else.
export function pinFromLocalBinary(binary: string, outDir: string): GeneratedProtocolSchema & { codex_version: string } {
  const generated = generateProtocolSchema(binary, outDir);
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  return { ...generated, codex_version: version };
}

export { bundleSha256 };
