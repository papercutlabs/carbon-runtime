import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateSop, type Sop } from './sop-definition.ts';

export type Migration = { number: number; name: string; file: string; sha256: string; sql: string };
export type SopFile = { sop: string; file: string; sha256: string; definition: Sop };
export type CheckedRecords = { migrations: Migration[]; sops: SopFile[]; tables: string[] };
export type CheckResult = { faults: string[]; records: CheckedRecords | null };
const SOP_NAME = /^[a-z][a-z0-9_-]*$/;

// Erase comments and quoted bodies while retaining the punctuation that divides
// top-level statements. On-box catalog checks and the DROP event trigger also
// inspect what a DO body actually did before its transaction can commit.
export function sqlSkeleton(source: string): string {
  let output = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '-' && next === '-') {
      while (i < source.length && source[i] !== '\n') { output += ' '; i++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1; output += '  '; i += 2;
      while (i < source.length && depth > 0) {
        if (source.slice(i, i + 2) === '/*') { depth++; output += '  '; i += 2; }
        else if (source.slice(i, i + 2) === '*/') { depth--; output += '  '; i += 2; }
        else { output += source[i] === '\n' ? '\n' : ' '; i++; }
      }
      if (depth !== 0) throw new Error('unterminated SQL block comment');
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch; const start = i; output += ' '; i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) { output += '  '; i += 2; continue; }
          output += ' '; i++; closed = true; break;
        }
        output += source[i] === '\n' ? '\n' : ' '; i++;
      }
      if (!closed) throw new Error('unterminated SQL quote');
      if (quote === '"') {
        const identifier = source.slice(start + 1, i - 1);
        if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error('quoted SQL identifier must be a simple lower-case name');
        output = output.slice(0, -(i - start)) + identifier;
      }
      continue;
    }
    if (ch === '$') {
      const tag = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const close = source.indexOf(tag, i + tag.length);
        if (close < 0) throw new Error('unterminated SQL dollar quote');
        const body = source.slice(i, close + tag.length);
        output += body.replace(/[^\n]/g, ' ');
        i = close + tag.length;
        continue;
      }
    }
    output += ch; i++;
  }
  return output;
}

function regularNames(dir: string, faults: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile()) faults.push(`${dir}/${entry.name}: records entries must be regular files`);
    return entry.name;
  }).sort();
}

export function checkRecords(repo: string): CheckResult {
  const faults: string[] = [];
  const root = path.join(repo, 'records');
  const readmePath = path.join(root, 'README.md');
  const readme = fs.existsSync(readmePath) && fs.statSync(readmePath).isFile()
    ? fs.readFileSync(readmePath, 'utf8') : '';
  if (!readme.trim()) faults.push('records/README.md must describe every table and its reader and writer');
  const migrations: Migration[] = [];
  const sops: SopFile[] = [];
  const tables = new Set<string>();
  const numbers = new Set<number>();
  for (const name of regularNames(path.join(root, 'migrations'), faults)) {
    const match = /^(\d{4})-([a-z][a-z0-9_-]*)\.sql$/.exec(name);
    if (!match) { faults.push(`records/migrations/${name}: expected NNNN-name.sql`); continue; }
    const number = Number(match[1]);
    if (numbers.has(number)) faults.push(`records/migrations/${name}: duplicate migration number ${match[1]}`);
    numbers.add(number);
    const file = path.join(root, 'migrations', name);
    if (!fs.statSync(file).isFile()) continue;
    const sql = fs.readFileSync(file, 'utf8');
    const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
    migrations.push({ number, name, file, sha256, sql });
    try {
      const skeleton = sqlSkeleton(sql);
      if (/(^|;)\s*(drop|truncate|delete)\b/im.test(skeleton)
        || /\balter\s+table\b[^;]*\bdrop\b/im.test(skeleton)) {
        faults.push(`records/migrations/${name}: DROP, TRUNCATE and DELETE are forbidden; see agent-records-principles.md`);
      }
      if (/\bcarbon\s*\./i.test(sql) || /\b(?:create|alter|drop)\s+schema\s+carbon\b/i.test(skeleton)) {
        faults.push(`records/migrations/${name}: carbon schema is reserved`);
      }
      if (/(^|;)\s*(begin|commit|rollback|savepoint|release)\b/im.test(skeleton)) {
        faults.push(`records/migrations/${name}: transaction control belongs to Carbon's install step`);
      }
      if (/\b(?:enable|force)\s+row\s+level\s+security\b/i.test(skeleton)
        || /\bcreate\s+policy\b/i.test(skeleton)) {
        faults.push(`records/migrations/${name}: row-level security prevents a complete backup read`);
      }
      const pattern = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:(?:public)\s*\.\s*)?([a-z][a-z0-9_]*)\b/gi;
      for (const created of skeleton.matchAll(pattern)) tables.add(created[1].toLowerCase());
    } catch (error) {
      faults.push(`records/migrations/${name}: ${(error as Error).message}`);
    }
  }
  const sopDir = path.join(root, 'sops');
  if (!fs.existsSync(sopDir)) faults.push('records/sops/ is required when records are enabled');
  for (const name of regularNames(sopDir, faults)) {
    const match = /^([a-z][a-z0-9_-]*)\.json$/.exec(name);
    if (!match || !SOP_NAME.test(match[1])) { faults.push(`records/sops/${name}: expected <sop>.json`); continue; }
    const file = path.join(sopDir, name);
    if (!fs.statSync(file).isFile()) continue;
    const bytes = fs.readFileSync(file, 'utf8');
    let definition: unknown;
    try { definition = JSON.parse(bytes); }
    catch { faults.push(`records/sops/${name}: invalid JSON`); continue; }
    const errors = validateSop(definition, match[1]);
    for (const error of errors) faults.push(`records/sops/${name}: ${error}; see sop-method.md`);
    if (errors.length === 0) {
      sops.push({ sop: match[1], file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), definition: definition as Sop });
      const suffix = match[1].replaceAll('-', '_');
      tables.add(`jobs_${suffix}`);
      tables.add(`job_events_${suffix}`);
    }
  }
  const sqlNames = new Set<string>();
  for (const definition of sops) {
    const sqlName = definition.sop.replaceAll('-', '_');
    if (sqlNames.has(sqlName)) faults.push(`records/sops/${definition.sop}.json: SQL table name collides with another SOP`);
    sqlNames.add(sqlName);
  }
  for (const table of tables) {
    if (!new RegExp(`\\b${table}\\b`, 'i').test(readme)) {
      faults.push(`records/README.md does not name table ${table}; see agent-records-principles.md`);
    }
  }
  return { faults, records: faults.length === 0
    ? { migrations: migrations.sort((a, b) => a.number - b.number), sops, tables: [...tables].sort() }
    : null };
}
