#!/usr/bin/env node
// shape: justified one file so the two repositories can hold a byte-identical copy; splitting it would make the copy a tree and the drift test a directory walk
//
// shape-check — is Carbon still the shape it says it is?
//
// Carbon is two repositories that have to stay a particular shape: one public
// half that goes on a client box and one private half that never does, a store
// no code path can take records out of, adapters that reach each other through
// one library and never directly, and files a person can still read. Every one
// of those is a sentence in a README today, and a sentence in a README is a
// habit. This script is what makes each of them a refusal.
//
// It runs in both repositories. The file is byte-identical in both — carbon-core
// is the authority and carbon-runtime carries a copy, under the same rule as the
// harness copy, and carbon-core's test/public-copies.test.mjs compares the two.
// So it works out which repository it is looking at rather than being told.
//
// Usage:
//   node tools/shape-check.mjs [root] [--with <other checkout>] [--json] [--strict]
//
// `root` defaults to the repository this script sits in. `--with` names a
// checkout of the other half, which four rules need and say so when they do not
// have it. `--json` prints the whole model, which tools/map.mjs reads. `--strict`
// ignores the baseline below.
//
// Every violation is one line of {code, subject, problem, fix}, every violation
// from one run is printed together, and any violation that is not baselined
// exits non-zero.
//
// ---- the rules, and why each one is a rule --------------------------------
//
// Each rule's reason is the `why` field in RULES below and is printed by --help,
// so the reason travels with the refusal instead of living in a plan.
//
// ---- the baseline ----------------------------------------------------------
//
// tools/shape-baseline.json lists the violations that were already in the tree
// the day this script landed. They are not allowed and they are not hidden: they
// print under "known" on every run and they are the follow-up list. What the
// baseline buys is that a change that adds a new violation fails, today, rather
// than after somebody has worked through thirty old ones. An entry that no
// longer matches anything is printed as "fixed, take out of the baseline", so the
// baseline shrinks; it is not a failure, because somebody's fix must never be
// what turns the build red.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fault, report } from '../lib/faults.mjs';

// ---- what the rules are ----------------------------------------------------

export const RULES = {
  SHAPE_ONE_DEPENDENCY: {
    why: 'the runtime ships as a tarball onto a box with no registry, so every dependency is code this programme carries: exactly one, @whiskeysockets/baileys, pinned to an exact version.'
  },
  SHAPE_CLIENT_IDENTIFIER: {
    why: 'a client identifier in the core makes the universal layer client-specific, and one in the public half publishes it; both are refused by the scans that already exist.'
  },
  SHAPE_VENDORED_COPY: {
    why: 'the harness and the fault shape are copied, not depended on, so the copy must be byte-identical to its authority or the box runs code no repository owns.'
  },
  SHAPE_ADAPTER_REACH: {
    why: 'an adapter that imports another adapter, or the runtime, is a channel that knows about a channel; every adapter reaches the store through stream/ and nothing else.'
  },
  SHAPE_REPO_DIRECTION: {
    why: 'the private half may know about the public one, never the reverse, or the public tarball stops being installable on its own.'
  },
  SHAPE_DECLARED_FIELD_UNREAD: {
    why: 'a field in the declaration that nothing reads is a promise to a client repository that no code keeps.'
  },
  SHAPE_PRUNE_PATH: {
    why: 'a client agent keeps what arrived; a library that grows a retention path takes a client\'s evidence with it.'
  },
  SHAPE_FILE_LENGTH: {
    why: 'a source file over 600 lines is past what one person reads in a sitting; split it or say in the file why it is one thing.'
  },
  SHAPE_FUNCTION_LENGTH: {
    why: 'a function over 80 lines is doing more than one thing, and its middle is where a bug hides from review.'
  },
  SHAPE_COMPLEXITY: {
    why: 'a function with more than 15 independent paths cannot be held in a reader\'s head, and cannot be covered by tests anybody will write.'
  },
  SHAPE_FAN_OUT: {
    why: 'a module that imports more than 12 of its own repository\'s modules is a place work collected rather than a component.'
  },
  SHAPE_IMPORT_CYCLE: {
    why: 'a cycle means neither module can be read, tested or replaced without the other; there is no cap, the count is zero.'
  },
  SHAPE_LAYER: {
    why: 'imports run one way down the layers schema < stream, lib < adapters < runtime < bin; an upward import turns a layer into a caller of what calls it.'
  },
  SHAPE_DUPLICATION: {
    why: 'twenty near-identical lines in two places is one rule with two homes, and the second home is the one that will not be fixed.'
  },
  SHAPE_DEAD_EXPORT: {
    why: 'an exported symbol nothing imports is surface with no user: either something meant to call it does not, or it should stop being exported.'
  },
  SHAPE_UNTESTED_SUBCOMMAND: {
    why: 'a command line a person runs by hand is the part of the system with no other check on it, so every subcommand is named by a test.'
  },
  SHAPE_ERROR_PATH: {
    why: 'a bare `throw new Error` is a fault with no code, no subject and no fix, and an empty catch is a decision nobody wrote down.'
  }
};

export const CAPS = { file: 600, fn: 80, complexity: 15, fanOut: 12, duplication: 20 };

// The marker that says a cap was thought about. It carries its reason on the same
// line, because a marker with no reason is a marker somebody pasted.
const JUSTIFIED = /\/\/\s*shape:\s*justified\s+(\S.*)$/;

// ---- the tokenizer ---------------------------------------------------------
//
// Every rule below that talks about code reads tokens, never a regular
// expression over the text. A regex over source finds `import` inside a string
// and misses one inside a template; it also cannot tell a function's body from
// the next function's. This is a lexer for the subset of JavaScript these two
// repositories are written in: modules, no classes, no JSX, no decorators.
//
// The one judgment call is `/`: division or the start of a regular expression.
// The rule used here is the standard one — a `/` after a value (a name that is
// not a keyword, a number, a string, a template, `)`, `]`) divides, and a `/`
// anywhere else starts a regular expression.

const KEYWORDS = new Set([
  'await', 'case', 'catch', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'finally', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void',
  'yield', 'if', 'while', 'for', 'switch', 'function', 'const', 'let', 'var', 'import'
]);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const last = () => tokens[tokens.length - 1];

  const dividesNotRegex = () => {
    const t = last();
    if (!t) return false;
    if (t.type === 'number' || t.type === 'string' || t.type === 'template' || t.type === 'regex') return true;
    if (t.type === 'name') return !KEYWORDS.has(t.value);
    return t.value === ')' || t.value === ']';
  };

  const readString = (quote) => {
    const start = i;
    i += 1;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { i += 1; break; }
      if (c === '\n') line += 1;
      i += 1;
    }
    return { type: 'string', value: source.slice(start, i), start, line };
  };

  // A template literal is read whole, including any `${}` it carries, with the
  // nesting counted so a template inside a substitution does not end the outer
  // one. Nothing in these repositories needs the substitutions tokenized.
  const readTemplate = () => {
    const start = i;
    i += 1;
    let depth = 0;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line += 1;
      if (c === '`' && depth === 0) { i += 1; break; }
      if (c === '$' && source[i + 1] === '{') { depth += 1; i += 2; continue; }
      if (c === '}' && depth > 0) { depth -= 1; i += 1; continue; }
      if (c === '`' && depth > 0) { i += 1; continue; }
      i += 1;
    }
    return { type: 'template', value: source.slice(start, i), start, line };
  };

  const readRegex = () => {
    const start = i;
    i += 1;
    let inClass = false;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i += 1; break; }
      else if (c === '\n') break;
      i += 1;
    }
    while (i < n && /[a-z]/.test(source[i])) i += 1;
    return { type: 'regex', value: source.slice(start, i), start, line };
  };

  while (i < n) {
    const c = source[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      tokens.push({ type: 'comment', value: source.slice(start, i), start, line });
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line += 1; i += 1; }
      i += 2;
      tokens.push({ type: 'comment', value: source.slice(start, i), start, line: startLine });
      continue;
    }
    if (c === '"' || c === "'") { tokens.push(readString(c)); continue; }
    if (c === '`') { tokens.push(readTemplate()); continue; }
    if (c === '/' && !dividesNotRegex()) { tokens.push(readRegex()); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9a-fA-FxXoObBeE_.+-]/.test(source[i]) &&
             !(/[+-]/.test(source[i]) && !/[eE]/.test(source[i - 1] ?? ''))) i += 1;
      tokens.push({ type: 'number', value: source.slice(start, i), start, line });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      tokens.push({ type: 'name', value: source.slice(start, i), start, line });
      continue;
    }
    // Punctuation, longest match first, so `=>`, `&&`, `??=` and `...` are one token.
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (['...', '**=', '===', '!==', '&&=', '||=', '??=', '>>>'].includes(three)) {
      tokens.push({ type: 'punct', value: three, start: i, line }); i += 3; continue;
    }
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
         '*=', '/=', '%=', '|=', '&=', '^=', '**', '<<', '>>'].includes(two)) {
      tokens.push({ type: 'punct', value: two, start: i, line }); i += 2; continue;
    }
    tokens.push({ type: 'punct', value: c, start: i, line });
    i += 1;
  }
  return tokens;
}

const code = (tokens) => tokens.filter((t) => t.type !== 'comment');

// ---- what a module is ------------------------------------------------------

function matchBrace(tokens, at) {
  let depth = 0;
  for (let i = at; i < tokens.length; i += 1) {
    const v = tokens[i].type === 'punct' ? tokens[i].value : null;
    if (v === '{' || v === '(' || v === '[') depth += 1;
    else if (v === '}' || v === ')' || v === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

const quoted = (t) => (t && t.type === 'string' ? t.value.slice(1, -1) : null);

// Imports, exports and functions, read off the tokens.
export function readModule(source) {
  const all = tokenize(source);
  const t = code(all);
  const imports = [];
  const exports_ = [];
  const functions = [];

  for (let i = 0; i < t.length; i += 1) {
    const tok = t[i];
    if (tok.type !== 'name') continue;

    if (tok.value === 'import') {
      if (t[i + 1] && t[i + 1].value === '(') {
        const target = quoted(t[i + 2]);
        if (target) imports.push({ from: target, line: tok.line, dynamic: true });
        continue;
      }
      // `import 'x'` or `import ... from 'x'`
      const direct = quoted(t[i + 1]);
      if (direct) { imports.push({ from: direct, line: tok.line }); continue; }
      for (let j = i + 1; j < t.length && j < i + 200; j += 1) {
        if (t[j].type === 'name' && t[j].value === 'from') {
          const target = quoted(t[j + 1]);
          if (target) imports.push({ from: target, line: tok.line });
          i = j + 1;
          break;
        }
        if (t[j].type === 'punct' && t[j].value === ';') break;
      }
      continue;
    }

    if (tok.value === 'export') {
      const next = t[i + 1];
      if (!next) continue;
      if (next.value === '{') {
        const close = matchBrace(t, i + 1);
        for (let j = i + 2; j < close; j += 1) {
          if (t[j].type === 'name' && t[j].value !== 'as') {
            const isAlias = t[j - 1] && t[j - 1].value === 'as';
            const followedByAs = t[j + 1] && t[j + 1].value === 'as';
            if (!followedByAs || isAlias) exports_.push({ name: t[j].value, line: t[j].line });
            if (followedByAs && !isAlias) { /* the local name; the alias is what travels */ }
          }
        }
        const after = t[close + 1];
        if (after && after.type === 'name' && after.value === 'from') {
          const target = quoted(t[close + 2]);
          if (target) imports.push({ from: target, line: tok.line, reExport: true });
        }
        continue;
      }
      if (next.value === 'default') { exports_.push({ name: 'default', line: tok.line }); continue; }
      if (next.type === 'name' && ['const', 'let', 'var', 'function', 'async', 'class'].includes(next.value)) {
        let j = i + 2;
        while (j < t.length && t[j].type === 'name' &&
               ['function', 'async', 'class', 'const', 'let', 'var'].includes(t[j].value)) j += 1;
        if (t[j] && t[j].type === 'name') exports_.push({ name: t[j].value, line: tok.line });
        continue;
      }
    }
  }

  // Functions: the `function` keyword, and arrow functions with a block body.
  // Both are located by their body's braces, so a nested function is found too
  // and its tokens are taken out of the enclosing one's count.
  for (let i = 0; i < t.length; i += 1) {
    const tok = t[i];
    if (tok.type === 'name' && tok.value === 'function') {
      let j = i + 1;
      let name = '<anonymous>';
      if (t[j] && t[j].type === 'name') { name = t[j].value; j += 1; }
      if (t[j] && t[j].value === '*') j += 1;
      if (!t[j] || t[j].value !== '(') continue;
      const close = matchBrace(t, j);
      const brace = close + 1;
      if (!t[brace] || t[brace].value !== '{') continue;
      const end = matchBrace(t, brace);
      functions.push({ name, from: i, to: end, startLine: tok.line, endLine: t[end].line });
      continue;
    }
    if (tok.type === 'punct' && tok.value === '=>') {
      const body = t[i + 1];
      if (!body || body.value !== '{') continue;
      const end = matchBrace(t, i + 1);
      // The name is the thing it was assigned to, when it was assigned to one.
      let name = '<arrow>';
      let params = i;
      if (t[i - 1] && t[i - 1].value === ')') {
        let depth = 0;
        for (let j = i - 1; j >= 0; j -= 1) {
          const v = t[j].type === 'punct' ? t[j].value : null;
          if (v === ')' || v === ']' || v === '}') depth += 1;
          else if (v === '(' || v === '[' || v === '{') { depth -= 1; if (depth === 0) { params = j; break; } }
        }
      } else if (t[i - 1] && t[i - 1].type === 'name') params = i - 1;
      const before = t[params - 1];
      const before2 = t[params - 2];
      if (before && before.value === '=' && before2 && before2.type === 'name') name = before2.value;
      else if (before && before.value === ':' && before2 && before2.type === 'name') name = before2.value;
      else if (before && before.type === 'name' && before.value === 'async') {
        const b3 = t[params - 3];
        if (t[params - 2] && t[params - 2].value === '=' && b3 && b3.type === 'name') name = b3.value;
      }
      functions.push({ name, from: params, to: end, startLine: t[params].line, endLine: t[end].line, arrow: true });
    }
  }

  return { tokens: t, imports, exports: exports_, functions };
}

// Cyclomatic complexity: one, plus every point the flow can branch, counted over
// the function's own tokens with any nested function's tokens removed, so the
// number belongs to the function a reader is looking at.
const BRANCH_WORDS = new Set(['if', 'for', 'while', 'case', 'catch']);
const BRANCH_PUNCT = new Set(['&&', '||', '??', '?']);

export function complexityOf(module, fn) {
  const nested = module.functions.filter((o) => o !== fn && o.from > fn.from && o.to <= fn.to);
  let score = 1;
  for (let i = fn.from; i <= fn.to; i += 1) {
    if (nested.some((o) => i >= o.from && i <= o.to)) continue;
    const tok = module.tokens[i];
    if (tok.type === 'name' && BRANCH_WORDS.has(tok.value)) score += 1;
    else if (tok.type === 'punct' && BRANCH_PUNCT.has(tok.value)) score += 1;
  }
  return score;
}

// ---- the tree --------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.carbon-runtime', '.carbon-core']);

// What the repository holds is what git tracks. Reading the working tree instead
// would make the answer depend on whose machine it ran on: a half-written file
// somebody has not committed is not part of the shape, and the workflow, which
// only ever sees a commit, would disagree with the person running it by hand.
const TRACKED = new Map();

function trackedFiles(root) {
  if (TRACKED.has(root)) return TRACKED.get(root);
  let list = null;
  try {
    list = execFileSync('git', ['-C', root, 'ls-files'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // Not a checkout: fall back to the tree on disk, and say nothing, because
    // this is the path tools/map.mjs takes over an unpacked tarball.
    list = null;
  }
  TRACKED.set(root, list);
  return list;
}

function walkDisk(root, relative) {
  const found = [];
  const at = path.join(root, relative);
  if (!fs.existsSync(at)) return found;
  for (const name of fs.readdirSync(at).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = relative ? `${relative}/${name}` : name;
    if (fs.statSync(path.join(root, rel)).isDirectory()) found.push(...walkDisk(root, rel));
    else found.push(rel);
  }
  return found;
}

function walk(root, relative = '') {
  const tracked = trackedFiles(root);
  if (!tracked) return walkDisk(root, relative);
  const prefix = relative ? `${relative}/` : '';
  return tracked.filter((rel) => rel.startsWith(prefix)).sort();
}

// What counts as source: JavaScript modules, and the command lines under bin/,
// which have no extension and are the part of the system a person runs by hand.
function isSource(rel) {
  if (rel.endsWith('.mjs')) return true;
  return rel.startsWith('bin/') && !rel.includes('.');
}

const isTest = (rel) => rel.startsWith('test/') || rel.startsWith('conformance/');

// Which repository is this. The private half has the installer and the host
// contract; the public half has the store library. Neither has the other's.
export function repoKindOf(root) {
  if (fs.existsSync(path.join(root, 'stream', 'store.mjs'))) return 'runtime';
  if (fs.existsSync(path.join(root, 'lib', 'install.mjs'))) return 'core';
  return null;
}

// The layers, in the order imports are allowed to run. Same-layer imports are
// fine; an import that goes up is not.
const LAYERS = [
  ['schema/', 0],
  ['stream/', 1], ['lib/', 1], ['tools/lib/', 1], ['harness/', 1],
  ['adapters/', 2], ['import/', 2], ['conformance/', 2],
  ['runtime/', 3],
  ['bin/', 4], ['tools/', 4], ['test/', 5]
];

export function layerOf(rel) {
  let best = null;
  for (const [prefix, layer] of LAYERS) {
    if (rel.startsWith(prefix) && (best === null || prefix.length > best[0].length)) best = [prefix, layer];
  }
  return best ? best[1] : null;
}

// Files that are a copy of the other repository's file, by name. They are the
// one place the two trees legitimately hold the same bytes, so the duplication
// and one-direction rules step over them and the copy rule owns them instead.
export const VENDORED = [
  'lib/faults.mjs',
  'tools/lib/fault.mjs',
  'tools/lib/args.mjs',
  'tools/lib/manifest.mjs',
  'tools/lib/mcp.mjs',
  'tools/shape-check.mjs',
  'schema/carbon.message.v1.json'
];
const VENDORED_TREES = ['harness/codex/'];
export const isVendored = (rel) => VENDORED.includes(rel) || VENDORED_TREES.some((p) => rel.startsWith(p));

// ---- the model -------------------------------------------------------------

export function analyse(root) {
  const kind = repoKindOf(root);
  const files = walk(root).filter(isSource);
  const modules = new Map();
  for (const rel of files) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const module = readModule(source);
    const lines = source.split('\n');
    modules.set(rel, {
      rel,
      lines: lines.length,
      text: source,
      layer: layerOf(rel),
      test: isTest(rel),
      justified: (lines.find((l) => JUSTIFIED.test(l)) ?? '').match(JUSTIFIED)?.[1] ?? null,
      ...module,
      // Where each import resolves to, inside this repository, as a repo-relative
      // path. An import of a package or of node: resolves to nothing.
      edges: module.imports.map((spec) => ({ ...spec, to: resolveImport(root, rel, spec.from) }))
    });
  }
  return { root, kind, modules };
}

function resolveImport(root, from, spec) {
  if (!spec.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(path.join(root, from)), spec);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..')) return { outside: true, rel: path.normalize(spec) };
  return { outside: false, rel: rel.split(path.sep).join('/') };
}

// ---- the rules -------------------------------------------------------------

function shellOk(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: '' };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
  }
}

function oneDependency(root, kind, out, notes) {
  if (kind !== 'runtime') { notes.push('SHAPE_ONE_DEPENDENCY: not checked, this is the private half and it has no package.json'); return; }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = pkg.dependencies ?? {};
  const names = Object.keys(declared);
  const expected = '@whiskeysockets/baileys';
  if (names.length !== 1 || names[0] !== expected) {
    out.push(fault('SHAPE_ONE_DEPENDENCY', 'package.json',
      `this repository declares ${names.length === 0 ? 'no dependency' : names.join(', ')}, and it has exactly one: ${expected}`,
      `remove the extra dependency, or write what it does on a box into the README's one-dependency section and change this rule deliberately`));
    return;
  }
  if (!/^[0-9]/.test(declared[expected])) {
    out.push(fault('SHAPE_ONE_DEPENDENCY', 'package.json',
      `${expected} is declared as ${declared[expected]}, which is a range and not a version`,
      'pin the exact version, so the tarball that goes on a box is the one that was tested'));
  }
  if ((Object.keys(pkg.devDependencies ?? {})).length > 0) {
    out.push(fault('SHAPE_ONE_DEPENDENCY', 'package.json',
      'this repository declares development dependencies, and the tests run on Node alone',
      'remove them; node --test and node:assert are what the tests use'));
  }
}

function clientIdentifiers(root, kind, out, notes) {
  if (kind === 'runtime') {
    const scan = path.join(root, 'tools', 'scan-identifiers.mjs');
    const result = shellOk(process.execPath, [scan, root], root);
    if (!result.ok) {
      for (const line of result.out.split('\n').filter((l) => l.trim().startsWith('{'))) {
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (parsed) out.push(fault('SHAPE_CLIENT_IDENTIFIER', parsed.subject, parsed.problem, parsed.fix));
      }
      if (!result.out.includes('{')) {
        out.push(fault('SHAPE_CLIENT_IDENTIFIER', 'tools/scan-identifiers.mjs',
          `the identifier scan did not run: ${result.out.split('\n')[0] ?? 'no output'}`,
          'run node tools/scan-identifiers.mjs . and read what it says'));
      }
    }
    notes.push('SHAPE_CLIENT_IDENTIFIER: tools/scan-identifiers.mjs over the whole public tree');
    return;
  }
  const result = shellOk(process.execPath, [
    path.join(root, 'bin', 'carbon'), 'declaration', 'check',
    path.join(root, 'test', 'fixtures', 'valid-declaration.json'),
    '--core-clean', path.join(root, 'tools', 'client-denylist.txt'), '--tree', root
  ], root);
  if (!result.ok) {
    out.push(fault('SHAPE_CLIENT_IDENTIFIER', 'the core tree',
      `carbon declaration check --core-clean refused this tree: ${result.out.split('\n').filter(Boolean).slice(0, 4).join(' | ')}`,
      'move the client-specific line into that client\'s own repository; the core is the universal layer'));
  }
  notes.push('SHAPE_CLIENT_IDENTIFIER: carbon declaration check --core-clean over the whole core tree');
}

function vendoredCopies(root, kind, other, out, notes) {
  if (!other) {
    notes.push('SHAPE_VENDORED_COPY: not checked, --with was not given, so there is no second copy to compare against');
    if (kind === 'runtime') {
      const source = path.join(root, 'harness', 'HARNESS-SOURCE');
      const text = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : '';
      if (!/^source commit +[0-9a-f]{40}$/m.test(text)) {
        out.push(fault('SHAPE_VENDORED_COPY', 'harness/HARNESS-SOURCE',
          'the copied harness does not name the authority commit it was taken from',
          'write `source commit <40 hex>` into harness/HARNESS-SOURCE when you copy the harness again'));
      }
      if (fs.existsSync(path.join(root, 'harness', 'codex', 'verifications'))) {
        out.push(fault('SHAPE_VENDORED_COPY', 'harness/codex/verifications',
          'the verifications are the record of what the pinned binary does and they stay in the private half',
          'delete the directory here; copy harness/codex/ minus verifications/'));
      }
    }
    return;
  }
  const authority = kind === 'core' ? root : other;
  const copy = kind === 'core' ? other : root;
  const files = [...VENDORED.filter((f) => f !== 'schema/carbon.message.v1.json'),
    ...VENDORED_TREES.flatMap((tree) => walk(authority, tree.replace(/\/$/, ''))
      .filter((f) => !f.includes('/verifications/')))];
  for (const rel of files) {
    const here = path.join(authority, rel);
    const there = path.join(copy, rel);
    if (!fs.existsSync(here)) continue;
    if (!fs.existsSync(there)) {
      out.push(fault('SHAPE_VENDORED_COPY', rel,
        'the public half has no copy of this file, and its harness copy imports it',
        `copy ${rel} from the private half and record the commit in harness/HARNESS-SOURCE`));
      continue;
    }
    if (!fs.readFileSync(here).equals(fs.readFileSync(there))) {
      out.push(fault('SHAPE_VENDORED_COPY', rel,
        'the copy has drifted from its authority, so the box would run code neither repository owns',
        'change the file in the private half, land it, copy it over, and update harness/HARNESS-SOURCE'));
    }
  }
  notes.push(`SHAPE_VENDORED_COPY: ${files.length} files compared byte for byte against ${authority}`);
}

function adapterReach(root, modules, out) {
  for (const module of modules.values()) {
    if (!module.rel.startsWith('adapters/')) continue;
    const own = module.rel.split('/').slice(0, 2).join('/');
    for (const edge of module.edges) {
      if (!edge.to || edge.to.outside) continue;
      const to = edge.to.rel;
      const allowed = to.startsWith('stream/') || to.startsWith('lib/') || to.startsWith(`${own}/`);
      if (allowed) continue;
      out.push(fault('SHAPE_ADAPTER_REACH', `${module.rel}:${edge.line}`,
        `this adapter imports ${to}, and an adapter reaches only stream/, lib/ and its own directory`,
        to.startsWith('adapters/')
          ? 'move what both adapters need into stream/ or lib/; one channel never knows about another'
          : 'an adapter does not import the runtime; the runtime hosts the adapter, not the other way round'));
    }
  }
}

function repoDirection(root, kind, modules, out) {
  const foreign = kind === 'core'
    ? ['stream/', 'adapters/', 'runtime/', 'conformance/']
    : ['host/', 'lib/install.mjs', 'lib/doctor.mjs', 'lib/runner.mjs', 'lib/declaration.mjs'];
  for (const module of modules.values()) {
    for (const edge of module.edges) {
      if (!edge.to) continue;
      if (edge.to.outside) {
        out.push(fault('SHAPE_REPO_DIRECTION', `${module.rel}:${edge.line}`,
          `this import reaches ${edge.to.rel}, which is outside this repository`,
          'an import never leaves the repository; copy the file under the vendored-copy rule, or move the caller'));
        continue;
      }
      if (isVendored(module.rel)) continue;
      if (kind === 'runtime' && foreign.some((p) => edge.to.rel === p || edge.to.rel.startsWith(p))) {
        out.push(fault('SHAPE_REPO_DIRECTION', `${module.rel}:${edge.line}`,
          `this imports ${edge.to.rel}, which belongs to the private half`,
          'the public half stands on its own; what it needs is copied under the vendored-copy rule'));
      }
    }
    for (const spec of module.imports) {
      if (spec.from === 'carbon' || spec.from === 'carbon-core' || spec.from.startsWith('carbon-core/')
        || (kind === 'core' && spec.from.startsWith('carbon-runtime'))) {
        out.push(fault('SHAPE_REPO_DIRECTION', `${module.rel}:${spec.line}`,
          `this imports the other repository by package name (${spec.from})`,
          'neither half is a dependency of the other; the public half is installed as a pinned tarball'));
      }
    }
  }
}

// Every leaf of the declaration schema, as a dotted path.
export function declarationFields(schemaFile) {
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const found = [];
  const visit = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      for (const key of Object.keys(node.properties)) {
        const next = at ? `${at}.${key}` : key;
        found.push(next);
        visit(node.properties[key], next);
      }
    }
    if (node.items) visit(node.items, `${at}[]`);
    for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(node[key])) node[key].forEach((sub) => visit(sub, at));
  };
  visit(schema, '');
  return [...new Set(found)];
}

// A field is read when its own name appears as a word in the code that consumes
// declarations. That is a whole-word match over lib/ and runtime/, not a proof
// the value is used; it catches the case this rule is for, a field added to the
// schema and to nothing else. A common word like `name` passes trivially, and
// that is the known limit of the check.
function declaredFieldsRead(root, kind, other, out, notes) {
  // The readers of a declaration are split across the two halves — install and
  // doctor read it from outside the box, the release loop reads it on the box —
  // so this rule needs both checkouts or it would call a field the other half
  // reads unread. With one checkout it says so and checks nothing.
  if (!other) {
    notes.push('SHAPE_DECLARED_FIELD_UNREAD: not checked, its readers are split across both halves and --with was not given');
    return;
  }
  const schemaFile = kind === 'core'
    ? path.join(root, 'schema', 'carbon.agent-declaration.v1.json')
    : path.join(other, 'schema', 'carbon.agent-declaration.v1.json');
  if (!fs.existsSync(schemaFile)) {
    notes.push('SHAPE_DECLARED_FIELD_UNREAD: not checked, the declaration schema lives in the private half and is not in reach');
    return;
  }
  const readers = [];
  const add = (base, dirs) => {
    if (!base) return;
    for (const dir of dirs) {
      for (const rel of walk(base, dir).filter(isSource)) readers.push(fs.readFileSync(path.join(base, rel), 'utf8'));
    }
  };
  const here = kind === 'core' ? ['lib'] : ['runtime', 'lib'];
  const there = kind === 'core' ? ['runtime', 'lib'] : ['lib'];
  add(root, here);
  add(other, there);
  if (readers.length === 0) {
    notes.push('SHAPE_DECLARED_FIELD_UNREAD: not checked, neither lib/ nor runtime/ was in reach');
    return;
  }
  const text = readers.join('\n');
  const words = new Set();
  for (const word of text.split(/[^A-Za-z0-9_]+/)) if (word) words.add(word);
  const missing = [];
  for (const field of declarationFields(schemaFile)) {
    const leaf = field.split('.').pop().replace('[]', '');
    if (!words.has(leaf)) missing.push(field);
  }
  for (const field of missing) {
    out.push(fault('SHAPE_DECLARED_FIELD_UNREAD', `carbon.agent-declaration.v1.json ${field}`,
      'this field is in the declaration a client repository writes and nothing in lib/ or runtime/ reads it',
      'read it where it belongs, or take it out of the schema; the exact-keys rule means a client cannot ignore it'));
  }
  notes.push(`SHAPE_DECLARED_FIELD_UNREAD: ${declarationFields(schemaFile).length} fields checked against `
    + `${here.map((d) => `${path.basename(root)}/${d}`).join(', ')}`
    + (other ? ` and ${there.map((d) => `${path.basename(other)}/${d}`).join(', ')}`
             : '; --with was not given, so the other half\'s readers were not read and a field it reads shows here'));
}

function prunePath(root, kind, out, notes) {
  const dirs = kind === 'runtime'
    ? ['stream', 'adapters', 'import', 'conformance', 'bin', 'runtime']
    : ['lib', 'bin'];
  const pattern = /prune|retention/i;
  let looked = 0;
  for (const dir of dirs) {
    for (const rel of walk(root, dir)) {
      const full = path.join(root, rel);
      if (/\.(png|jpg|gz|zip|pem)$/i.test(rel)) continue;
      looked += 1;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!pattern.test(line)) return;
        out.push(fault('SHAPE_PRUNE_PATH', `${rel}:${i + 1}`,
          'this line names a path that takes a client\'s records away, and a client agent keeps what arrived',
          'if something really has to go, it is a person deleting it on the box, not a library doing it on a timer'));
      });
    }
  }
  notes.push(`SHAPE_PRUNE_PATH: ${looked} files under ${dirs.join(', ')}`);
}

function fileLength(modules, out) {
  for (const module of modules.values()) {
    if (module.lines <= CAPS.file) continue;
    if (module.justified) continue;
    out.push(fault('SHAPE_FILE_LENGTH', `${module.rel} (${module.lines} lines)`,
      `this file is ${module.lines} lines and the cap is ${CAPS.file}`,
      `split it, or write \`// shape: justified <reason>\` in it saying why it is one thing`));
  }
}

function functionShape(modules, out) {
  for (const module of modules.values()) {
    if (module.test) continue;
    const lines = module.text.split('\n');
    for (const fn of module.functions) {
      const span = lines.slice(Math.max(0, fn.startLine - 2), fn.endLine).join('\n');
      const justified = JUSTIFIED.test(span);
      const length = fn.endLine - fn.startLine + 1;
      if (length > CAPS.fn && !justified) {
        out.push(fault('SHAPE_FUNCTION_LENGTH', `${module.rel}:${fn.startLine} ${fn.name} (${length} lines)`,
          `this function is ${length} lines and the cap is ${CAPS.fn}`,
          'take the middle of it out into a named function, or justify the length in the function with a shape: justified line'));
      }
      const score = complexityOf(module, fn);
      if (score > CAPS.complexity && !justified) {
        out.push(fault('SHAPE_COMPLEXITY', `${module.rel}:${fn.startLine} ${fn.name} (complexity ${score})`,
          `this function has ${score} independent paths and the cap is ${CAPS.complexity}`,
          'lift the branches into named predicates or a table, or justify it in the function with a shape: justified line'));
      }
    }
  }
}

export function graphOf(modules) {
  const out = new Map();
  for (const rel of modules.keys()) out.set(rel, { rel, to: new Set(), from: new Set() });
  for (const module of modules.values()) {
    for (const edge of module.edges) {
      if (!edge.to || edge.to.outside) continue;
      if (!out.has(edge.to.rel)) continue;
      out.get(module.rel).to.add(edge.to.rel);
      out.get(edge.to.rel).from.add(module.rel);
    }
  }
  return out;
}

function fanOut(graph, modules, out) {
  for (const node of graph.values()) {
    if (modules.get(node.rel)?.test) continue;
    if (node.to.size <= CAPS.fanOut) continue;
    if (modules.get(node.rel)?.justified) continue;
    out.push(fault('SHAPE_FAN_OUT', `${node.rel} (fan-out ${node.to.size})`,
      `this module imports ${node.to.size} of this repository's own modules and the cap is ${CAPS.fanOut}`,
      'this is where work collected; give the group it reaches a name of its own, or justify it with a shape: justified line'));
  }
}

export function cyclesIn(graph) {
  const colour = new Map();
  const stack = [];
  const found = [];
  const visit = (rel) => {
    colour.set(rel, 'grey');
    stack.push(rel);
    for (const next of graph.get(rel)?.to ?? []) {
      if (colour.get(next) === 'grey') found.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!colour.has(next)) visit(next);
    }
    stack.pop();
    colour.set(rel, 'black');
  };
  for (const rel of [...graph.keys()].sort()) if (!colour.has(rel)) visit(rel);
  return found;
}

function importCycles(graph, out) {
  for (const cycle of cyclesIn(graph)) {
    out.push(fault('SHAPE_IMPORT_CYCLE', cycle[0],
      `this module is in an import cycle: ${cycle.join(' -> ')}`,
      'move what both ends need into a module below both of them; there is no justified marker for a cycle'));
  }
}

function layerDirection(modules, out) {
  for (const module of modules.values()) {
    if (module.layer === null) continue;
    for (const edge of module.edges) {
      if (!edge.to || edge.to.outside) continue;
      const target = layerOf(edge.to.rel);
      if (target === null) continue;
      if (target > module.layer) {
        out.push(fault('SHAPE_LAYER', `${module.rel}:${edge.line}`,
          `a layer-${module.layer} module imports ${edge.to.rel}, which is layer ${target}; imports run down, never up`,
          'move the shared thing down to a layer below both, or invert the call so the upper layer passes it in'));
      }
    }
  }
}

// Duplication: a run of twenty or more lines that, with whitespace collapsed and
// comments and blank lines dropped, is the same in two places. Comments are
// dropped because two copies of a rule with different comments are still two
// copies of the rule.
function normalisedLines(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const stripped = line.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ');
    if (stripped.length > 0) out.push({ line: i + 1, text: stripped });
  });
  return out;
}

export function duplicationIn(trees) {
  // trees: [{ label, root, modules }]
  const blocks = new Map();
  for (const tree of trees) {
    for (const module of tree.modules.values()) {
      if (module.test || isVendored(module.rel)) continue;
      const lines = normalisedLines(module.text);
      for (let i = 0; i + CAPS.duplication <= lines.length; i += 1) {
        const window = lines.slice(i, i + CAPS.duplication);
        const key = window.map((l) => l.text).join('\n');
        if (!blocks.has(key)) blocks.set(key, []);
        blocks.get(key).push({ tree: tree.label, rel: module.rel, line: window[0].line });
      }
    }
  }
  const groups = [];
  for (const [, where] of blocks) {
    const distinct = [...new Map(where.map((w) => [`${w.tree}:${w.rel}`, w])).values()];
    if (distinct.length < 2) continue;
    groups.push(distinct);
  }
  // One long duplicated run makes many overlapping windows; keep the first of
  // each set of files and drop the rest, so the report names a place once.
  const seen = new Set();
  const kept = [];
  for (const group of groups) {
    const key = group.map((g) => `${g.tree}:${g.rel}`).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(group);
  }
  return kept;
}

function duplication(trees, out) {
  for (const group of duplicationIn(trees)) {
    const where = group.map((g) => `${g.tree}/${g.rel}:${g.line}`).join(' and ');
    const crossRepo = new Set(group.map((g) => g.tree)).size > 1;
    out.push(fault('SHAPE_DUPLICATION', group[0].tree === trees[0].label ? `${group[0].rel}:${group[0].line}` : `${group[0].tree}/${group[0].rel}:${group[0].line}`,
      `${CAPS.duplication} or more near-identical lines in ${where}${crossRepo ? ', across the two repositories' : ''}`,
      crossRepo
        ? 'the public half is re-implementing the private half\'s logic; make it a vendored copy with the copy rule on it, or move the rule to one side'
        : 'give the block one home and call it from both places'));
  }
}

function deadExports(modules, out) {
  const imported = new Map();
  for (const module of modules.values()) {
    for (const edge of module.edges) {
      if (!edge.to || edge.to.outside) continue;
      if (!imported.has(edge.to.rel)) imported.set(edge.to.rel, new Set());
    }
  }
  // What names each module actually pulls in, taken off the tokens of the
  // import clause rather than guessed from the text.
  for (const module of modules.values()) {
    const tokens = module.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      if (!(tokens[i].type === 'name' && tokens[i].value === 'import')) continue;
      let j = i + 1;
      const names = [];
      let starImport = false;
      while (j < tokens.length && !(tokens[j].type === 'name' && tokens[j].value === 'from')) {
        if (tokens[j].type === 'string') break;
        if (tokens[j].value === '*') starImport = true;
        if (tokens[j].type === 'name' && !['as', 'import'].includes(tokens[j].value)) names.push(tokens[j].value);
        j += 1;
      }
      const target = quoted(tokens[j + 1]);
      if (!target) continue;
      const to = resolveImportRel(module.rel, target);
      if (!to) continue;
      if (!imported.has(to)) imported.set(to, new Set());
      if (starImport) imported.get(to).add('*');
      for (const name of names) imported.get(to).add(name);
    }
  }
  for (const module of modules.values()) {
    if (module.test || isVendored(module.rel)) continue;
    if (module.rel.startsWith('bin/')) continue;
    const users = imported.get(module.rel);
    for (const exported of module.exports) {
      if (exported.name === 'default') continue;
      if (users && (users.has('*') || users.has(exported.name))) continue;
      out.push(fault('SHAPE_DEAD_EXPORT', `${module.rel}:${exported.line} ${exported.name}`,
        'this symbol is exported and nothing in this repository imports it, tests included',
        'either the thing that was meant to call it does not, or it is internal: take the export off'));
    }
  }
}

function resolveImportRel(from, spec) {
  if (!spec.startsWith('.')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return joined.startsWith('..') ? null : joined;
}

// A subcommand is a string literal a command line compares its argument against.
// They are read off the tokens of bin/ files: `case 'x':` and `=== 'x'`. A
// subcommand is tested when its name appears in a test file.
export function subcommandsIn(modules) {
  const found = new Map();
  for (const module of modules.values()) {
    if (!module.rel.startsWith('bin/')) continue;
    const t = module.tokens;
    for (let i = 0; i < t.length; i += 1) {
      const tok = t[i];
      let literal = null;
      if (tok.type === 'name' && tok.value === 'case' && t[i + 1]?.type === 'string') literal = quoted(t[i + 1]);
      else if (tok.type === 'punct' && tok.value === '===' && t[i + 1]?.type === 'string') literal = quoted(t[i + 1]);
      if (!literal) continue;
      if (!/^[a-z][a-z0-9-]*$/.test(literal)) continue;
      if (literal.startsWith('-')) continue;
      if (!found.has(module.rel)) found.set(module.rel, new Set());
      found.get(module.rel).add(literal);
    }
  }
  return found;
}

function untestedSubcommands(root, modules, out, notes) {
  const tests = walk(root, 'test').filter((rel) => rel.endsWith('.mjs'))
    .map((rel) => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');
  const workflow = path.join(root, '.github', 'workflows', 'check.yml');
  const ci = fs.existsSync(workflow) ? fs.readFileSync(workflow, 'utf8') : '';
  const seen = tests + '\n' + ci;
  let counted = 0;
  for (const [rel, names] of subcommandsIn(modules)) {
    for (const name of [...names].sort()) {
      counted += 1;
      const word = new RegExp(`(^|[^A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`, 'm');
      if (word.test(seen)) continue;
      out.push(fault('SHAPE_UNTESTED_SUBCOMMAND', `${rel} ${name}`,
        'this subcommand is not named by any test and not run by the workflow, so nothing checks it but a person',
        'write the test, or run it in .github/workflows/check.yml where running it is the check'));
    }
  }
  notes.push(`SHAPE_UNTESTED_SUBCOMMAND: ${counted} subcommands read off bin/`);
}

const FAULT_LIBRARIES = new Set(['lib/faults.mjs', 'stream/faults.mjs', 'tools/lib/fault.mjs', 'runtime/faults.mjs', 'adapters/email/curl.mjs']);

function errorPaths(modules, out) {
  for (const module of modules.values()) {
    if (module.test || FAULT_LIBRARIES.has(module.rel) || isVendored(module.rel)) continue;
    const t = module.tokens;
    for (let i = 0; i < t.length; i += 1) {
      if (t[i].type === 'name' && t[i].value === 'throw'
        && t[i + 1]?.value === 'new' && t[i + 2]?.value === 'Error') {
        out.push(fault('SHAPE_ERROR_PATH', `${module.rel}:${t[i].line}`,
          'a bare `throw new Error` leaves the caller a string with no code, no subject and no fix',
          'throw the fault shape from lib/faults.mjs, or collect it and report it with the other faults'));
      }
      if (t[i].type === 'name' && t[i].value === 'catch') {
        let j = i + 1;
        if (t[j]?.value === '(') j = matchBrace(t, j) + 1;
        if (t[j]?.value === '{' && t[j + 1]?.value === '}') {
          out.push(fault('SHAPE_ERROR_PATH', `${module.rel}:${t[i].line}`,
            'an empty catch swallows a failure, and a failure nobody sees is the one that gets diagnosed by archaeology',
            'say what the failure means here, even if that is one comment and a named fallback value'));
        }
      }
    }
  }
}

// ---- the public surface, as a number -------------------------------------

export function surfaceOf(root, kind, modules, other) {
  const exported = [...modules.values()]
    .filter((m) => !m.test && !m.rel.startsWith('bin/'))
    .reduce((sum, m) => sum + m.exports.length, 0);
  const subcommands = [...subcommandsIn(modules).values()].reduce((sum, set) => sum + set.size, 0);
  const schemaFile = kind === 'core'
    ? path.join(root, 'schema', 'carbon.agent-declaration.v1.json')
    : (other ? path.join(other, 'schema', 'carbon.agent-declaration.v1.json') : null);
  const fields = schemaFile && fs.existsSync(schemaFile) ? declarationFields(schemaFile).length : null;
  return { exported_symbols: exported, cli_subcommands: subcommands, declaration_fields: fields };
}

// ---- running everything ----------------------------------------------------

export function check(root, { other = null } = {}) {
  const tree = analyse(root);
  const kind = tree.kind;
  if (!kind) throw Object.assign(new Error(`${root} is neither half of Carbon`), { carbon: true });
  const otherTree = other ? analyse(other) : null;
  const violations = [];
  const notes = [];

  oneDependency(root, kind, violations, notes);
  clientIdentifiers(root, kind, violations, notes);
  vendoredCopies(root, kind, other, violations, notes);
  adapterReach(root, tree.modules, violations);
  repoDirection(root, kind, tree.modules, violations);
  declaredFieldsRead(root, kind, other, violations, notes);
  prunePath(root, kind, violations, notes);
  fileLength(tree.modules, violations);
  functionShape(tree.modules, violations);
  const graph = graphOf(tree.modules);
  fanOut(graph, tree.modules, violations);
  importCycles(graph, violations);
  layerDirection(tree.modules, violations);
  const trees = [{ label: kind, root, modules: tree.modules }];
  if (otherTree) trees.push({ label: otherTree.kind, root: other, modules: otherTree.modules });
  else notes.push('SHAPE_DUPLICATION: the cross-repository half was not checked, --with was not given');
  duplication(trees, violations);
  deadExports(tree.modules, violations);
  untestedSubcommands(root, tree.modules, violations, notes);
  errorPaths(tree.modules, violations);

  return { root, kind, tree, graph, violations, notes, surface: surfaceOf(root, kind, tree.modules, other) };
}

// ---- the baseline ----------------------------------------------------------

function baselineFile(root) { return path.join(root, 'tools', 'shape-baseline.json'); }

// A baseline entry has to survive somebody adding a line above the thing it
// names, or every edit anywhere would look like a new violation. So the key is
// the rule and the place, with the line number and the measured number taken
// out, and the baseline records how many that place had. One more than that is
// new and fails; one fewer is a fix and is printed.
export function baselineKey(f) {
  return `${f.code} ${f.subject.replace(/:\d+/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim()}`;
}

export function splitByBaseline(root, violations) {
  const file = baselineFile(root);
  if (!fs.existsSync(file)) return { fresh: violations, known: [], stale: [] };
  const listed = JSON.parse(fs.readFileSync(file, 'utf8')).known ?? {};
  const seen = new Map();
  const fresh = [];
  const known = [];
  for (const v of violations) {
    const key = baselineKey(v);
    const used = seen.get(key) ?? 0;
    if (used < (listed[key] ?? 0)) { known.push(v); seen.set(key, used + 1); } else fresh.push(v);
  }
  const stale = Object.entries(listed)
    .filter(([key, count]) => (seen.get(key) ?? 0) < count)
    .map(([key, count]) => `${key} (${count - (seen.get(key) ?? 0)} of ${count} gone)`);
  return { fresh, known, stale };
}

export function baselineFrom(violations) {
  const counts = {};
  for (const v of violations) {
    const key = baselineKey(v);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { known: Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]])) };
}

const HELP = `shape-check — is Carbon still the shape it says it is?

Usage:
  node tools/shape-check.mjs [root] [--with <other checkout>] [--json] [--strict]

  root      the repository to check; the one this script sits in by default
  --with    a checkout of the other half of Carbon. The vendored-copy rule, the
            declared-field rule and the cross-repository half of the duplication
            rule need it, and say so on their own line when they do not have it.
  --json    print the whole model, which tools/map.mjs reads
  --strict  ignore tools/shape-baseline.json and fail on every violation
  --write-baseline  record today's violations as the follow-up list, by hand, once

Every violation is one line of {code, subject, problem, fix}. All of them are
printed together and any that is not in the baseline exits non-zero.

The rules, and why each one is a rule:

${Object.entries(RULES).map(([code, rule]) => `  ${code}\n    ${rule.why}`).join('\n')}

Caps: file ${CAPS.file} lines, function ${CAPS.fn} lines, complexity ${CAPS.complexity},
fan-out ${CAPS.fanOut}, duplication ${CAPS.duplication} lines. A cap is escaped by a
\`// shape: justified <reason>\` line in the file, or inside the function for the
per-function caps. The cycle, layer, copy, dependency, identifier, prune,
declared-field, dead-export, subcommand and error-path rules have no escape.
`;

export function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return 0; }
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const withAt = args.indexOf('--with');
  const other = withAt === -1 ? null : path.resolve(args[withAt + 1] ?? '');
  const positional = args.filter((a, i) => !a.startsWith('--') && !(withAt !== -1 && i === withAt + 1));
  const root = path.resolve(positional[0] ?? path.join(import.meta.dirname, '..'));

  if (other && !repoKindOf(other)) {
    report([fault('SHAPE_ARGUMENT', '--with', `${other} is not a checkout of either half of Carbon`,
      'give the path to a carbon-core or carbon-runtime checkout')]);
    return 1;
  }

  let result;
  try {
    result = check(root, { other });
  } catch (error) {
    report([fault('SHAPE_ARGUMENT', root, error.message, 'give the path to a carbon-core or carbon-runtime checkout')]);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(modelFor(result, strict), null, 2) + '\n');
    return 0;
  }

  // --write-baseline records today's tree as the follow-up list. It is run by
  // hand, once, when a rule lands; a rule that a change breaks is fixed, not
  // re-baselined.
  if (args.includes('--write-baseline')) {
    fs.writeFileSync(baselineFile(root), JSON.stringify(baselineFrom(result.violations), null, 2) + '\n');
    process.stdout.write(`# wrote ${baselineFile(root)} with ${result.violations.length} violations\n`);
    return 0;
  }

  const { fresh, known, stale } = strict
    ? { fresh: result.violations, known: [], stale: [] }
    : splitByBaseline(root, result.violations);

  for (const note of result.notes) process.stdout.write(`# ${note}\n`);
  if (known.length > 0) {
    process.stdout.write(`# known, from tools/shape-baseline.json, and still the follow-up list: ${known.length}\n`);
    for (const key of [...new Set(known.map(baselineKey))].sort()) process.stdout.write(`# known ${key}\n`);
  }
  report(fresh);
  // A baseline entry the tree no longer has is somebody's fix, and a fix must not
  // turn the build red. It is said out loud on every run instead, so the line gets
  // taken out and the baseline shrinks.
  for (const key of stale) process.stdout.write(`# fixed, take out of tools/shape-baseline.json: ${key}\n`);
  process.stdout.write(`# ${fresh.length} violations, ${known.length} known, ${stale.length} baselined and now fixed, `
    + `${result.tree.modules.size} modules, surface ${JSON.stringify(result.surface)}\n`);
  return fresh.length === 0 ? 0 : 1;
}

export function modelFor(result, strict = false) {
  const split = strict ? { fresh: result.violations, known: [], stale: [] } : splitByBaseline(result.root, result.violations);
  return {
    root: result.root,
    kind: result.kind,
    notes: result.notes,
    surface: result.surface,
    caps: CAPS,
    rules: RULES,
    violations: split.fresh,
    known: split.known,
    stale: split.stale,
    modules: [...result.tree.modules.values()].map((m) => ({
      rel: m.rel,
      lines: m.lines,
      layer: m.layer,
      test: m.test,
      exports: m.exports.map((e) => e.name),
      functions: m.functions.length,
      imports: m.edges.filter((e) => e.to && !e.to.outside).map((e) => e.to.rel),
      external: m.imports.filter((e) => !e.from.startsWith('.')).map((e) => e.from)
    })),
    fan: [...result.graph.values()].map((n) => ({ rel: n.rel, in: n.from.size, out: n.to.size }))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main(process.argv);
}
