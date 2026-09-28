// Argument parsing from a declared schema. Every argument is explicit and no
// default guesses: a schema property carrying `default` is a decision the model
// never saw and cannot vary, so this refuses the schema itself, not the call.
//
// The schema is the small subset a tool needs and an MCP client understands:
// {type: "object", properties: {<name>: {type, enum?, items?, description}},
//  required: [...], additionalProperties: false}.

import { fault, refuseAll } from './fault.ts';

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

// Untrusted JSON Schema fields this module reads by name. Not a passed-validation type.
type SchemaObject = {
  type?: unknown;
  additionalProperties?: unknown;
  properties?: unknown;
  required?: unknown;
};
type SchemaProperty = {
  default?: unknown;
  type?: unknown;
  description?: unknown;
  enum?: unknown;
};

// Checked once, when the server loads. A bad schema is the author's fault and is
// found before any caller sees the tool.
export function checkSchema(schema: unknown, at = 'arguments') {
  const faults = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    faults.push(fault('SCHEMA_NOT_AN_OBJECT', at,
      'an argument schema is a JSON Schema object',
      'write {"type": "object", "properties": {...}, "required": [...], "additionalProperties": false}'));
    return faults;
  }
  // The object guard above permits field reads; the checks below inspect each schema field.
  const rec = schema as SchemaObject;
  if (rec.type !== 'object') {
    faults.push(fault('SCHEMA_NOT_AN_OBJECT_TYPE', `${at}.type`,
      'the top level of a tool argument schema is an object',
      'set "type": "object"'));
  }
  if (rec.additionalProperties !== false) {
    faults.push(fault('SCHEMA_ACCEPTS_UNDECLARED_ARGUMENTS', `${at}.additionalProperties`,
      'an argument nobody declared is an argument nobody checked',
      'set "additionalProperties": false'));
  }
  // The schema is checked above as an object; a malformed properties value retains the original Object.entries behavior.
  const properties = rec.properties && typeof rec.properties === 'object' ? rec.properties as Record<string, unknown> : {};
  for (const [name, property] of Object.entries(properties)) {
    const where = `${at}.properties.${name}`;
    if (!property || typeof property !== 'object') {
      faults.push(fault('SCHEMA_PROPERTY_NOT_AN_OBJECT', where,
        'each property is an object naming at least a type and a description',
        'write {"type": "string", "description": "..."}'));
      continue;
    }
    // The preceding object check permits field reads; each property is still checked below.
    const spec = property as SchemaProperty;
    if ('default' in spec) {
      faults.push(fault('IMPLICIT_ARGUMENT', where,
        `${name} carries a default, so a caller who says nothing gets a value it never chose and cannot see`,
        'remove the default and require the argument, or split the two behaviours into two tools'));
    }
    const declared = Array.isArray(spec.type) ? spec.type : [spec.type];
    if (declared.length === 0 || !declared.every((t) => typeof t === 'string' && TYPES.has(t))) {
      faults.push(fault('SCHEMA_PROPERTY_TYPE_MISSING', `${where}.type`,
        'a property declares a JSON type, or a list of them where a value is genuinely either',
        `use one of ${[...TYPES].join(', ')}`));
    }
    if (typeof spec.description !== 'string' || spec.description.trim() === '') {
      faults.push(fault('SCHEMA_PROPERTY_UNDESCRIBED', `${where}.description`,
        'a caller reads the description to know what the value means and what shape it takes',
        'write one sentence saying what it is, with an example value'));
    }
  }
  // Only the array check permits iteration; its members remain unchecked required names.
  for (const name of Array.isArray(rec.required) ? rec.required as unknown[] : []) {
    if (!(name as PropertyKey in properties)) {
      faults.push(fault('SCHEMA_REQUIRES_UNDECLARED', `${at}.required`,
        `${name} is required and not declared in properties`,
        'declare it, or drop it from required'));
    }
  }
  return faults;
}

function typeOf(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  // Number.isInteger is typed for number; untrusted values are still classified at runtime.
  if (Number.isInteger(value as number)) return 'integer';
  return typeof value;
}

function typeOk(declared: unknown, value: unknown) {
  const wanted = Array.isArray(declared) ? declared : [declared];
  const actual = typeOf(value);
  return wanted.some((type) => {
    if (type === 'number') return actual === 'number' || actual === 'integer';
    if (type === 'integer') return actual === 'integer';
    return actual === type;
  });
}

function typeWords(declared: unknown) {
  return (Array.isArray(declared) ? declared : [declared]).join(' or ');
}

// Checked on every call. Reports every fault at once, so one correction fixes
// the call rather than revealing the next fault a round trip later.
export function parseArguments(schema: unknown, given: unknown, at = 'arguments') {
  const faults = [];
  const value = given === undefined || given === null ? {} : given;
  if (typeof value !== 'object' || Array.isArray(value)) {
    refuseAll([fault('ARGUMENTS_NOT_AN_OBJECT', at,
      'arguments are given as a JSON object of named values',
      'call the tool with {"<name>": <value>, ...}')]);
  }
  // After the object check, leftover fields stay untrusted named values.
  const rec = value as Record<string, unknown>;
  const schemaRec = schema as SchemaObject;
  const properties = schemaRec.properties && typeof schemaRec.properties === 'object' ? schemaRec.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(schemaRec.required) ? schemaRec.required as unknown[] : []);

  for (const name of Object.keys(rec)) {
    if (!(name in properties)) {
      faults.push(fault('ARGUMENT_UNDECLARED', `${at}.${name}`,
        `this tool has no argument named ${name}`,
        `pass one of ${Object.keys(properties).join(', ') || 'no arguments at all'}`));
    }
  }
  for (const name of required) {
    // Required names come from the schema array; preserve their original key coercion and property lookup.
    if (!((name as PropertyKey) in rec) || rec[name as string] === undefined) {
      const property = (properties[name as string] || {}) as SchemaProperty;
      faults.push(fault('ARGUMENT_MISSING', `${at}.${name}`,
        `${name} is required and nothing was passed; it is never guessed`,
        property.description ? `pass ${name}: ${property.description}` : `pass ${name}`));
    }
  }
  for (const [name, property] of Object.entries(properties)) {
    if (!(name in rec) || rec[name] === undefined) continue;
    const v = rec[name];
    // Each declared property is read through its existing fallback; typeOk checks its value afterward.
    const spec = (property || {}) as SchemaProperty;
    if (!typeOk(spec.type, v)) {
      faults.push(fault('ARGUMENT_WRONG_TYPE', `${at}.${name}`,
        `${name} is ${typeOf(v)} and this tool takes ${typeWords(spec.type)}`,
        `pass ${name} as ${typeWords(spec.type)}`));
      continue;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
      faults.push(fault('ARGUMENT_NOT_PERMITTED', `${at}.${name}`,
        `${JSON.stringify(v)} is not one of the values ${name} takes`,
        `pass one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}`));
    }
  }
  refuseAll(faults);

  // Only what was declared and passed. Nothing is filled in.
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(properties)) if (name in rec) out[name] = rec[name];
  return out;
}
