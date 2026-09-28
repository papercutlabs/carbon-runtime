#!/usr/bin/env node
// check-entrypoints — type-check every extensionless bin starter.
//
// The starters are executable JavaScript with no extension. The TypeScript 7.0.2
// sync API overlays each starter's exact source bytes as a same-directory
// virtual .mjs alias under a virtual tsconfig, so relative imports stay
// unchanged and `npm run typecheck` actually checks the starters. Missing or
// empty starters refuse; a deliberate wrong JSDoc type in a starter fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';

export const CORE_ENTRYPOINTS = ['bin/carbon', 'bin/carbon-harness'] as const;

export const ENTRYPOINTS = [
  'bin/carbon-email',
  'bin/carbon-import',
  'bin/carbon-runtime',
  'bin/carbon-stream',
  'bin/carbon-telegram',
  'bin/carbon-tool-server',
  'bin/carbon-whatsapp',
] as const;

export const RUNTIME_ENTRYPOINTS = ENTRYPOINTS;

export type EntrypointName = (typeof ENTRYPOINTS)[number];

export type PresentFault = {
  code: 'ENTRYPOINT_MISSING' | 'ENTRYPOINT_EMPTY' | 'ENTRYPOINT_NO_PROJECT' | 'ENTRYPOINT_ROOT_MISSING' | 'ENTRYPOINT_PACKAGE' | 'ENTRYPOINT_CONFIG';
  subject: string;
  problem: string;
  fix: string;
};

export type CheckDiagnostic = {
  fileName: string;
  code: number;
  text: string;
  pos: number;
  end: number;
};

export type CheckResult = {
  roots: string[];
  diagnostics: CheckDiagnostic[];
};

function fault(code: PresentFault['code'], subject: string, problem: string, fix: string): PresentFault {
  return { code, subject, problem, fix };
}

/** Carries PresentFault[] without a bare `throw new Error` string path. */
export class EntrypointFault {
  faults: PresentFault[];
  constructor(faults: PresentFault[]) {
    this.faults = faults;
  }
}

function requiredEntrypoints(root: string): readonly string[] {
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
    if ('name' in pkg && pkg.name === 'carbon-runtime') return RUNTIME_ENTRYPOINTS;
    if (!('name' in pkg) && 'private' in pkg && pkg.private === true) return CORE_ENTRYPOINTS;
  }
  throw new EntrypointFault([fault('ENTRYPOINT_PACKAGE', 'package.json',
    'the entrypoint checker does not recognize this package identity',
    'use the private core or named carbon-runtime package')]);
}

function allEntrypoints(root: string): string[] {
  const required = requiredEntrypoints(root);
  const bin = path.join(root, 'bin');
  const discovered = fs.existsSync(bin) ? fs.readdirSync(bin, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.includes('.'))
    .map((entry) => `bin/${entry.name}`) : [];
  return [...new Set([...required, ...discovered])].sort();
}

function assertEffectiveConfig(root: string): void {
  // The pinned compiler parses JSONC and inherited settings without inferring
  // allowJs from checkJs when the required setting was omitted.
  const api = new API({ cwd: root });
  let options: Record<string, unknown>;
  try {
    options = api.parseConfigFile(path.join(root, 'tsconfig.json')).options;
  } catch (error) {
    throw new EntrypointFault([fault('ENTRYPOINT_CONFIG', 'tsconfig.json',
      error instanceof Error ? error.message : String(error),
      'repair the TypeScript configuration')]);
  } finally {
    api.close();
  }
  for (const name of ['strict', 'allowJs', 'checkJs'] as const) {
    if (options[name] !== true) {
      throw new EntrypointFault([fault('ENTRYPOINT_CONFIG', `tsconfig.json compilerOptions.${name}`,
        `effective ${name} must be true`,
        `enable ${name} in the effective TypeScript configuration`)]);
    }
  }
}

/** Refuse when a named starter is absent or empty. Returns faults; empty means ok. */
export function assertPresent(root: string, names: readonly string[] = allEntrypoints(root)): PresentFault[] {
  const faults: PresentFault[] = [];
  for (const rel of names) {
    const at = path.join(root, rel);
    if (!fs.existsSync(at) || !fs.statSync(at).isFile()) {
      faults.push(fault('ENTRYPOINT_MISSING', rel,
        'this named starter is not a file in the repository',
        'restore the extensionless bin command and its adjacent .ts body'));
      continue;
    }
    const source = fs.readFileSync(at, 'utf8');
    if (source.length === 0) {
      faults.push(fault('ENTRYPOINT_EMPTY', rel,
        'this named starter has no source bytes',
        'restore the one-line import that loads the adjacent typed body'));
    }
  }
  return faults;
}

function virtualConfig(root: string, files: string[]) {
  return {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowJs: true,
      checkJs: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      maxNodeModuleJsDepth: 0,
      types: ['node'],
      typeRoots: [path.join(root, 'node_modules', '@types')],
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
    },
    files,
  };
}

function layeredFs(root: string, overlay: Map<string, string>, aliasNames: string[]) {
  const binDir = path.join(root, 'bin');
  return {
    readFile(fileName: string) {
      if (overlay.has(fileName)) return overlay.get(fileName);
      return undefined;
    },
    fileExists(fileName: string) {
      if (overlay.has(fileName)) return true;
      return undefined;
    },
    directoryExists(_directoryName: string) {
      return undefined;
    },
    getAccessibleEntries(directoryName: string) {
      if (path.resolve(directoryName) !== binDir) return undefined;
      // An absent bin directory has no directories; this empty list meets the entrypoint host interface.
      if (!fs.existsSync(binDir)) return { files: [...aliasNames], directories: [] as string[] };
      const real = fs.readdirSync(binDir, { withFileTypes: true });
      const files = real.filter((d) => d.isFile()).map((d) => d.name);
      const directories = real.filter((d) => d.isDirectory()).map((d) => d.name);
      for (const name of aliasNames) {
        if (!files.includes(name)) files.push(name);
      }
      return { files, directories };
    },
  };
}

/**
 * Type-check the named starters by presenting each as a same-directory virtual
 * .mjs alias with the starter's exact source bytes.
 */
export function checkEntrypoints(root: string, names: readonly string[] = allEntrypoints(root)): CheckResult {
  assertEffectiveConfig(root);
  const present = assertPresent(root, names);
  if (present.length > 0) throw new EntrypointFault(present);

  const overlay = new Map<string, string>();
  const files: string[] = [];
  const aliasNames: string[] = [];
  for (const rel of names) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const base = path.basename(rel);
    const aliasRel = `bin/${base}.mjs`;
    const aliasAbs = path.join(root, aliasRel);
    overlay.set(aliasAbs, source);
    files.push(aliasRel);
    aliasNames.push(`${base}.mjs`);
  }
  const configPath = path.join(root, 'tsconfig.entrypoints.json');
  overlay.set(configPath, JSON.stringify(virtualConfig(root, files), null, 2));

  const api = new API({ cwd: root, fs: layeredFs(root, overlay, aliasNames) });
  try {
    const snap = api.updateSnapshot({ openProjects: [configPath] });
    try {
      const projects = snap.getProjects();
      if (projects.length === 0) {
        throw new EntrypointFault([fault('ENTRYPOINT_NO_PROJECT', 'tsconfig.entrypoints.json',
          'the entrypoints typecheck opened no project',
          'check that the virtual config and starter aliases are present')]);
      }
      const project = projects[0];
      const roots = [...project.rootFiles];
      for (const rel of names) {
        const want = path.join(root, `bin/${path.basename(rel)}.mjs`);
        if (!roots.includes(want)) {
          throw new EntrypointFault([fault('ENTRYPOINT_ROOT_MISSING', rel,
            `the entrypoints typecheck is missing compiler root ${want}`,
            'restore the named starter so its virtual .mjs alias is a compiler root')]);
        }
      }
      const diagnostics: CheckDiagnostic[] = [];
      const seen = new Set<string>();
      for (const d of [
        ...project.program.getSyntacticDiagnostics(),
        ...project.program.getSemanticDiagnostics(),
        ...project.program.getProgramDiagnostics(),
      ]) {
        const fileName = d.fileName ?? '';
        // Only starter diagnostics fail this check; imported .ts bodies are
        // already under the repository's normal tsc --noEmit.
        if (!fileName.endsWith('.mjs') || !fileName.includes(`${path.sep}bin${path.sep}`)) continue;
        const key = `${fileName}:${d.pos}:${d.code}:${d.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push({
          fileName,
          code: d.code,
          text: d.text,
          pos: d.pos,
          end: d.end,
        });
      }
      return { roots, diagnostics };
    } finally {
      snap.dispose();
    }
  } finally {
    api.close();
  }
}

function main(argv: string[]) {
  const root = argv[2] ? path.resolve(argv[2]) : process.cwd();
  try {
    const result = checkEntrypoints(root);
    if (result.diagnostics.length > 0) {
      for (const d of result.diagnostics) {
        process.stderr.write(`${d.fileName}: error TS${d.code}: ${d.text}\n`);
      }
      return 1;
    }
    process.stdout.write(`# entrypoints: ${result.roots.length} starters checked, 0 errors\n`);
    return 0;
  } catch (error) {
    if (error instanceof EntrypointFault) {
      for (const f of error.faults) process.stderr.write(`${JSON.stringify(f)}\n`);
      return 1;
    }
    // This direct stack read preserves the caught Error path and its original null-throw behavior.
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv);
}
