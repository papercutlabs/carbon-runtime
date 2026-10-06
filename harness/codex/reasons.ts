// Preserve the external reporter's wording at capture, with credential values
// removed before they enter the supported account/turn record.
export function redactNativeReason(reason: unknown, credentialValues: readonly string[] = []) {
  let text: string | null = typeof reason === 'string' ? reason
    : reason instanceof Error ? reason.message
    : reason && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string' ? reason.message : null;
  if (text === null) return null;
  for (const value of credentialValues.filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) text = text.split(value).join('[REDACTED]');
  text = text.replace(/(\bBearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|credential)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return text.slice(0, 8192);
}

export function nativeFailureEvidence(reason: unknown, credentialValues: readonly string[] = []) {
  const value = reason as { rpcError?: unknown; native_code?: unknown; code?: unknown } | null;
  const reporter = value && typeof value === 'object' && value.rpcError ? value.rpcError : reason;
  const code = reporter && typeof reporter === 'object' && 'code' in reporter ? reporter.code : value?.native_code ?? value?.code;
  const original = redactNativeReason(reporter, credentialValues);
  return { original_reason: original, original_reason_available: original !== null,
    native_code: typeof code === 'number' ? code : typeof code === 'string' ? redactNativeReason(code, credentialValues) : null };
}
