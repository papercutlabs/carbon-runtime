// A MIME reader, ours, for exactly three things: the headers, the first text
// part, and the attachments. It is not a general MIME library and does not try
// to be one. A mail server hands us bytes a stranger composed, so the reader is
// written to say "I cannot read this" loudly rather than to guess: an unknown
// content transfer encoding throws MimeUnreadable, and the adapter parks the
// message where it landed instead of delivering half of it.
//
// What it reads:
//
//   headers      unfolded per RFC 5322 section 2.2.3, and any RFC 2047 encoded
//                word decoded, including two adjacent encoded words, where the
//                whitespace between them is removed as the RFC says
//   body         the first text/plain part in document order; where there is
//                none, the first text/html part with its tags stripped
//   attachments  every part that names a filename, declares itself an
//                attachment, or is neither text nor multipart; decoded, hashed
//                and handed to the caller, and above the caller's cap handed
//                over as download_failed with its size and digest and no bytes
//
// What it does not read: message/rfc822 nesting beyond one level of walking,
// RFC 2231 parameter continuations, and signed or encrypted parts, which are
// carried as attachments like any other part.
//
// Input is an array of lines, because that is what both an IMAP fetch and a
// fixture give, and because header unfolding and boundary splitting are
// line-shaped work.

import crypto from 'node:crypto';

export class MimeUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'MimeUnreadable';
  }
}

const KNOWN_ENCODINGS = new Set(['7bit', '8bit', 'binary', 'base64', 'quoted-printable', '']);

// ---- headers --------------------------------------------------------------

export function splitHeaders(lines) {
  const at = lines.findIndex((line) => line === '' || line === '\r');
  if (at === -1) return { headerLines: lines.slice(), bodyLines: [] };
  return { headerLines: lines.slice(0, at), bodyLines: lines.slice(at + 1) };
}

// Unfold: a line beginning with a space or a tab continues the line before it.
export function unfold(headerLines) {
  const unfolded = [];
  for (const line of headerLines) {
    const text = line.replace(/\r$/, '');
    if (/^[ \t]/.test(text) && unfolded.length > 0) unfolded[unfolded.length - 1] += ' ' + text.trim();
    else unfolded.push(text);
  }
  return unfolded;
}

export function parseHeaders(headerLines) {
  const headers = [];
  for (const line of unfold(headerLines)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    headers.push({ name: name.toLowerCase(), raw, value: decodeWords(raw) });
  }
  return headers;
}

export function header(headers, name) {
  const found = headers.find((h) => h.name === name.toLowerCase());
  return found ? found.value : undefined;
}

export function headerRaw(headers, name) {
  const found = headers.find((h) => h.name === name.toLowerCase());
  return found ? found.raw : undefined;
}

export function headersAll(headers, name) {
  return headers.filter((h) => h.name === name.toLowerCase()).map((h) => h.value);
}

// ---- RFC 2047 -------------------------------------------------------------

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

export function decodeWords(value) {
  if (!value.includes('=?')) return value;
  // Whitespace that separates two encoded words is not part of the text.
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(ENCODED_WORD, (whole, charset, encoding, text) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64')
        : decodeQuotedPrintable(text.replace(/_/g, ' '), true);
      return decodeText(bytes, charset);
    } catch {
      return whole;
    }
  });
}

// ---- content transfer encodings -------------------------------------------

export function decodeQuotedPrintable(text, single = false) {
  const source = single ? text : text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '=' && /^[0-9a-fA-F]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const byte of Buffer.from(source[i], 'utf8')) bytes.push(byte);
    }
  }
  return Buffer.from(bytes);
}

export function decodeText(bytes, charset = 'utf-8') {
  const name = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function decodeBody(bodyLines, encoding, name) {
  const kind = (encoding ?? '').toLowerCase().trim();
  if (!KNOWN_ENCODINGS.has(kind)) {
    throw new MimeUnreadable(`the part ${name} declares the content transfer encoding "${encoding}", which this reader does not decode`);
  }
  const text = bodyLines.map((line) => line.replace(/\r$/, '')).join('\n');
  if (kind === 'base64') return Buffer.from(text.replace(/\s+/g, ''), 'base64');
  if (kind === 'quoted-printable') return decodeQuotedPrintable(text);
  return toBytes(text);
}

// The lines this reader is given are byte-per-character text: the transport
// decodes the wire as latin1 so no byte is lost before the charset is known. A
// caller that hands it real Unicode instead, as a fixture written in a JSON
// file does, is honoured by encoding as UTF-8.
function toBytes(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return Buffer.from(text, 'utf8');
  }
  return Buffer.from(text, 'latin1');
}

// ---- parameters -----------------------------------------------------------

// "text/plain; charset=UTF-8; name=\"a file.txt\"" -> { value, params }
export function parseParameters(raw = '') {
  const parts = splitOnSemicolons(raw);
  const value = (parts.shift() ?? '').trim().toLowerCase();
  const params = {};
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim().toLowerCase().replace(/\*$/, '');
    let text = part.slice(equals + 1).trim();
    if (text.startsWith('"')) {
      const close = text.indexOf('"', 1);
      text = close === -1 ? text.slice(1) : text.slice(1, close);
    }
    params[name] = decodeWords(text);
  }
  return { value, params };
}

function splitOnSemicolons(raw) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (const character of raw) {
    if (character === '"') quoted = !quoted;
    if (character === ';' && !quoted) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts;
}

// ---- html ------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };

// Each removal runs until the string stops changing, not once. A single pass
// can leave behind what its own removal spliced together — "<scr<script>ipt>"
// is the classic — and while what comes out of here is the plain text of a
// record and is never rendered as HTML anywhere, a stripper that leaves half a
// tag standing is a stripper that lies about what it did. Every pass strictly
// shortens the string, so the loop ends.
function untilStable(text, pattern, replacement) {
  let before;
  do {
    before = text;
    text = text.replace(pattern, replacement);
  } while (text !== before);
  return text;
}

export function stripHtml(html) {
  let text = untilStable(html, /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = untilStable(text, /<!--[\s\S]*?-->/g, '');
  text = untilStable(text, /<\/(p|div|tr|h[1-6]|li)\s*>/gi, '\n');
  text = untilStable(text, /<br\s*\/?>/gi, '\n');
  return untilStable(text, /<[^>]+>/g, '')
    .replace(/&(#?[a-z0-9]+);/gi, (whole, name) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (/^#\d+$/.test(key)) return String.fromCodePoint(Number(key.slice(1)));
      return whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- the walk --------------------------------------------------------------

function splitMultipart(bodyLines, boundary) {
  const parts = [];
  let current = null;
  for (const line of bodyLines) {
    const text = line.replace(/\r$/, '');
    if (text === `--${boundary}`) { current = []; parts.push(current); continue; }
    if (text === `--${boundary}--`) { current = null; continue; }
    if (current !== null) current.push(line);
  }
  return parts;
}

function isAttachment(disposition, contentType, params) {
  if (disposition.value === 'attachment') return true;
  if (disposition.params.filename !== undefined || params.name !== undefined) return true;
  return !contentType.startsWith('text/') && !contentType.startsWith('multipart/');
}

function walk(lines, collected, options, depth = 0) {
  if (depth > 12) throw new MimeUnreadable('the message nests parts deeper than this reader walks');
  const { headerLines, bodyLines } = splitHeaders(lines);
  const headers = parseHeaders(headerLines);
  const contentType = parseParameters(headerRaw(headers, 'content-type') ?? 'text/plain');
  const disposition = parseParameters(headerRaw(headers, 'content-disposition') ?? '');
  const encoding = headerRaw(headers, 'content-transfer-encoding');

  if (contentType.value.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (boundary === undefined) throw new MimeUnreadable('a multipart part names no boundary');
    for (const part of splitMultipart(bodyLines, boundary)) walk(part, collected, options, depth + 1);
    return;
  }

  const filename = disposition.params.filename ?? contentType.params.name;
  if (isAttachment(disposition, contentType.value, contentType.params)) {
    const bytes = decodeBody(bodyLines, encoding, filename ?? contentType.value);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length > options.maxAttachmentBytes) {
      // The bytes arrived with the message and are on disk in the raw payload.
      // What the cap refuses is a second copy of them as a file of their own, so
      // the attachment is recorded with its true size and digest and no file.
      collected.attachments.push({
        file: `unwritten/${digest}`,
        mime: contentType.value || 'application/octet-stream',
        bytes: bytes.length,
        sha256: digest,
        download_failed: true,
        filename
      });
    } else {
      collected.attachments.push({
        bytes,
        mime: contentType.value || 'application/octet-stream',
        sha256: digest,
        filename
      });
    }
    return;
  }

  const text = decodeText(decodeBody(bodyLines, encoding, contentType.value), contentType.params.charset);
  if (contentType.value === 'text/html') collected.html.push(text);
  else collected.text.push(text);
}

// Read one message. Returns the headers, the body this adapter will carry, and
// the attachments. `maxAttachmentBytes` is the caller's cap and is required:
// nothing here guesses a limit.
export function readMessage(lines, { maxAttachmentBytes }) {
  if (typeof maxAttachmentBytes !== 'number') {
    throw new MimeUnreadable('readMessage needs maxAttachmentBytes; the reader guesses no cap');
  }
  const { headerLines } = splitHeaders(lines);
  const headers = parseHeaders(headerLines);
  const collected = { text: [], html: [], attachments: [] };
  walk(lines, collected, { maxAttachmentBytes });

  let body = '';
  let bodyKind = 'none';
  if (collected.text.length > 0) { body = collected.text[0].trim(); bodyKind = 'text/plain'; }
  else if (collected.html.length > 0) { body = stripHtml(collected.html[0]); bodyKind = 'text/html'; }

  return { headers, body, bodyKind, attachments: collected.attachments };
}
