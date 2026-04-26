(function () {
    const STORAGE_KEY = 'uwu_ai_pending_jobs_v1';
    const POLL_INTERVAL_MS = 2500;
    const JOB_TTL_MS = 24 * 60 * 60 * 1000;

    let pollTimer = null;
    let recoverInFlight = false;
    const applyingJobIds = new Set();

    function readPendingJobs() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];

            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn('[AiRecovery] Failed to read pending jobs:', error);
            return [];
        }
    }

    function writePendingJobs(jobs) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(-10)));
        } catch (error) {
            console.warn('[AiRecovery] Failed to persist pending jobs:', error);
        }
    }

    function cleanupExpiredJobs() {
        const now = Date.now();
        const nextJobs = readPendingJobs().filter(job => {
            const createdAt = Number(job && job.createdAt);
            return Number.isFinite(createdAt) && now - createdAt < JOB_TTL_MS;
        });

        writePendingJobs(nextJobs);
        return nextJobs;
    }

    function upsertPendingJob(job) {
        const nextJobs = cleanupExpiredJobs().filter(item => item.jobId !== job.jobId);
        nextJobs.push(job);
        writePendingJobs(nextJobs);
        return nextJobs;
    }

    function removePendingJob(jobId) {
        const nextJobs = cleanupExpiredJobs().filter(job => job.jobId !== jobId);
        writePendingJobs(nextJobs);
        return nextJobs;
    }

    function getPendingJob(jobId) {
        return cleanupExpiredJobs().find(job => job.jobId === jobId) || null;
    }

    function hasPendingJobs() {
        return cleanupExpiredJobs().length > 0;
    }

    function createJobId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    async function postJson(url, payload) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            },
            body: JSON.stringify(payload)
        });

        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            throw new Error((data && data.error) || `Request failed with status ${response.status}.`);
        }

        return data || {};
    }

    function finishUiIfIdle() {
        if (hasPendingJobs()) return;

        if (typeof isGenerating !== 'undefined') {
            isGenerating = false;
        }

        if (typeof getReplyBtn !== 'undefined' && getReplyBtn) {
            getReplyBtn.disabled = false;
        }

        if (typeof regenerateBtn !== 'undefined' && regenerateBtn) {
            regenerateBtn.disabled = false;
        }

        if (typeof typingIndicator !== 'undefined' && typingIndicator) {
            typingIndicator.style.display = 'none';
        }
    }

    function syncPolling() {
        const shouldPoll = !document.hidden && hasPendingJobs();

        if (!shouldPoll) {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            return;
        }

        if (!pollTimer) {
            pollTimer = setInterval(() => {
                window.AiRecovery.recoverPendingJobs({ reason: 'poll' });
            }, POLL_INTERVAL_MS);
        }
    }

    function normalizeRecoveredResponse(fullResponse) {
        let normalized = typeof fullResponse === 'string' ? fullResponse : '';
        const cotEnabled = db && db.cotSettings && db.cotSettings.enabled;

        if (
            cotEnabled &&
            normalized &&
            !normalized.trim().startsWith('<thinking>') &&
            normalized.includes('</thinking>')
        ) {
            normalized = '<thinking>' + normalized;
        }

        return normalized;
    }

    async function ackRecoveredJobs(jobIds) {
        if (!jobIds || jobIds.length === 0) return;

        try {
            await postJson('/api/recover-ack', { jobIds });
        } catch (error) {
            console.warn('[AiRecovery] Failed to ack recovered jobs:', error);
        }
    }

    async function applyRecoveredJob(jobRecord) {
        const pendingJob = getPendingJob(jobRecord.jobId);
        if (!pendingJob || applyingJobIds.has(jobRecord.jobId)) return;

        if (typeof handleAiReplyContent !== 'function') return;

        applyingJobIds.add(jobRecord.jobId);

        try {
            const chat = pendingJob.chatType === 'private'
                ? db.characters.find(c => c.id === pendingJob.chatId)
                : db.groups.find(g => g.id === pendingJob.chatId);

            if (!chat) {
                syncPolling();
                return;
            }

            if (jobRecord.status === 'failed') {
                removePendingJob(jobRecord.jobId);
                finishUiIfIdle();
                syncPolling();
                if (typeof showToast === 'function') {
                    showToast(jobRecord.error || '云端恢复失败');
                }
                await ackRecoveredJobs([jobRecord.jobId]);
                return;
            }

            const normalizedResponse = normalizeRecoveredResponse(jobRecord.fullResponse);

            if (!normalizedResponse) {
                removePendingJob(jobRecord.jobId);
                finishUiIfIdle();
                syncPolling();
                if (typeof showToast === 'function') {
                    showToast('AI 返回为空');
                }
                await ackRecoveredJobs([jobRecord.jobId]);
                return;
            }

            await handleAiReplyContent(
                normalizedResponse,
                chat,
                pendingJob.chatId,
                pendingJob.chatType,
                true
            );

            removePendingJob(jobRecord.jobId);
            finishUiIfIdle();
            syncPolling();
            await ackRecoveredJobs([jobRecord.jobId]);
        } catch (error) {
            console.error('[AiRecovery] Failed to apply recovered job:', error);
        } finally {
            applyingJobIds.delete(jobRecord.jobId);
        }
    }

    async function recoverPendingJobs(options = {}) {
        const pendingJobs = cleanupExpiredJobs();
        if (pendingJobs.length === 0 || recoverInFlight) {
            syncPolling();
            return;
        }

        recoverInFlight = true;

        try {
            const data = await postJson('/api/recover', {
                jobIds: pendingJobs.map(job => job.jobId),
                reason: options.reason || 'manual'
            });

            const recoveredJobs = Array.isArray(data.jobs) ? data.jobs : [];

            for (const jobRecord of recoveredJobs) {
                if (jobRecord.status === 'completed' || jobRecord.status === 'failed') {
                    await applyRecoveredJob(jobRecord);
                }
            }
        } catch (error) {
            console.warn('[AiRecovery] Recover request failed:', error);
        } finally {
            recoverInFlight = false;
            syncPolling();
        }
    }

    async function startCloudReply(requestConfig) {
        if (!requestConfig || !requestConfig.chatId || !requestConfig.chatType) {
            return false;
        }

        const jobId = createJobId();

        upsertPendingJob({
            jobId,
            chatId: requestConfig.chatId,
            chatType: requestConfig.chatType,
            createdAt: Date.now()
        });

        syncPolling();

        try {
            const data = await postJson('/api/chat', {
                jobId,
                chatId: requestConfig.chatId,
                chatType: requestConfig.chatType,
                provider: requestConfig.provider,
                endpoint: requestConfig.endpoint,
                headers: requestConfig.headers,
                requestBody: requestConfig.requestBody
            });

            if (!data || data.ok !== true) {
                throw new Error((data && data.error) || 'Cloud reply handoff failed.');
            }

            if (!document.hidden) {
                setTimeout(() => {
                    window.AiRecovery.recoverPendingJobs({ reason: 'accepted' });
                }, 800);
            }

            return true;
        } catch (error) {
            console.warn('[AiRecovery] Cloud handoff failed, fallback to direct request:', error);
            removePendingJob(jobId);
            syncPolling();
            return false;
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            recoverPendingJobs({ reason: 'visibilitychange' });
        }
        syncPolling();
    });

    window.addEventListener('pageshow', () => {
        setTimeout(() => {
            recoverPendingJobs({ reason: 'pageshow' });
        }, 150);
        syncPolling();
    });

    window.addEventListener('load', () => {
        setTimeout(() => {
            recoverPendingJobs({ reason: 'load' });
        }, 1000);
        syncPolling();
    });

    window.AiRecovery = {
        startCloudReply,
        recoverPendingJobs
    };
})();
