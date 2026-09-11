// `--help` rendered from the manifest, so the manual and the tool descriptions a
// harness sees are the same text. Help is the primary document: an agent reads it
// before it reads any skill, and it lists every argument's valid values and one
// example call.

export function renderHelp(manifest, { serverUsage = [] } = {}) {
  const lines = [];
  lines.push(`${manifest.name} — an MCP tool server for one client system`);
  lines.push('');
  lines.push('Usage:');
  if (serverUsage.length > 0) for (const line of serverUsage) lines.push(`  ${line}`);
  else lines.push(`  node ${manifest.entry} --transport ${manifest.transport}`);
  lines.push('');
  lines.push(`Transport: ${manifest.transport === 'stdio'
    ? 'stdio, newline-delimited JSON-RPC on the pipes the harness owns'
    : 'streamable http on loopback only, started as the tools user'}.`);
  lines.push('Protocol: MCP, advertising 2025-06-18 and accepting 2024-11-05; tools/list and');
  lines.push('tools/call only; every result is text with a JSON copy beside it; readOnlyHint is');
  lines.push('the only annotation.');
  lines.push('');
  lines.push('Tools:');
  for (const tool of manifest.tools) {
    lines.push('');
    lines.push(`  ${tool.name}${tool.readOnlyHint ? '  (read only)' : ''}${tool.writes ? '  (writes; needs the declaration write gate)' : ''}`);
    for (const line of wrap(tool.description, 74)) lines.push(`    ${line}`);
    const properties = (tool.arguments && tool.arguments.properties) || {};
    const required = new Set((tool.arguments && tool.arguments.required) || []);
    if (Object.keys(properties).length === 0) {
      lines.push('    Arguments: none.');
    } else {
      lines.push('    Arguments (every one explicit, none defaulted):');
      for (const [name, property] of Object.entries(properties)) {
        const type = Array.isArray(property.type) ? property.type.join(' or ') : property.type;
        lines.push(`      ${name} (${type}${required.has(name) ? ', required' : ', optional'})`);
        for (const line of wrap(property.description || '', 68)) lines.push(`        ${line}`);
        if (Array.isArray(property.enum)) {
          lines.push(`        one of: ${property.enum.map((v) => JSON.stringify(v)).join(', ')}`);
        }
      }
    }
    lines.push(`    Returns: ${tool.returns.what}`);
    for (const field of tool.returns.fields) lines.push(`      ${field.name} — ${field.what}`);
    lines.push(`    Example: ${JSON.stringify({ name: tool.name, arguments: exampleArguments(tool) })}`);
  }
  lines.push('');
  lines.push('Every refusal names the code, the subject, the problem and the fix, and one call');
  lines.push('reports every fault it can already see.');
  return lines.join('\n');
}

function exampleArguments(tool) {
  const properties = (tool.arguments && tool.arguments.properties) || {};
  const required = (tool.arguments && tool.arguments.required) || Object.keys(properties);
  const out = {};
  for (const name of required) {
    const property = properties[name] || {};
    if (Array.isArray(property.enum)) out[name] = property.enum[0];
    else if (property.type === 'number' || property.type === 'integer') out[name] = 1;
    else if (property.type === 'boolean') out[name] = false;
    else if (property.type === 'array') out[name] = [];
    else if (property.type === 'object') out[name] = {};
    else out[name] = `<${name}>`;
  }
  return out;
}

function wrap(text, width) {
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
