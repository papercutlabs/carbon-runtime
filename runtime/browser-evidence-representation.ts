import crypto from 'node:crypto';
import { RuntimeFault, fault } from './faults.ts';
export const REPRESENTATION_VERSION = 'carbon.evidence.v1';
import type { EvidenceSelector } from '../lib/browser-evidence.ts';
export type { EvidenceSelector } from '../lib/browser-evidence.ts';
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type EvidenceRepresentation = { id: string; version: string; kind: 'text' | 'json' | 'table' | 'image' | 'file'; sha256: string;
 lines?: string[]; fields?: JsonValue; rows?: string[][]; columns?: string[]; width?: number; height?: number; limitation: string | null };
const hash = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
function refuse(subject: string, problem: string): never { throw new RuntimeFault(fault('EVIDENCE_SELECTOR_INVALID', subject, problem,
 'read the supported representation and choose a selector within its reported bounds, or open the immutable original')); }
function toggleQuote(field: string, quoted: boolean) {
 if (!field || quoted) return !quoted;
 throw Error('invalid quoted field');
}
function csv(text: string) {
 const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
 for (let i = 0; i < text.length; i++) { const c = text[i];
  if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = toggleQuote(field, quoted); }
  else if (!quoted && c === ',') { row.push(field); field = ''; }
  else if (!quoted && (c === '\n' || c === '\r')) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
  else field += c;
 }
 if (quoted) throw Error('unclosed quoted field');
 if (field || row.length) { row.push(field); rows.push(row); }
 return rows;
}
function imageSize(b: Buffer, mime: string): {width:number;height:number}|null {
 if (mime === 'image/png' && b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  if (width && height) return { width, height };
 }
 return jpegSize(b,mime);
}
function jpegSize(b:Buffer,mime:string):{width:number;height:number}|null{
 if (mime === 'image/jpeg' && b[0] === 255 && b[1] === 216) {
  for (let i = 2; i + 8 < b.length;) { if (b[i] !== 255) break; const marker = b[i + 1]; if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
    const height = b.readUInt16BE(i + 5), width = b.readUInt16BE(i + 7); if (width && height) return { width, height }; break;
   } if ([216,217].includes(marker)) { i += 2; continue; } const size = b.readUInt16BE(i + 2); if (size < 2) break; i += size + 2;
  }
 }
 return null;
}
type RepresentationBase = Pick<EvidenceRepresentation,'id'|'version'|'sha256'|'limitation'>;
function decodedRepresentation(base:RepresentationBase,text:string,mime:string,filename:string):EvidenceRepresentation {
 if (text.includes('\0')) return { ...base, kind: 'file', limitation: 'Binary content has no supported safe representation; use the immutable original.' };
 if (mime.includes('json') || /\.json$/i.test(filename)) { try { return { ...base, kind: 'json', fields: JSON.parse(text) as JsonValue }; } catch { return { ...base, kind: 'file', limitation: 'The received JSON is malformed; the unchanged original remains available.' }; } }
 if (mime === 'text/csv' || /\.csv$/i.test(filename)) { try { const [columns = [], ...rows] = csv(text); return { ...base, kind: 'table', columns, rows }; } catch { return { ...base, kind: 'file', limitation: 'CSV quoting is unsupported or malformed; the unchanged original remains available.' }; } }
 if (mime.startsWith('text/') || /\.(log|txt|md)$/i.test(filename)) return { ...base, kind: 'text', lines: text.split(/\r\n|\n|\r/) };
 return { ...base, kind: 'file', limitation: 'No safe representation is selected for this media type; use the immutable original.' };
}
export function indexEvidenceRepresentation(bytes: Uint8Array, mime: string, filename: string): EvidenceRepresentation {
 const sha256 = hash(bytes), base = { id: 'representation-' + hash(REPRESENTATION_VERSION + ':' + sha256), version: REPRESENTATION_VERSION, sha256, limitation: null };
 const image=imageSize(Buffer.from(bytes),mime);if(image)return {...base,kind:'image',...image};
 // Active formats never become runnable display content. Original download remains available.
 if (/html|svg|javascript|xml/.test(mime) || /\.(html?|svg|js)$/i.test(filename)) return { ...base, kind: 'file', limitation: 'Active format is available only as an authenticated original download.' };
 let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ...base, kind: 'file', limitation: 'No safe text/image representation is supported; use the immutable original.' }; }
 return decodedRepresentation(base,text,mime,filename);
}
function pointer(value: JsonValue, path: string): JsonValue {
 if (path === '') return value;
 if (!path.startsWith('/') || /~(?![01])/u.test(path)) refuse('selector.pointer', 'expected a valid JSON pointer');
 let current: JsonValue = value;
 for (const encoded of path.slice(1).split('/')) { const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
  if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) refuse('selector.pointer', 'the retained structured source has no such field');
  current = (current as { [key: string]: JsonValue })[key];
 }
 return current;
}
function validateFragmentBounds(selector:EvidenceSelector|null,contextBefore:number,contextAfter:number,limit:number){
 if (selector !== null) {
  const keys = ({lines:['kind','start','end'],rows:['kind','start','end'],field:['kind','pointer'],region:['kind','x','y','width','height']} as Record<string,string[]>)[selector.kind];
  if (!keys || Object.keys(selector).length !== keys.length || !keys.every(k => Object.hasOwn(selector,k))) refuse('selector','selector must carry exactly the fields for its declared kind');
 }
 for (const [name, value] of Object.entries({ contextBefore, contextAfter, limit })) if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0) || value > 1000) refuse(name, 'expected an explicit bounded integer');
 }
function validRange(start:number,end:number,total:number){return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=1&&end>=start&&end<=total;}
function rangeFragment(rep:EvidenceRepresentation,selector:EvidenceSelector|null,contextBefore:number,contextAfter:number,limit:number){
  const kind = rep.kind === 'text' ? 'lines' : 'rows', values = rep.kind === 'text' ? rep.lines! : rep.rows!, total = values.length;
  const range = selector ?? { kind, start: 1, end: Math.min(total, limit) };
  if (range.kind !== kind || !('start' in range)) refuse('selector.kind', 'selector does not address this representation');
  if (!validRange(range.start,range.end,total)) {
   if (total === 0 && selector === null) return { kind: rep.kind, total: 0, start: 0, end: 0, lines: [], rows: [], columns: rep.columns ?? [], hasMore: false, nextSelector: null };
   refuse('selector', 'selected range lies outside the retained representation');
  }
  if (range.end - range.start + 1 > limit) refuse('selector', 'selected range exceeds the explicit fragment limit');
  const start = Math.max(1, range.start - contextBefore), end = Math.min(total, range.end + contextAfter, start + limit - 1);
  if (end < range.end) refuse('contextBefore', 'requested context would exclude the selected ending within the explicit limit');
  return rangeContent(rep,total,start,end,kind,limit);
}
function rangeContent(rep:EvidenceRepresentation,total:number,start:number,end:number,kind:string,limit:number){
  return { kind: rep.kind, total, start, end, lines: rep.kind === 'text' ? rep.lines!.slice(start - 1, end).map((text, i) => ({ number: start + i, text })) : [],
   rows: rep.kind === 'table' ? rep.rows!.slice(start - 1, end).map((cells, i) => ({ number: start + i, cells:[...cells] })) : [], columns: [...(rep.columns ?? [])], hasMore: end < total, nextSelector: end < total ? { kind, start: end + 1, end: Math.min(total, end + limit) } : null };
}
function jsonFragment(rep:EvidenceRepresentation,selector:EvidenceSelector|null,limit:number){
  if (selector !== null && selector.kind !== 'field') refuse('selector.kind', 'structured data supports an exact JSON pointer');
  const field = selector?.kind === 'field' ? selector.pointer : '', value = pointer(rep.fields!, field), text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > limit * 1024) refuse('selector.pointer', 'this structured field exceeds the explicit fragment byte bound; choose a narrower field');
  return { kind: 'json', pointer: field, value:structuredClone(value), text, hasMore: false, nextSelector: null };
}
function imageFragment(rep:EvidenceRepresentation,selector:EvidenceSelector|null){
  if (selector !== null) { if (selector.kind !== 'region') refuse('selector.kind', 'image supports a region on the full original');
   if (![selector.x, selector.y, selector.width, selector.height].every(Number.isFinite) || selector.x < 0 || selector.y < 0 || selector.width <= 0 || selector.height <= 0 || selector.x + selector.width > 1 || selector.y + selector.height > 1) refuse('selector.region', 'expected normalized bounds within the full original image'); }
  return { kind: 'image', width: rep.width!, height: rep.height!, region: selector, hasMore: false, nextSelector: null };
}
// Preserve the original inferred optional-key union across the extracted readers.
type UnionKeys<T> = T extends unknown ? keyof T : never;
type WithAbsentKeys<T,All=T> = T extends unknown ? T & { [K in Exclude<UnionKeys<All>,keyof T>]?:never } : never;
type EvidenceFragment = WithAbsentKeys<ReturnType<typeof rangeFragment>|ReturnType<typeof jsonFragment>|ReturnType<typeof imageFragment>|{kind:'file';limitation:string|null;hasMore:boolean;nextSelector:null}>;
export function resolveEvidenceFragment(rep: EvidenceRepresentation, selector: EvidenceSelector | null, contextBefore: number, contextAfter: number, limit: number): EvidenceFragment {
 validateFragmentBounds(selector,contextBefore,contextAfter,limit);
 if(rep.kind==='text'||rep.kind==='table')return rangeFragment(rep,selector,contextBefore,contextAfter,limit);
 if(rep.kind==='json')return jsonFragment(rep,selector,limit);
 if(rep.kind==='image')return imageFragment(rep,selector);
 if (selector !== null) refuse('selector', 'this file has no supported addressable representation');
 return { kind: 'file', limitation: rep.limitation, hasMore: false, nextSelector: null };
}
