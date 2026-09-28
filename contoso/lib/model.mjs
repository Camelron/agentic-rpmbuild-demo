// Contoso.ai API model: session states, allowed transitions, input limits, and
// the JSON shapes returned by the HTTP API and the event stream.

export const State = Object.freeze({
    Starting: "starting",
    Active: "active",
    Snapshotting: "snapshotting",
    Suspended: "suspended",
    Restoring: "restoring",
    Deleting: "deleting",
    Failed: "failed",
});

// Any transition not listed here is rejected with 409 invalid_state.
const transitions = {
    starting: ["active", "failed"],
    active: ["snapshotting", "deleting"],
    snapshotting: ["suspended", "failed"],
    suspended: ["restoring", "deleting"],
    restoring: ["active", "failed"],
    failed: ["deleting"],
    deleting: [],
};

export function canTransition(from, to) {
    return transitions[from]?.includes(to) ?? false;
}

export const Limits = Object.freeze({
    titleMax: 120,
    contentMax: 8000,
    bodyBytes: 64 * 1024,
});

export class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/**
 * @typedef {"starting"|"active"|"snapshotting"|"suspended"|"restoring"|"deleting"|"failed"} SessionState
 *
 * @typedef {object} Session
 * @property {string} id                 8 hex characters.
 * @property {string} title
 * @property {SessionState} state
 * @property {boolean} busy              An assistant reply is streaming.
 * @property {string|null} podName       Pod backing the session; null while suspended.
 * @property {string|null} snapshotName  Snapshot the session was last suspended to.
 * @property {number} generation         Starts at 1; incremented by every restore.
 * @property {string} createdAt          ISO 8601.
 * @property {string} lastActiveAt       ISO 8601; drives idle suspension.
 * @property {{startMs: number|null, lastSnapshotMs: number|null, lastRestoreMs: number|null}} timings
 * @property {string|null} error         Last failure, set when state is "failed".
 * @property {number} messageCount
 *
 * @typedef {object} Message
 * @property {string} id
 * @property {string} sessionId
 * @property {"user"|"assistant"} role
 * @property {string} content
 * @property {boolean} complete          False while an assistant reply is streaming.
 * @property {string} createdAt
 *
 * @typedef {object} ClusterStats
 * @property {number} sessions
 * @property {Record<SessionState, number>} byState
 * @property {number} podsRunning        Sessions currently holding a Pod.
 * @property {number} podMemoryMiB       Memory of one Pod VM.
 * @property {number} memoryInUseMiB     podsRunning x podMemoryMiB.
 * @property {number} memoryWithoutSnapshotsMiB  sessions x podMemoryMiB.
 *
 * Events on GET /api/events (text/event-stream), one JSON object per `data:` frame:
 * @typedef {{type: "hello", sessions: Session[], stats: ClusterStats}
 *   | {type: "session.upserted", session: Session}
 *   | {type: "session.deleted", id: string}
 *   | {type: "message.created", message: Message}
 *   | {type: "message.delta", sessionId: string, messageId: string, delta: string}
 *   | {type: "message.completed", message: Message}
 *   | {type: "stats", stats: ClusterStats}} ServerEvent
 *
 * Errors are {"error": {"code": string, "message": string}} with codes:
 * invalid_request, invalid_json, unsupported_media_type, payload_too_large,
 * not_found, method_not_allowed, invalid_state, session_suspended,
 * session_busy, internal_error.
 */
