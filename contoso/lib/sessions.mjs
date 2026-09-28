// In-memory session store and lifecycle. Every state change is validated
// against the model's transition table and published as a ServerEvent.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { ApiError, Limits, State, canTransition } from "./model.mjs";

const HOLDS_POD = new Set([State.Starting, State.Active, State.Snapshotting, State.Restoring, State.Deleting]);

export class SessionManager extends EventEmitter {
    /**
     * @param {{backend: import("./backend.mjs").SessionBackend, idleMs?: number, reapIntervalMs?: number}} opts
     *   idleMs: suspend an active, idle session after this long; 0 disables.
     */
    constructor({ backend, idleMs = 60_000, reapIntervalMs = 2_000 }) {
        super();
        this.backend = backend;
        this.idleMs = idleMs;
        this.sessions = new Map();
        this.messages = new Map();
        if (idleMs > 0) {
            this.reaper = setInterval(() => this.#reapIdle(), Math.min(reapIntervalMs, idleMs));
            this.reaper.unref();
        }
    }

    close() {
        clearInterval(this.reaper);
    }

    list() {
        return [...this.sessions.values()].map((s) => this.#view(s));
    }

    get(id) {
        return this.#view(this.#find(id));
    }

    getMessages(id) {
        this.#find(id);
        return this.messages.get(id).map((m) => ({ ...m }));
    }

    stats() {
        const byState = Object.fromEntries(Object.values(State).map((st) => [st, 0]));
        let podsRunning = 0;
        for (const s of this.sessions.values()) {
            byState[s.state]++;
            if (HOLDS_POD.has(s.state)) podsRunning++;
        }
        const { podMemoryMiB } = this.backend.info();
        return {
            sessions: this.sessions.size,
            byState,
            podsRunning,
            podMemoryMiB,
            memoryInUseMiB: podsRunning * podMemoryMiB,
            memoryWithoutSnapshotsMiB: this.sessions.size * podMemoryMiB,
        };
    }

    create(title) {
        title = normalizeTitle(title) || `Chat ${this.sessions.size + 1}`;
        const now = new Date().toISOString();
        const s = {
            id: this.#newId(),
            title,
            state: State.Starting,
            busy: false,
            podName: null,
            snapshotName: null,
            generation: 1,
            createdAt: now,
            lastActiveAt: now,
            timings: { startMs: null, lastSnapshotMs: null, lastRestoreMs: null },
            error: null,
        };
        this.sessions.set(s.id, s);
        this.messages.set(s.id, []);
        this.#publishSession(s);
        this.#run(s, "startMs", () => this.backend.start(this.#ref(s)), (r) => {
            s.podName = r.podName;
            return State.Active;
        });
        return this.#view(s);
    }

    focus(id) {
        const s = this.#find(id);
        s.lastActiveAt = new Date().toISOString();
        return this.#view(s);
    }

    suspend(id) {
        const s = this.#find(id);
        if (s.busy) throw new ApiError(409, "session_busy", "Wait for the reply to finish before suspending.");
        this.#transition(s, State.Snapshotting);
        this.#run(s, "lastSnapshotMs", () => this.backend.suspend(this.#ref(s)), (r) => {
            s.snapshotName = r.snapshotName;
            s.podName = null;
            return State.Suspended;
        });
        return this.#view(s);
    }

    resume(id) {
        const s = this.#find(id);
        this.#transition(s, State.Restoring);
        s.generation++;
        s.lastActiveAt = new Date().toISOString();
        this.#run(s, "lastRestoreMs", () => this.backend.resume(this.#ref(s)), (r) => {
            s.podName = r.podName;
            s.lastActiveAt = new Date().toISOString();
            return State.Active;
        });
        return this.#view(s);
    }

    async delete(id) {
        const s = this.#find(id);
        if (s.busy) throw new ApiError(409, "session_busy", "Wait for the reply to finish before deleting.");
        this.#transition(s, State.Deleting);
        try {
            await this.backend.destroy(this.#ref(s));
        } finally {
            this.sessions.delete(id);
            this.messages.delete(id);
            this.#emit({ type: "session.deleted", id });
            this.#emit({ type: "stats", stats: this.stats() });
        }
    }

    sendMessage(id, content) {
        const s = this.#find(id);
        if (typeof content !== "string" || !content.trim()) {
            throw new ApiError(400, "invalid_request", "content must be a non-empty string.");
        }
        if (content.length > Limits.contentMax) {
            throw new ApiError(400, "invalid_request", `content exceeds ${Limits.contentMax} characters.`);
        }
        if (s.state === State.Suspended) {
            throw new ApiError(409, "session_suspended", "Resume the session before sending messages.");
        }
        if (s.state !== State.Active) {
            throw new ApiError(409, "invalid_state", `Cannot send messages while the session is ${s.state}.`);
        }
        if (s.busy) throw new ApiError(409, "session_busy", "A reply is already streaming.");

        const user = this.#addMessage(s, "user", content, true);
        const reply = this.#addMessage(s, "assistant", "", false);
        s.busy = true;
        s.lastActiveAt = new Date().toISOString();
        this.#publishSession(s);

        const onDelta = (delta) => {
            reply.content += delta;
            this.#emit({ type: "message.delta", sessionId: s.id, messageId: reply.id, delta });
        };
        this.backend.prompt(this.#ref(s), content, onDelta).then(
            (full) => (reply.content = full),
            (err) => (reply.content += `\n[error: ${err.message}]`),
        ).finally(() => {
            reply.complete = true;
            s.busy = false;
            s.lastActiveAt = new Date().toISOString();
            this.#emit({ type: "message.completed", message: { ...reply } });
            this.#publishSession(s);
        });
        return { message: { ...user }, replyId: reply.id };
    }

    #reapIdle() {
        const cutoff = Date.now() - this.idleMs;
        for (const s of this.sessions.values()) {
            if (s.state === State.Active && !s.busy && Date.parse(s.lastActiveAt) < cutoff) {
                this.suspend(s.id);
            }
        }
    }

    // Runs a backend operation for s, timing it into s.timings[timingKey];
    // onDone applies the result and returns the next state.
    #run(s, timingKey, op, onDone) {
        const started = Date.now();
        op().then(
            (result) => {
                s.timings[timingKey] = Date.now() - started;
                this.#transition(s, onDone(result));
            },
            (err) => {
                s.error = err.message;
                this.#transition(s, State.Failed);
            },
        ).catch((err) => console.error(`session ${s.id}: ${err.message}`));
    }

    #transition(s, to) {
        if (!canTransition(s.state, to)) {
            throw new ApiError(409, "invalid_state", `Cannot go from ${s.state} to ${to}.`);
        }
        s.state = to;
        if (to !== State.Failed) s.error = null;
        this.#publishSession(s);
    }

    #addMessage(s, role, content, complete) {
        const m = {
            id: randomBytes(6).toString("hex"),
            sessionId: s.id,
            role,
            content,
            complete,
            createdAt: new Date().toISOString(),
        };
        this.messages.get(s.id).push(m);
        this.#emit({ type: "message.created", message: { ...m } });
        return m;
    }

    #publishSession(s) {
        this.#emit({ type: "session.upserted", session: this.#view(s) });
        this.#emit({ type: "stats", stats: this.stats() });
    }

    #emit(event) {
        this.emit("event", event);
    }

    #find(id) {
        const s = this.sessions.get(id);
        if (!s) throw new ApiError(404, "not_found", `No session ${id}.`);
        return s;
    }

    #newId() {
        let id;
        do id = randomBytes(4).toString("hex");
        while (this.sessions.has(id));
        return id;
    }

    #ref(s) {
        return { id: s.id, generation: s.generation, podName: s.podName, snapshotName: s.snapshotName };
    }

    #view(s) {
        return { ...s, timings: { ...s.timings }, messageCount: this.messages.get(s.id)?.length ?? 0 };
    }
}

function normalizeTitle(title) {
    if (title === undefined || title === null) return "";
    if (typeof title !== "string") throw new ApiError(400, "invalid_request", "title must be a string.");
    title = title.trim();
    if (title.length > Limits.titleMax) {
        throw new ApiError(400, "invalid_request", `title exceeds ${Limits.titleMax} characters.`);
    }
    return title;
}
