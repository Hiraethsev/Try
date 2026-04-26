import { jsonResponse } from './_lib/ai-job.mjs';
import { buildJobKey, deleteKey, hasKvConfig } from './_lib/kv.mjs';

function normalizeJobIds(jobIds) {
  return [...new Set((jobIds || []).filter((jobId) => typeof jobId === 'string' && jobId.trim()))].slice(0, 20);
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method Not Allowed.' }, 405);
  }

  if (!hasKvConfig()) {
    return jsonResponse({ ok: false, error: 'KV is not configured.' }, 500);
  }

  let payload;

  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const jobIds = normalizeJobIds(payload?.jobIds);

  for (const jobId of jobIds) {
    await deleteKey(buildJobKey(jobId));
  }

  return jsonResponse({ ok: true, deletedJobIds: jobIds }, 200);
}
