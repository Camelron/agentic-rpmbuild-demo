// Contoso.ai demo server: JSON API, server-sent events, and the static dashboard.
//
//   GET    /api/health                      {status: "ok"}
//   GET    /api/cluster                     ClusterStats
//   GET    /api/sessions                    {sessions: Session[]}
//   POST   /api/sessions                    {title?}  -> 201 Session (state "starting")
//   GET    /api/sessions/:id                Session
//   DELETE /api/sessions/:id                204
//   GET    /api/sessions/:id/messages       {messages: Message[]}
//   POST   /api/sessions/:id/messages       {content} -> 202 {message, replyId}
//   POST   /api/sessions/:id/focus          Session; resets the idle timer
//   POST   /api/sessions/:id/suspend        202 Session (state "snapshotting")
//   POST   /api/sessions/:id/resume         202 Session (state "restoring")
//   GET    /api/events                      text/event-stream of ServerEvent
//
// Types and error codes are defined in lib/model.mjs.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApiError, Limits } from "./lib/model.mjs";
import { SessionManager } from "./lib/sessions.mjs";
import { StubBackend } from "./lib/backend.mjs";
import { KubernetesBackend } from "./lib/k8s-backend.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const SECURITY_HEADERS = {
    "content-security-policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
};

const routes = [
    ["GET", /^\/api\/health$/, () => ({ status: "ok" })],
    ["GET", /^\/api\/cluster$/, (m) => m.stats()],
    ["GET", /^\/api\/sessions$/, (m) => ({ sessions: m.list() })],
    ["POST", /^\/api\/sessions$/, async (m, req) => [201, m.create((await readJson(req)).title)]],
    ["GET", /^\/api\/sessions\/([0-9a-f]{8})$/, (m, req, id) => m.get(id)],
    ["DELETE", /^\/api\/sessions\/([0-9a-f]{8})$/, async (m, req, id) => (await m.delete(id), [204, null])],
    ["GET", /^\/api\/sessions\/([0-9a-f]{8})\/messages$/, (m, req, id) => ({ messages: m.getMessages(id) })],
    ["POST", /^\/api\/sessions\/([0-9a-f]{8})\/messages$/, async (m, req, id) => [202, m.sendMessage(id, (await readJson(req)).content)]],
    ["POST", /^\/api\/sessions\/([0-9a-f]{8})\/focus$/, (m, req, id) => m.focus(id)],
    ["POST", /^\/api\/sessions\/([0-9a-f]{8})\/suspend$/, (m, req, id) => [202, m.suspend(id)]],
    ["POST", /^\/api\/sessions\/([0-9a-f]{8})\/resume$/, (m, req, id) => [202, m.resume(id)]],
];

export function createContosoServer({ manager, publicDir = PUBLIC_DIR }) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        try {
            if (url.pathname === "/api/events") {
                if (req.method !== "GET") throw new ApiError(405, "method_not_allowed", "Use GET.");
                return streamEvents(manager, req, res);
            }
            if (url.pathname.startsWith("/api/")) {
                return await handleApi(manager, req, res, url.pathname);
            }
            if (req.method !== "GET" && req.method !== "HEAD") {
                throw new ApiError(405, "method_not_allowed", "Static files are read-only.");
            }
            return await serveStatic(publicDir, url.pathname, req, res);
        } catch (err) {
            const e = err instanceof ApiError ? err : new ApiError(500, "internal_error", "Internal server error.");
            if (!(err instanceof ApiError)) console.error(err);
            if (!res.headersSent) sendJson(res, e.status, { error: { code: e.code, message: e.message } });
            else res.end();
        }
    });
}

async function handleApi(manager, req, res, pathname) {
    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(pathname);
        if (!match) continue;
        pathMatched = true;
        if (method !== req.method) continue;
        const result = await handler(manager, req, ...match.slice(1));
        const [status, body] = Array.isArray(result) ? result : [200, result];
        return sendJson(res, status, body);
    }
    throw pathMatched
        ? new ApiError(405, "method_not_allowed", `${req.method} is not supported on ${pathname}.`)
        : new ApiError(404, "not_found", `No route for ${pathname}.`);
}

function streamEvents(manager, req, res) {
    res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "hello", sessions: manager.list(), stats: manager.stats() });
    manager.on("event", send);
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => {
        clearInterval(heartbeat);
        manager.off("event", send);
    });
}

async function serveStatic(publicDir, pathname, req, res) {
    let rel;
    try {
        rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
        throw new ApiError(404, "not_found", "Not found.");
    }
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) throw new ApiError(404, "not_found", "Not found.");
    let body;
    try {
        body = await fs.readFile(file);
    } catch {
        throw new ApiError(404, "not_found", "Not found.");
    }
    res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
}

async function readJson(req) {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("application/json")) {
        throw new ApiError(415, "unsupported_media_type", "Send application/json.");
    }
    if (Number(req.headers["content-length"] ?? 0) > Limits.bodyBytes) {
        throw new ApiError(413, "payload_too_large", `Body exceeds ${Limits.bodyBytes} bytes.`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > Limits.bodyBytes) throw new ApiError(413, "payload_too_large", `Body exceeds ${Limits.bodyBytes} bytes.`);
        chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
        return body;
    } catch {
        throw new ApiError(400, "invalid_json", "Body must be a JSON object.");
    }
}

function sendJson(res, status, body) {
    const headers = { ...SECURITY_HEADERS, "cache-control": "no-store" };
    if (body === null) {
        res.writeHead(status, headers);
        return res.end();
    }
    res.writeHead(status, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const env = process.env;
    const num = (name, fallback) => (env[name] === undefined ? fallback : Number(env[name]));
    const podMemoryMiB = num("CONTOSO_POD_MEMORY_MIB", 512);
    const backend = env.CONTOSO_BACKEND === "k8s"
        ? new KubernetesBackend({ namespace: env.CONTOSO_NAMESPACE, image: env.CONTOSO_IMAGE, podMemoryMiB })
        : new StubBackend({
            startMs: num("CONTOSO_STUB_START_MS", 2500),
            suspendMs: num("CONTOSO_STUB_SUSPEND_MS", 2000),
            resumeMs: num("CONTOSO_STUB_RESUME_MS", 1500),
            podMemoryMiB,
        });
    if (backend instanceof KubernetesBackend) {
        const removed = await backend.cleanupOrphans();
        console.log(`Removed ${removed.pods} orphaned chat Pods and ${removed.snapshots} snapshots`);
    }
    const manager = new SessionManager({ backend, idleMs: num("CONTOSO_IDLE_SECONDS", 60) * 1000 });
    const host = env.CONTOSO_HOST ?? "127.0.0.1";
    const port = num("CONTOSO_PORT", 8080);
    const kind = backend instanceof KubernetesBackend ? "Kubernetes" : "stub";
    createContosoServer({ manager }).listen(port, host, () => {
        console.log(`Contoso.ai demo on http://${host}:${port} (${kind} backend, idle suspend ${manager.idleMs / 1000}s)`);
    });
}
