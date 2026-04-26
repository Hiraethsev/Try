const JOB_PREFIX = 'uwu:ai-recover:job';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;

function getKvUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
}

function getKvToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
}

export function hasKvConfig() {
  return Boolean(getKvUrl() && getKvToken());
}

export function buildJobKey(jobId) {
  return `${JOB_PREFIX}:${jobId}`;
}

async function runKvCommand(args) {
  const url = getKvUrl();
  const token = getKvToken();

  if (!url || !token) {
    throw new Error('Missing KV REST environment variables.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `KV request failed with status ${response.status}.`);
  }

  if (data.error) {
    throw new Error(data.error);
  }

  return data.result;
}

export async function setJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  return runKvCommand(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
}

export async function getJson(key) {
  const result = await runKvCommand(['GET', key]);

  if (!result) {
    return null;
  }

  return JSON.parse(result);
}

export async function deleteKey(key) {
  return runKvCommand(['DEL', key]);
}
