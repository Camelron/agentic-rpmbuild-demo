// Long-lived agent daemon: owns the Copilot SDK client (which runs the Copilot
// CLI runtime as a child over stdio) and exposes a loopback control API.
// Its memory, the runtime's state, and ~/.copilot are captured by the Kata
// snapshot; clones call POST /wake to fork the briefed session and start work.
import fs from "node:fs";
import http from "node:http";
import { CopilotClient, approveAll } from "@github/copilot-sdk";

const PORT = 8765;
const WORKDIR = "/workdir/azurelinux";
const LOG_FILE = `${process.env.HOME}/agent.log`;
const ROOT_SESSION_ID = "progenitor";
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;

// No client is attached to answer tool prompts, and the WebSocket Responses
// transport binds item IDs to a connection that does not survive a restore.
const sessionConfig = {
    onPermissionRequest: approveAll,
    workingDirectory: WORKDIR,
    capi: { enableWebSocketResponses: false },
};

let client;
let session;
let busy = false;

function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    process.stdout.write(line);
    fs.appendFileSync(LOG_FILE, line);
}

async function startClient() {
    client = new CopilotClient({ workingDirectory: WORKDIR, logLevel: "warning" });
    await client.start();
}

function attach(s) {
    s.on("assistant.message", (e) => {
        if (e.data.content) {
            log(`[${s.sessionId}] assistant: ${e.data.content}`);
        }
    });
    s.on("tool.execution_start", (e) => {
        const args = JSON.stringify(e.data.arguments ?? {});
        log(`[${s.sessionId}] tool ${e.data.toolName}: ${args.slice(0, 300)}`);
    });
    s.on("session.error", (e) => log(`[${s.sessionId}] error: ${e.data.message}`));
    s.on("session.idle", () => {
        busy = false;
        log(`[${s.sessionId}] idle`);
    });
    session = s;
    return s;
}

async function openRootSession() {
    try {
        return attach(await client.resumeSession(ROOT_SESSION_ID, sessionConfig));
    } catch {
        return attach(await client.createSession({ ...sessionConfig, sessionId: ROOT_SESSION_ID }));
    }
}

function wakePrompt(name) {
    const promptPath = process.env.ENTRY_PROMPT;
    const task = fs.readFileSync(promptPath, "utf8").trim();
    return [
        `Wake up. You are ${name}, a clone of the progenitor agent you remember being.`,
        `Your scope, from ${promptPath}:`,
        "",
        task,
        "",
        "Work on the fix. The end result should be a topic branch off of the current",
        "azurelinux branch, containing the fix, pushed to origin. Do not open a pull",
        "request. Finish by summarizing the root cause, the fix, how you verified it,",
        "and the pushed branch name.",
    ].join("\n");
}

async function prompt(text) {
    if (!session) {
        await openRootSession();
    }
    busy = true;
    log(`[${session.sessionId}] user: ${text}`);
    try {
        const reply = await session.sendAndWait({ prompt: text }, PROMPT_TIMEOUT_MS);
        return reply?.data.content ?? "";
    } finally {
        busy = false;
    }
}

async function wake() {
    if (!session) {
        return { status: "no briefed session to fork" };
    }
    if (session.sessionId !== ROOT_SESSION_ID) {
        return { status: "already awake", sessionId: session.sessionId };
    }
    // /etc/hostname is refreshed per clone; this process's HOSTNAME env is frozen.
    const name = fs.readFileSync("/etc/hostname", "utf8").trim();

    // Restart the runtime so no connection opened by the progenitor (old Pod IP)
    // is reused; the briefed history is on disk and survives the restart.
    await client.forceStop();
    session = undefined;
    await startClient();

    const fork = await client.rpc.sessions.fork({ sessionId: ROOT_SESSION_ID, name });
    log(`forked ${ROOT_SESSION_ID} -> ${fork.sessionId} (${name})`);
    attach(await client.resumeSession(fork.sessionId, sessionConfig));

    const text = wakePrompt(name);
    busy = true;
    log(`[${session.sessionId}] user: ${text}`);
    await session.send({ prompt: text });
    return { status: "awake", sessionId: session.sessionId, name };
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

function reply(res, code, body) {
    res.writeHead(code, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
    res.end(typeof body === "string" ? `${body}\n` : `${JSON.stringify(body)}\n`);
}

const routes = {
    "GET /status": async () => ({
        sessionId: session?.sessionId ?? null,
        busy,
        hostname: fs.readFileSync("/etc/hostname", "utf8").trim(),
    }),
    "POST /prompt": async (req) => {
        if (busy) {
            throw Object.assign(new Error("agent is busy"), { code: 409 });
        }
        return prompt(await readBody(req));
    },
    "POST /wake": async () => wake(),
};

http.createServer(async (req, res) => {
    const route = routes[`${req.method} ${req.url}`];
    if (!route) {
        return reply(res, 404, "not found");
    }
    try {
        reply(res, 200, await route(req));
    } catch (err) {
        log(`${req.method} ${req.url} failed: ${err.message}`);
        reply(res, err.code ?? 500, err.message);
    }
}).listen(PORT, "127.0.0.1");

process.on("SIGTERM", async () => {
    await client?.stop();
    process.exit(0);
});

await startClient();
log(`agentd ready on 127.0.0.1:${PORT}`);
