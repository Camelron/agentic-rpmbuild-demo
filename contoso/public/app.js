// Contoso.ai dashboard: renders sessions and messages from /api/events and
// drives the session API. All user-supplied text is rendered with textContent.

const $ = (id) => document.getElementById(id);
const state = { sessions: new Map(), messages: new Map(), selectedId: null, stats: null };

const LABELS = {
    starting: "Starting pod…",
    active: "Live",
    snapshotting: "Snapshotting…",
    suspended: "Snapshotted · pod released",
    restoring: "Restoring from snapshot…",
    deleting: "Deleting…",
    failed: "Failed",
};
const OVERLAY = {
    starting: "Starting a pod for this chat…",
    snapshotting: "Snapshotting and releasing the pod…",
    restoring: "Restoring the pod from its snapshot…",
};
const FOCUS_HEARTBEAT_MS = 10_000;

async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    let data = null;
    try {
        data = JSON.parse(await res.text());
    } catch {
        // A proxy between the browser and the server answered instead, e.g. after a dropped connection.
    }
    if (!res.ok || data === null) {
        throw new Error(data?.error?.message ?? `Lost the connection to the server (HTTP ${res.status}). Try again.`);
    }
    return data;
}

function showToast(text) {
    const toast = $("toast");
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => (toast.hidden = true), 4000);
}

const fail = (err) => showToast(err.message);
const secs = (ms) => (ms === null ? "" : `${(ms / 1000).toFixed(1)} s`);
const gib = (mib) => `${(mib / 1024).toFixed(mib % 1024 ? 1 : 0)} GiB`;

// --- event stream -----------------------------------------------------------

function connect() {
    const events = new EventSource("/api/events");
    events.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

function handleEvent(ev) {
    switch (ev.type) {
        case "hello":
            state.sessions = new Map(ev.sessions.map((s) => [s.id, s]));
            state.stats = ev.stats;
            if (!state.sessions.has(state.selectedId)) state.selectedId = null;
            break;
        case "session.upserted":
            announceTransition(state.sessions.get(ev.session.id), ev.session);
            state.sessions.set(ev.session.id, ev.session);
            break;
        case "session.deleted":
            state.sessions.delete(ev.id);
            state.messages.delete(ev.id);
            if (state.selectedId === ev.id) state.selectedId = null;
            break;
        case "message.created": {
            const list = state.messages.get(ev.message.sessionId);
            if (list && !list.some((x) => x.id === ev.message.id)) list.push(ev.message);
            break;
        }
        case "message.delta": {
            const m = state.messages.get(ev.sessionId)?.find((x) => x.id === ev.messageId);
            if (m) m.content += ev.delta;
            break;
        }
        case "message.completed": {
            const list = state.messages.get(ev.message.sessionId);
            const i = list?.findIndex((x) => x.id === ev.message.id) ?? -1;
            if (i >= 0) list[i] = ev.message;
            break;
        }
        case "stats":
            state.stats = ev.stats;
            renderStats();
            return;
    }
    render();
}

function announceTransition(prev, next) {
    if (!prev || prev.state === next.state) return;
    if (prev.state === "restoring" && next.state === "active") {
        showToast(`Restored “${next.title}” in ${secs(next.timings.lastRestoreMs)}`);
    } else if (prev.state === "snapshotting" && next.state === "suspended") {
        showToast(`Snapshotted “${next.title}” in ${secs(next.timings.lastSnapshotMs)}; pod released`);
    } else if (next.state === "failed") {
        showToast(`“${next.title}” failed: ${next.error}`);
    }
}

// --- rendering --------------------------------------------------------------

function render() {
    renderStats();
    renderSidebar();
    renderConversation();
}

function renderStats() {
    const s = state.stats;
    if (!s) return;
    $("stats").textContent =
        `Chats ${s.sessions} · Pods running ${s.podsRunning} · ` +
        `VM memory ${gib(s.memoryInUseMiB)} (${gib(s.memoryWithoutSnapshotsMiB)} without snapshots)`;
}

function renderSidebar() {
    const list = $("session-list");
    const sessions = [...state.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    list.replaceChildren(...sessions.map((s) => {
        const li = document.createElement("li");
        li.className = `session state-${s.state}${s.id === state.selectedId ? " selected" : ""}`;
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        const title = document.createElement("div");
        title.className = "session-title";
        title.textContent = s.title;
        const sub = document.createElement("div");
        sub.className = "session-sub";
        sub.textContent = s.state === "active" ? `${LABELS.active} · ${s.podName}` : LABELS[s.state];
        li.append(title, sub);
        li.onclick = () => select(s.id);
        li.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && select(s.id);
        return li;
    }));
}

function renderConversation() {
    const s = state.sessions.get(state.selectedId);
    $("empty").hidden = Boolean(s);
    $("conversation").hidden = !s;
    if (!s) return;

    $("chat-title").textContent = s.title;
    const meta = [LABELS[s.state], s.podName && `pod ${s.podName}`, `generation ${s.generation}`];
    if (s.timings.lastRestoreMs !== null) meta.push(`last restore ${secs(s.timings.lastRestoreMs)}`);
    $("chat-meta").textContent = meta.filter(Boolean).join(" · ");
    $("chat-meta").className = `meta state-${s.state}`;

    const messages = state.messages.get(s.id) ?? [];
    $("messages").replaceChildren(...messages.map((m) => {
        const div = document.createElement("div");
        div.className = `message ${m.role}${m.complete ? "" : " streaming"}`;
        if (m.role === "assistant" && m.content) renderRich(div, m.content);
        else div.textContent = m.content || "…";
        return div;
    }));
    $("messages").scrollTop = $("messages").scrollHeight;

    const overlay = OVERLAY[s.state];
    $("overlay").hidden = !overlay;
    $("overlay-text").textContent = overlay ?? "";

    const canSend = s.state === "active" && !s.busy;
    $("input").disabled = !canSend;
    $("send").disabled = !canSend;
    $("suspend").disabled = !(s.state === "active" && !s.busy);
    $("delete").disabled = !["active", "suspended", "failed"].includes(s.state) || s.busy;
}

// Tool-call lines ("→ name(args)") are muted and **bold** becomes <strong>; text stays textContent.
function renderRich(container, text) {
    text.split("\n").forEach((line, i) => {
        if (i > 0) container.append("\n");
        if (line.startsWith("→ ")) {
            const tool = document.createElement("span");
            tool.className = "tool-call";
            tool.textContent = line;
            container.append(tool);
            return;
        }
        line.split(/\*\*(.+?)\*\*/g).forEach((part, j) => {
            if (j % 2 === 0) return part && container.append(part);
            const strong = document.createElement("strong");
            strong.textContent = part;
            container.append(strong);
        });
    });
}

// --- actions ----------------------------------------------------------------

async function select(id) {
    state.selectedId = id;
    render();
    try {
        if (!state.messages.has(id)) {
            state.messages.set(id, []);
            const { messages } = await api("GET", `/api/sessions/${id}/messages`);
            const known = new Set(messages.map((m) => m.id));
            const arrived = state.messages.get(id)?.filter((m) => !known.has(m.id)) ?? [];
            state.messages.set(id, [...messages, ...arrived]);
        }
        const s = state.sessions.get(id);
        if (s?.state === "suspended") await api("POST", `/api/sessions/${id}/resume`);
        else if (s?.state === "active") await api("POST", `/api/sessions/${id}/focus`);
    } catch (err) {
        fail(err);
    }
    render();
}

$("new-chat").onclick = async () => {
    try {
        const s = await api("POST", "/api/sessions", {});
        state.sessions.set(s.id, s);
        state.messages.set(s.id, []);
        await select(s.id);
        $("input").focus();
    } catch (err) {
        fail(err);
    }
};

$("composer").onsubmit = async (e) => {
    e.preventDefault();
    const content = $("input").value.trim();
    if (!content || !state.selectedId) return;
    $("input").value = "";
    try {
        await api("POST", `/api/sessions/${state.selectedId}/messages`, { content });
    } catch (err) {
        $("input").value = content;
        fail(err);
    }
};

$("input").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("composer").requestSubmit();
    }
};

$("suspend").onclick = () => api("POST", `/api/sessions/${state.selectedId}/suspend`).catch(fail);

$("delete").onclick = async () => {
    const s = state.sessions.get(state.selectedId);
    if (s && confirm(`Delete “${s.title}”? Its pod and snapshot are removed.`)) {
        await api("DELETE", `/api/sessions/${s.id}`).catch(fail);
    }
};

// Keeps the chat on screen from being suspended as idle.
setInterval(() => {
    const s = state.sessions.get(state.selectedId);
    if (s?.state === "active" && document.visibilityState === "visible") {
        api("POST", `/api/sessions/${s.id}/focus`).catch(() => {});
    }
}, FOCUS_HEARTBEAT_MS);

connect();
