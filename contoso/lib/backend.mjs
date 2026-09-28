// Cluster backend contract, plus a stub that simulates Pod lifecycle latency.

/**
 * What the session manager needs from the cluster. A Kubernetes backend maps
 * these onto the demo's flow:
 *   start   restore a new Pod from the briefed progenitor snapshot
 *   suspend snapshot-create.sh on the session Pod, then delete the Pod
 *   resume  create a Pod annotated with io.katacontainers.snapshot-name
 *   prompt  kubectl exec <pod> -- agentctl prompt
 *   destroy delete the Pod and the session's snapshot
 *
 * Pod and snapshot names are derived from the session ID and generation, so a
 * restored Pod never reuses the name of the snapshot it was restored from.
 *
 * @typedef {object} SessionRef
 * @property {string} id
 * @property {number} generation
 * @property {string|null} podName
 * @property {string|null} snapshotName
 *
 * @typedef {object} SessionBackend
 * @property {(s: SessionRef) => Promise<{podName: string}>} start
 * @property {(s: SessionRef) => Promise<{snapshotName: string}>} suspend
 * @property {(s: SessionRef) => Promise<{podName: string}>} resume
 * @property {(s: SessionRef, prompt: string, onDelta: (delta: string) => void) => Promise<string>} prompt
 *   Streams the reply through onDelta and resolves with the full reply.
 * @property {(s: SessionRef) => Promise<void>} destroy
 * @property {() => {podMemoryMiB: number}} info
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));

/** @implements {SessionBackend} */
export class StubBackend {
    constructor({ startMs = 2500, suspendMs = 2000, resumeMs = 1500, tokenMs = 40, podMemoryMiB = 2048 } = {}) {
        Object.assign(this, { startMs, suspendMs, resumeMs, tokenMs, podMemoryMiB });
    }

    podName(s) {
        return `contoso-${s.id}-g${s.generation}`;
    }

    async start(s) {
        await sleep(jitter(this.startMs));
        return { podName: this.podName(s) };
    }

    async suspend(s) {
        await sleep(jitter(this.suspendMs));
        return { snapshotName: s.podName };
    }

    async resume(s) {
        await sleep(jitter(this.resumeMs));
        return { podName: this.podName(s) };
    }

    async prompt(s, prompt, onDelta) {
        const reply = `(stub) ${s.podName} received: "${prompt}". The Copilot agent is not wired up yet.`;
        for (const token of reply.split(/(?<=\s)/)) {
            onDelta(token);
            await sleep(this.tokenMs);
        }
        return reply;
    }

    async destroy() {}

    info() {
        return { podMemoryMiB: this.podMemoryMiB };
    }
}
