// Contoso.ai assistant daemon: the container's main process. It owns the
// Copilot SDK client and serves a loopback-only control API, driven through
// `kubectl exec <pod> -- assistantctl ...`.
//
//   GET  /status                 {sessionId, role, busy, hostname}
//   POST /brief      (text)      base Pod only: create the base session, send the briefing
//   POST /fork       {name}      new chat: fork the base session into a new session
//   POST /reconnect              restart the runtime and reattach (manual fallback)
//   POST /quiesce    {timeoutMs} wait until no outbound TCP connection is open (call before a snapshot)
//   POST /prompt     (text)      NDJSON stream of {type: delta|tool|done|error}
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { tools, toolNames } from "./tools.mjs";

const PORT = 8765;
const BASE_SESSION_ID = "contoso-base";
const WORKDIR = `${os.homedir()}/workspace`;
const LOG_FILE = `${os.homedir()}/assistant.log`;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
// A turn with no model or tool activity for this long is treated as stuck on a dead connection.
const STALL_MS = 25_000;
const ACTIVITY = new Set(["assistant.message_delta", "assistant.message", "assistant.reasoning_delta", "tool.execution_start", "session.error"]);

fs.mkdirSync(WORKDIR, { recursive: true });

let client;
let session;
let busy = false;

function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    process.stdout.write(line);
    fs.appendFileSync(LOG_FILE, line);
}

// Recomputed on every create, fork, and reconnect so a restored clone sees today's date.
function sessionConfig() {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
    return {
        onPermissionRequest: approveAll,
        workingDirectory: WORKDIR,
        streaming: true,
        tools,
        availableTools: toolNames,
        skipCustomInstructions: true,
        // The WebSocket transport binds item IDs to a connection that does not survive a restore.
        capi: { enableWebSocketResponses: false },
        systemMessage: {
            content: [
                "You are Cameron's personal assistant in the Contoso.ai app. Today is " + today + " (Pacific time).",
                "This conversation is part of a live product demo. The travel, calendar, email, and weather tools",
                "are demo integrations that return simulated data: use them whenever a request calls for it, and act",
                "on their results as if they were real, without pointing out that they are simulated unless asked.",
                "If a request needs something no tool provides, say briefly what you would do and give a plausible result.",
                "Keep replies short and friendly. Use a compact list when offering options, and confirm before booking",
                "anything that costs money unless Cameron already said to go ahead.",
            ].join(" "),
        },
    };
}

async function startClient() {
    client = new CopilotClient({ workingDirectory: WORKDIR, logLevel: "warning" });
    await client.start();
}

// Drops every connection the runtime opened, e.g. from the snapshot source's Pod IP.
async function restartClient() {
    await client.forceStop();
    session = undefined;
    await startClient();
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

async function brief(text) {
    if (session) throw Object.assign(new Error("already briefed"), { code: 409 });
    session = await client.createSession({ ...sessionConfig(), sessionId: BASE_SESSION_ID });
    log(`[${session.sessionId}] briefing: ${text}`);
    const reply = await session.sendAndWait({ prompt: text }, TURN_TIMEOUT_MS);
    const content = reply?.data.content ?? "";
    log(`[${session.sessionId}] assistant: ${content}`);
    return { sessionId: session.sessionId, reply: content };
}

async function fork(name) {
    if (!name || typeof name !== "string") throw Object.assign(new Error("name is required"), { code: 400 });
    const t0 = Date.now();
    let forked;
    try {
        forked = await client.rpc.sessions.fork({ sessionId: BASE_SESSION_ID, name });
    } catch (err) {
        log(`in-place fork failed (${err.message}); restarting the runtime`);
        await restartClient();
        forked = await client.rpc.sessions.fork({ sessionId: BASE_SESSION_ID, name });
    }
    const base = session;
    session = await client.resumeSession(forked.sessionId, sessionConfig());
    await base?.disconnect().catch(() => {});
    log(`forked ${BASE_SESSION_ID} -> ${session.sessionId} (${name}) in ${Date.now() - t0} ms`);
    return { sessionId: session.sessionId, ms: Date.now() - t0 };
}

async function reconnect() {
    const id = session?.sessionId;
    if (!id) throw Object.assign(new Error("no session to reconnect"), { code: 409 });
    await restartClient();
    session = await client.resumeSession(id, sessionConfig());
    log(`reconnected ${id}`);
    return { sessionId: id };
}

// Established TCP connections to anything but loopback, from the Pod network namespace.
function openConnections() {
    let count = 0;
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        let lines;
        try {
            lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
        } catch {
            continue;
        }
        for (const line of lines) {
            const [, , remote, st] = line.trim().split(/\s+/);
            const addr = remote.split(":")[0];
            // IPv4 is little-endian hex, so 127.x.x.x ends in 7F; IPv6 covers ::1 and ::ffff:127.x.
            const loopback = (addr.length === 8 && addr.endsWith("7F")) || addr === "00000000000000000000000001000000"
                || (addr.startsWith("0000000000000000FFFF0000") && addr.endsWith("7F"));
            if (st === "01" && !loopback) count++;
        }
    }
    return count;
}

// A snapshot taken with connections open restores them bound to the old Pod IP.
async function quiesce(timeoutMs = 45_000) {
    if (busy) throw Object.assign(new Error("a reply is streaming"), { code: 409 });
    const t0 = Date.now();
    let open = openConnections();
    while (open > 0 && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 250));
        open = openConnections();
    }
    const result = { quiet: open === 0, open, waitedMs: Date.now() - t0 };
    log(`quiesce: ${JSON.stringify(result)}`);
    return result;
}

// Streams one turn as NDJSON until the session goes idle. A turn that stalls is
// retried once on a restarted runtime (the recovery path if a snapshot kept a dead connection).
async function prompt(req, res) {
    if (!session) throw Object.assign(new Error("no session"), { code: 409 });
    if (busy) throw Object.assign(new Error("a reply is already streaming"), { code: 409 });
    const text = await readBody(req);
    if (!text.trim()) throw Object.assign(new Error("empty prompt"), { code: 400 });

    busy = true;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const write = (event) => res.write(`${JSON.stringify(event)}\n`);
    log(`[${session.sessionId}] user: ${text}`);

    try {
        for (let attempt = 1; ; attempt++) {
            const outcome = await runTurn(text, write, attempt === 1 ? STALL_MS : 0);
            if (outcome !== "stalled") break;
            log(`[${session.sessionId}] no activity after ${STALL_MS} ms; restarting the runtime and retrying`);
            await reconnect();
        }
    } catch (err) {
        write({ type: "error", message: err.message });
    } finally {
        busy = false;
        res.end();
    }
}

// Resolves "done", or "stalled" when stallMs > 0 and nothing happens within it.
async function runTurn(text, write, stallMs) {
    let content = "";
    let active = false;
    let markActive;
    const activity = new Promise((resolve) => (markActive = resolve));
    const unsubscribe = session.on((e) => {
        if (ACTIVITY.has(e.type) && !active) {
            active = true;
            markActive();
        }
        if (e.type === "assistant.message_delta" && e.data.deltaContent) {
            write({ type: "delta", text: e.data.deltaContent });
        } else if (e.type === "assistant.message" && e.data.content) {
            content = e.data.content;
        } else if (e.type === "tool.execution_start") {
            write({ type: "tool", name: e.data.toolName, arguments: e.data.arguments ?? {} });
            log(`[${session.sessionId}] tool ${e.data.toolName} ${JSON.stringify(e.data.arguments ?? {})}`);
        } else if (e.type === "session.error") {
            write({ type: "error", message: e.data.message });
        }
    });
    try {
        const turn = session.sendAndWait({ prompt: text }, TURN_TIMEOUT_MS);
        if (stallMs > 0) {
            let timer;
            const stalled = new Promise((resolve) => (timer = setTimeout(() => resolve("stalled"), stallMs)));
            const first = await Promise.race([activity.then(() => "active"), turn.then(() => "done"), stalled]);
            clearTimeout(timer);
            if (first === "stalled") {
                turn.catch(() => {});
                await session.abort().catch(() => {});
                return "stalled";
            }
        }
        await turn;
        log(`[${session.sessionId}] assistant: ${content}`);
        write({ type: "done", content });
        return "done";
    } finally {
        unsubscribe();
    }
}

const routes = {
    "GET /status": async () => ({
        sessionId: session?.sessionId ?? null,
        role: session?.sessionId === BASE_SESSION_ID ? "base" : session ? "chat" : "none",
        busy,
        hostname: os.hostname(),
    }),
    "POST /brief": async (req) => brief(await readBody(req)),
    "POST /fork": async (req) => fork(JSON.parse((await readBody(req)) || "{}").name),
    "POST /reconnect": async () => reconnect(),
    "POST /quiesce": async (req) => quiesce(JSON.parse((await readBody(req)) || "{}").timeoutMs),
};

http.createServer(async (req, res) => {
    const key = `${req.method} ${req.url}`;
    try {
        if (key === "POST /prompt") return await prompt(req, res);
        const route = routes[key];
        if (!route) throw Object.assign(new Error("not found"), { code: 404 });
        const body = await route(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`${JSON.stringify(body)}\n`);
    } catch (err) {
        log(`${key} failed: ${err.message}`);
        if (res.headersSent) return res.end();
        res.writeHead(err.code >= 400 && err.code < 600 ? err.code : 500, { "content-type": "application/json" });
        res.end(`${JSON.stringify({ error: err.message })}\n`);
    }
}).listen(PORT, "127.0.0.1");

process.on("SIGTERM", async () => {
    await client?.stop();
    process.exit(0);
});

await startClient();
log(`assistantd ready on 127.0.0.1:${PORT}`);
