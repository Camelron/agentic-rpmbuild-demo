// API contract tests against the stub backend with near-zero latencies.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createContosoServer } from "../server.mjs";
import { SessionManager } from "../lib/sessions.mjs";
import { StubBackend } from "../lib/backend.mjs";

let server;
let manager;
let base;

before(async () => {
    const backend = new StubBackend({ startMs: 20, suspendMs: 20, resumeMs: 20, tokenMs: 1 });
    manager = new SessionManager({ backend, idleMs: 0 });
    server = createContosoServer({ manager });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    manager.close();
    server.close();
});

async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function waitFor(check, what) {
    for (let i = 0; i < 200; i++) {
        const value = await check();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
}

const waitState = (id, state) =>
    waitFor(async () => {
        const { body } = await call("GET", `/api/sessions/${id}`);
        return body.state === state && body;
    }, `session ${id} to be ${state}`);

test("session lifecycle: create, chat, suspend, resume, delete", async () => {
    const created = await call("POST", "/api/sessions", { title: "Build fixes" });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, "starting");
    assert.match(created.body.id, /^[0-9a-f]{8}$/);
    const id = created.body.id;

    const active = await waitState(id, "active");
    assert.equal(active.podName, `contoso-${id}-g1`);
    assert.equal(typeof active.timings.startMs, "number");

    const sent = await call("POST", `/api/sessions/${id}/messages`, { content: "hello" });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.message.role, "user");
    const reply = await waitFor(async () => {
        const { body } = await call("GET", `/api/sessions/${id}/messages`);
        return body.messages.find((m) => m.id === sent.body.replyId && m.complete);
    }, "assistant reply");
    assert.match(reply.content, /hello/);

    const suspending = await call("POST", `/api/sessions/${id}/suspend`);
    assert.equal(suspending.status, 202);
    assert.equal(suspending.body.state, "snapshotting");
    const suspended = await waitState(id, "suspended");
    assert.equal(suspended.podName, null);
    assert.equal(suspended.snapshotName, `contoso-${id}-g1`);

    const blocked = await call("POST", `/api/sessions/${id}/messages`, { content: "still there?" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "session_suspended");

    const resuming = await call("POST", `/api/sessions/${id}/resume`);
    assert.equal(resuming.status, 202);
    assert.equal(resuming.body.state, "restoring");
    const resumed = await waitState(id, "active");
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.podName, `contoso-${id}-g2`);
    assert.equal(typeof resumed.timings.lastRestoreMs, "number");

    const history = await call("GET", `/api/sessions/${id}/messages`);
    assert.equal(history.body.messages.length, 2);

    assert.equal((await call("DELETE", `/api/sessions/${id}`)).status, 204);
    assert.equal((await call("GET", `/api/sessions/${id}`)).status, 404);
});

test("invalid transitions are rejected with 409 invalid_state", async () => {
    const { body } = await call("POST", "/api/sessions", {});
    await waitState(body.id, "active");
    const resume = await call("POST", `/api/sessions/${body.id}/resume`);
    assert.equal(resume.status, 409);
    assert.equal(resume.body.error.code, "invalid_state");
    await call("DELETE", `/api/sessions/${body.id}`);
});

test("request validation", async () => {
    const long = await call("POST", "/api/sessions", { title: "x".repeat(121) });
    assert.equal(long.status, 400);
    assert.equal(long.body.error.code, "invalid_request");

    const badJson = await call("POST", "/api/sessions", "{not json");
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, "invalid_json");

    const noType = await call("POST", "/api/sessions", undefined, {});
    assert.equal(noType.status, 415);

    const big = await call("POST", "/api/sessions", { title: "x".repeat(70 * 1024) });
    assert.equal(big.status, 413);

    assert.equal((await call("GET", "/api/sessions/deadbeef")).status, 404);
    assert.equal((await call("GET", "/api/nope")).status, 404);
    assert.equal((await call("PUT", "/api/sessions")).status, 405);
});

test("idle sessions are suspended automatically", async () => {
    const idleManager = new SessionManager({
        backend: new StubBackend({ startMs: 10, suspendMs: 10, resumeMs: 10 }),
        idleMs: 50,
        reapIntervalMs: 10,
    });
    try {
        const s = idleManager.create("idle");
        await waitFor(() => idleManager.get(s.id).state === "suspended", "idle suspension");
    } finally {
        idleManager.close();
    }
});

test("stats reflect pods released by snapshots", async () => {
    const a = (await call("POST", "/api/sessions", {})).body;
    const b = (await call("POST", "/api/sessions", {})).body;
    await waitState(a.id, "active");
    await waitState(b.id, "active");
    await call("POST", `/api/sessions/${b.id}/suspend`);
    await waitState(b.id, "suspended");
    const stats = (await call("GET", "/api/cluster")).body;
    assert.equal(stats.sessions, 2);
    assert.equal(stats.podsRunning, 1);
    assert.equal(stats.memoryInUseMiB, 2048);
    assert.equal(stats.memoryWithoutSnapshotsMiB, 4096);
    await call("DELETE", `/api/sessions/${a.id}`);
    await call("DELETE", `/api/sessions/${b.id}`);
});

test("event stream starts with a hello snapshot", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body.getReader();
    const { value } = await reader.read();
    controller.abort();
    const frame = new TextDecoder().decode(value);
    const event = JSON.parse(frame.replace(/^data: /, ""));
    assert.equal(event.type, "hello");
    assert.ok(Array.isArray(event.sessions));
});

test("static files are served and traversal is blocked", async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await index.text(), /Contoso\.ai/);
    assert.equal((await fetch(`${base}/%2e%2e/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/..%2Fserver.mjs`)).status, 404);
});
