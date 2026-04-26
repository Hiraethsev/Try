import { buildJobKey, setJson } from './kv.mjs';

const JOB_TTL_SECONDS = 60 * 60 * 24;
const SAFE_HEADER_NAMES = new Set([
  'authorization',
  'content-type',
  'x-api-key',
  'api-key',
  'anthropic-version',
  'anthropic-beta',
  'openai-organization',
  'x-goog-api-key',
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPrivateIpv4(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;

  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}

function validateEndpoint(endpoint) {
  let parsed;

  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw new Error('Invalid AI endpoint URL.');
  }

  assert(parsed.protocol === 'https:' || parsed.protocol === 'http:', 'AI endpoint must use HTTP or HTTPS.');

  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost = hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';

  assert(!isLocalhost, 'Localhost endpoints are not allowed.');
  assert(!isPrivateIpv4(hostname), 'Private network endpoints are not allowed.');

  return parsed.toString();
}

function sanitizeHeaders(rawHeaders) {
  const sanitized = {};

  if (!isPlainObject(rawHeaders)) {
    return sanitized;
  }

  Object.entries(rawHeaders).forEach(([name, value]) => {
    if (!SAFE_HEADER_NAMES.has(String(name).toLowerCase())) {
      return;
    }

    if (typeof value !== 'string' || !value.trim()) {
      return;
    }

    sanitized[name] = value;
  });

  if (!sanitized['Content-Type'] && !sanitized['content-type']) {
    sanitized['Content-Type'] = 'application/json';
  }

  return sanitized;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.slice(0, 500);
}

function extractTextFromChoiceContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function extractCompletionText(provider, payload) {
  if (provider === 'gemini') {
    return (
      payload?.candidates?.[0]?.content?.parts
        ?.map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('') || ''
    );
  }

  return extractTextFromChoiceContent(payload?.choices?.[0]?.message?.content);
}

async function fetchAiCompletion(jobPayload) {
  const response = await fetch(jobPayload.endpoint, {
    method: 'POST',
    headers: sanitizeHeaders(jobPayload.headers),
    body: JSON.stringify(jobPayload.requestBody),
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`Upstream AI error ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  const data = await response.json().catch(() => null);
  assert(data, 'Upstream AI did not return valid JSON.');

  return extractCompletionText(jobPayload.provider, data);
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

export function normalizeChatJobPayload(input) {
  assert(isPlainObject(input), 'Invalid request body.');
  assert(typeof input.jobId === 'string' && input.jobId.trim(), 'Missing jobId.');
  assert(typeof input.chatId === 'string' && input.chatId.trim(), 'Missing chatId.');
  assert((input.chatType === 'private' || input.chatType === 'group'), 'Invalid chatType.');
  assert(typeof input.provider === 'string' && input.provider.trim(), 'Missing provider.');
  assert(isPlainObject(input.requestBody), 'Missing requestBody.');

  return {
    jobId: input.jobId.trim(),
    chatId: input.chatId.trim(),
    chatType: input.chatType,
    provider: input.provider.trim(),
    endpoint: validateEndpoint(String(input.endpoint || '')),
    headers: sanitizeHeaders(input.headers),
    requestBody: input.requestBody,
    createdAt: new Date().toISOString(),
  };
}

export async function markJobPending(jobPayload) {
  const pendingRecord = {
    status: 'pending',
    jobId: jobPayload.jobId,
    chatId: jobPayload.chatId,
    chatType: jobPayload.chatType,
    createdAt: jobPayload.createdAt,
  };

  await setJson(buildJobKey(jobPayload.jobId), pendingRecord, JOB_TTL_SECONDS);
  return pendingRecord;
}

export async function processChatJob(jobPayload) {
  try {
    const fullResponse = await fetchAiCompletion(jobPayload);
    const completedRecord = {
      status: 'completed',
      jobId: jobPayload.jobId,
      chatId: jobPayload.chatId,
      chatType: jobPayload.chatType,
      fullResponse,
      createdAt: jobPayload.createdAt,
      completedAt: new Date().toISOString(),
    };

    await setJson(buildJobKey(jobPayload.jobId), completedRecord, JOB_TTL_SECONDS);
    return completedRecord;
  } catch (error) {
    const failedRecord = {
      status: 'failed',
      jobId: jobPayload.jobId,
      chatId: jobPayload.chatId,
      chatType: jobPayload.chatType,
      error: safeErrorMessage(error),
      createdAt: jobPayload.createdAt,
      completedAt: new Date().toISOString(),
    };

    await setJson(buildJobKey(jobPayload.jobId), failedRecord, JOB_TTL_SECONDS);
    return failedRecord;
  }
}
