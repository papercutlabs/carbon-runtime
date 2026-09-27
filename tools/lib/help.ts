// `--help` rendered from the manifest, so the manual and the tool descriptions a
// harness sees are the same text. Help is the primary document: an agent reads it
// before it reads any skill, and it lists every argument's valid values and one
// example call.

// Manifest fields this renderer reads by name. The object is not a validated tool.
type HelpManifest = {
  name?: unknown;
  entry?: unknown;
  transport?: unknown;
  tools?: unknown;
};
type HelpTool = {
  name?: unknown;
  readOnlyHint?: unknown;
  writes?: unknown;
  description?: unknown;
  arguments?: unknown;
  returns?: unknown;
};
type HelpProperty = { type?: unknown; description?: unknown; enum?: unknown };
type HelpArgs = { properties?: unknown; required?: unknown };
type HelpReturns = { what?: unknown; fields?: unknown };
type HelpField = { name?: unknown; what?: unknown };

export function renderHelp(manifest: unknown, { serverUsage = [] }: { serverUsage?: string[] } = {}) {
  const rec = manifest as HelpManifest;
  const lines = [];
  lines.push(`${rec.name} — an MCP tool server for one client system`);
  lines.push('');
  lines.push('Usage:');
  if (serverUsage.length > 0) for (const line of serverUsage) lines.push(`  ${line}`);
  else lines.push(`  node ${rec.entry} --transport ${rec.transport}`);
  lines.push('');
  lines.push(`Transport: ${rec.transport === 'stdio'
    ? 'stdio, newline-delimited JSON-RPC on the pipes the harness owns'
    : 'streamable http on loopback only, started as the tools user'}.`);
  lines.push('Protocol: MCP, advertising 2025-06-18 and accepting 2024-11-05; tools/list and');
  lines.push('tools/call only; every result is text with a JSON copy beside it; readOnlyHint is');
  lines.push('the only annotation.');
  lines.push('');
  lines.push('Tools:');
  // Caller contract: for-of is the original walk. tools is not checked to be an
  // array; a missing or non-iterable value still throws here.
  for (const tool of rec.tools as Iterable<HelpTool>) {
    lines.push('');
    lines.push(`  ${tool.name}${tool.readOnlyHint ? '  (read only)' : ''}${tool.writes ? '  (writes; needs the declaration write gate)' : ''}`);
    for (const line of wrap(tool.description, 74)) lines.push(`    ${line}`);
    // arguments is read by name when present; the && below is the original empty path.
    const toolArgs = tool.arguments as HelpArgs | undefined;
    const properties = (toolArgs && toolArgs.properties) || {};
    const required = new Set(((toolArgs && toolArgs.required) || []) as Iterable<unknown>);
    if (Object.keys(properties as object).length === 0) {
      lines.push('    Arguments: none.');
    } else {
      lines.push('    Arguments (every one explicit, none defaulted):');
      for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
        const spec = (property || {}) as HelpProperty;
        const type = Array.isArray(spec.type) ? spec.type.join(' or ') : spec.type;
        lines.push(`      ${name} (${type}${required.has(name) ? ', required' : ', optional'})`);
        for (const line of wrap(spec.description || '', 68)) lines.push(`        ${line}`);
        if (Array.isArray(spec.enum)) {
          lines.push(`        one of: ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}`);
        }
      }
    }
    // returns is the original property walk; a missing returns still throws on .what / .fields.
    const returns = tool.returns as HelpReturns;
    lines.push(`    Returns: ${returns.what}`);
    for (const field of returns.fields as Iterable<HelpField>) lines.push(`      ${field.name} — ${field.what}`);
    lines.push(`    Example: ${JSON.stringify({ name: tool.name, arguments: exampleArguments(tool) })}`);
  }
  lines.push('');
  lines.push('Every refusal names the code, the subject, the problem and the fix, and one call');
  lines.push('reports every fault it can already see.');
  return lines.join('\n');
}

function exampleArguments(tool: HelpTool) {
  const toolArgs = tool.arguments as HelpArgs | undefined;
  const properties = (toolArgs && toolArgs.properties) || {};
  const required = (toolArgs && toolArgs.required) || Object.keys(properties as object);
  const out: Record<string, unknown> = {};
  // required is whatever the || produced; for-of is the original walk, not an array check.
  for (const name of required as Iterable<unknown>) {
    // name indexes the properties object as the original renderer did; it is not proven a string.
    const property = ((properties as Record<string, unknown>)[name as string] || {}) as HelpProperty;
    if (Array.isArray(property.enum)) out[name as string] = property.enum[0];
    else if (property.type === 'number' || property.type === 'integer') out[name as string] = 1;
    else if (property.type === 'boolean') out[name as string] = false;
    else if (property.type === 'array') out[name as string] = [];
    else if (property.type === 'object') out[name as string] = {};
    else out[name as string] = `<${name}>`;
  }
  return out;
}

function wrap(text: unknown, width: number) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line !== '') lines.push(line);
  return lines;
}
