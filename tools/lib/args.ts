// Argument parsing from a declared schema. Every argument is explicit and no
// default guesses: a schema property carrying `default` is a decision the model
// never saw and cannot vary, so this refuses the schema itself, not the call.
//
// The schema is the small subset a tool needs and an MCP client understands:
// {type: "object", properties: {<name>: {type, enum?, items?, description}},
//  required: [...], additionalProperties: false}.

import { fault, refuseAll } from './fault.ts';

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
type Property = { type?: unknown; description?: unknown; enum?: unknown; [key: string]: unknown };

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
  const spec = schema as Record<string, unknown>; // The object guard proves keyed access, not a valid schema.
  if (spec.type !== 'object') {
    faults.push(fault('SCHEMA_NOT_AN_OBJECT_TYPE', `${at}.type`,
      'the top level of a tool argument schema is an object',
      'set "type": "object"'));
  }
  if (spec.additionalProperties !== false) {
    faults.push(fault('SCHEMA_ACCEPTS_UNDECLARED_ARGUMENTS', `${at}.additionalProperties`,
      'an argument nobody declared is an argument nobody checked',
      'set "additionalProperties": false'));
  }
  const properties = spec.properties && typeof spec.properties === 'object' ? spec.properties : {};
  for (const [name, property] of Object.entries(properties)) {
    const where = `${at}.properties.${name}`;
    if (!property || typeof property !== 'object') {
      faults.push(fault('SCHEMA_PROPERTY_NOT_AN_OBJECT', where,
        'each property is an object naming at least a type and a description',
        'write {"type": "string", "description": "..."}'));
      continue;
    }
    const field = property as Property; // The preceding object guard proves only property access.
    if ('default' in field) {
      faults.push(fault('IMPLICIT_ARGUMENT', where,
        `${name} carries a default, so a caller who says nothing gets a value it never chose and cannot see`,
        'remove the default and require the argument, or split the two behaviours into two tools'));
    }
    const declared = Array.isArray(field.type) ? field.type : [field.type];
    if (declared.length === 0 || !declared.every((t) => typeof t === 'string' && TYPES.has(t))) {
      faults.push(fault('SCHEMA_PROPERTY_TYPE_MISSING', `${where}.type`,
        'a property declares a JSON type, or a list of them where a value is genuinely either',
        `use one of ${[...TYPES].join(', ')}`));
    }
    if (typeof field.description !== 'string' || field.description.trim() === '') {
      faults.push(fault('SCHEMA_PROPERTY_UNDESCRIBED', `${where}.description`,
        'a caller reads the description to know what the value means and what shape it takes',
        'write one sentence saying what it is, with an example value'));
    }
  }
  for (const name of Array.isArray(spec.required) ? spec.required : []) {
    if (!(name in properties)) {
      faults.push(fault('SCHEMA_REQUIRES_UNDECLARED', `${at}.required`,
        `${name} is required and not declared in properties`,
        'declare it, or drop it from required'));
    }
  }
  return faults;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeOk(declared: unknown, value: unknown): boolean {
  const wanted = Array.isArray(declared) ? declared : [declared];
  const actual = typeOf(value);
  return wanted.some((type) => {
    if (type === 'number') return actual === 'number' || actual === 'integer';
    if (type === 'integer') return actual === 'integer';
    return actual === type;
  });
}

function typeWords(declared: unknown): string {
  return (Array.isArray(declared) ? declared : [declared]).join(' or ');
}

// Checked on every call. Reports every fault at once, so one correction fixes
// the call rather than revealing the next fault a round trip later.
export function parseArguments(schema: unknown, given: unknown, at = 'arguments'): Record<string, unknown> {
  const faults = [];
  // Existing callers check schemas before calls; keeping this access unchecked
  // preserves the original thrown error when they pass a malformed schema.
  const spec = schema as { properties?: unknown; required?: unknown };
  const value = given === undefined || given === null ? {} : given;
  if (typeof value !== 'object' || Array.isArray(value)) {
    refuseAll([fault('ARGUMENTS_NOT_AN_OBJECT', at,
      'arguments are given as a JSON object of named values',
      'call the tool with {"<name>": <value>, ...}')]);
  }
  const values = value as Record<string, unknown>; // The preceding guard proves a keyed object.
  const properties = spec.properties && typeof spec.properties === 'object' ? spec.properties as Record<string, Property> : {}; // Checked schemas supply property objects; preserve unchecked reads for direct callers.
  // Schema validation precedes calls; required names are used as keys unchanged.
  const required = new Set(Array.isArray(spec.required) ? spec.required as string[] : []);

  for (const name of Object.keys(values)) {
    if (!(name in properties)) {
      faults.push(fault('ARGUMENT_UNDECLARED', `${at}.${name}`,
        `this tool has no argument named ${name}`,
        `pass one of ${Object.keys(properties).join(', ') || 'no arguments at all'}`));
    }
  }
  for (const name of required) {
    if (!(name in values) || values[name] === undefined) {
      const property = properties[name] || {};
      faults.push(fault('ARGUMENT_MISSING', `${at}.${name}`,
        `${name} is required and nothing was passed; it is never guessed`,
        property.description ? `pass ${name}: ${property.description}` : `pass ${name}`));
    }
  }
  for (const [name, property] of Object.entries(properties)) {
    if (!(name in values) || values[name] === undefined) continue;
    const v = values[name];
    if (!typeOk(property.type, v)) {
      faults.push(fault('ARGUMENT_WRONG_TYPE', `${at}.${name}`,
        `${name} is ${typeOf(v)} and this tool takes ${typeWords(property.type)}`,
        `pass ${name} as ${typeWords(property.type)}`));
      continue;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(v)) {
      faults.push(fault('ARGUMENT_NOT_PERMITTED', `${at}.${name}`,
        `${JSON.stringify(v)} is not one of the values ${name} takes`,
        `pass one of ${property.enum.map((e) => JSON.stringify(e)).join(', ')}`));
    }
  }
  refuseAll(faults);

  // Only what was declared and passed. Nothing is filled in.
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(properties)) if (name in values) out[name] = values[name];
  return out;
}
