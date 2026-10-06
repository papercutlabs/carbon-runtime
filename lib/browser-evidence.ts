export type EvidenceSelector = { kind: 'lines'; start: number; end: number } | { kind: 'rows'; start: number; end: number }
 | { kind: 'field'; pointer: string } | { kind: 'region'; x: number; y: number; width: number; height: number };
export type EvidenceReference = { itemId:string; sourceId:string; representationId:string; representationVersion:string; sha256:string; selector:EvidenceSelector|null };
