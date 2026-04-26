import { jsonResponse } from './_lib/ai-job.mjs';
import { buildJobKey, getJson, hasKvConfig } from './_lib/kv.mjs';

function collectJobIds(request, payload) {
  if (payload && Array.isArray(payload.jobIds)) {
    return payload.jobIds;
  }

  const url = new URL(request.url);
  const singleJobId = url.searchParams.get('jobId');
  return singleJobId ? [singleJobId] : [];
}

function normalizeJobIds(jobIds) {
  return [...new Set((jobIds || []).filter((jobId) => typeof jobId === 'string' && jobId.trim()))].slice(0, 20);
}

async function loadJobs(jobIds) {
  const jobs = [];

  for (const jobId of jobIds) {
    const job = await getJson(buildJobKey(jobId));
    if (job) {
      jobs.push(job);
    }
  }

  return jobs;
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method Not Allowed.' }, 405);
  }

  if (!hasKvConfig()) {
    return jsonResponse({ ok: false, error: 'KV is not configured.' }, 500);
  }

  let payload = null;
  if (request.method === 'POST') {
    try {
      payload = await request.json();
    } catch (error) {
      payload = null;
    }
  }

  const jobIds = normalizeJobIds(collectJobIds(request, payload));
  const jobs = await loadJobs(jobIds);

  return jsonResponse({ ok: true, jobs }, 200);
}
