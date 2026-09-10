// A validator for the subset of JSON Schema draft 2020-12 that carbon's own
// schemas use, so carbon-core keeps its no-dependency rule. Supported keywords:
// type, const, enum, pattern, minLength, minimum, required, properties,
// additionalProperties (false or a schema), items, description ($schema, $id and
// title are metadata and ignored). Anything else in a schema file is a bug in the
// schema, not in the document, and this validator says so.

import { fault } from './faults.mjs';

const KNOWN = new Set([
  '$schema', '$id', 'title', 'description',
  'type', 'const', 'enum', 'pattern', 'minLength', 'minimum',
  'required', 'properties', 'additionalProperties', 'items'
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, want) {
  const got = typeOf(value);
  if (want === 'number') return got === 'integer' || got === 'number';
  if (want === 'object') return got === 'object';
  return got === want;
}

// Returns a list of faults. `subject` is a JSON-pointer-ish path used as the
// fault's subject so the caller can find the field.
export function validate(schema, value, subject = '$', schemaName = 'schema') {
  const faults = [];

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) {
      faults.push(fault('SCHEMA_KEYWORD_UNSUPPORTED', subject,
        `${schemaName} uses the JSON Schema keyword "${key}", which carbon's validator does not implement`,
        'either express the rule with a supported keyword or add the keyword to lib/validate.mjs'));
    }
  }

  if ('const' in schema && value !== schema.const) {
    faults.push(fault('VALUE_NOT_CONST', subject,
      `expected ${JSON.stringify(schema.const)}, found ${JSON.stringify(value)}`,
      `set ${subject} to ${JSON.stringify(schema.const)}`));
    return faults;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    faults.push(fault('VALUE_NOT_IN_ENUM', subject,
      `${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      `set ${subject} to one of ${schema.enum.join(', ')}`));
    return faults;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    faults.push(fault('TYPE_WRONG', subject,
      `expected ${schema.type}, found ${typeOf(value)}`,
      `make ${subject} a ${schema.type}`));
    return faults;
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      faults.push(fault('PATTERN_UNMATCHED', subject,
        `${JSON.stringify(value)} does not match ${schema.pattern}`,
        `write ${subject} in the form ${schema.pattern}`));
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      faults.push(fault('STRING_TOO_SHORT', subject,
        `needs at least ${schema.minLength} characters`,
        `give ${subject} a value`));
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    faults.push(fault('BELOW_MINIMUM', subject,
      `${value} is below the minimum ${schema.minimum}`,
      `raise ${subject} to at least ${schema.minimum}`));
  }

  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => {
      faults.push(...validate(schema.items, item, `${subject}[${i}]`, schemaName));
    });
  }

  if (typeOf(value) === 'object') {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!(name in value)) {
        faults.push(fault('FIELD_MISSING', `${subject}.${name}`,
          'the schema requires this field and it is absent',
          `add ${name} to ${subject}`));
      }
    }
    for (const [name, child] of Object.entries(value)) {
      if (name in properties) {
        faults.push(...validate(properties[name], child, `${subject}.${name}`, schemaName));
      } else if (schema.additionalProperties === false) {
        faults.push(fault('FIELD_UNKNOWN', `${subject}.${name}`,
          'the schema declares exact keys and does not name this one',
          `remove ${name}, or add it to ${schemaName} if it belongs`));
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        faults.push(...validate(schema.additionalProperties, child, `${subject}.${name}`, schemaName));
      }
    }
  }

  return faults;
}
