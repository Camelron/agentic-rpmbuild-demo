#!/usr/bin/env node
// In-Pod CLI for assistantd. Text for `brief` and `prompt` is read from stdin
// so arbitrary content passes through `kubectl exec -i` without shell quoting.
import fs from "node:fs";

const URL_BASE = "http://127.0.0.1:8765";
const usage = `Usage: assistantctl COMMAND

  status          Show the session, role, and whether a reply is streaming
  brief           Base Pod only: create the base session with the briefing on stdin
  fork NAME       New chat: fork the base session into a session named NAME
  reconnect       Restart the runtime and reattach to this chat's session
  quiesce [SECS]  Wait until no outbound TCP connection is open (default 45 s); run before a snapshot
  prompt          Send stdin as a message; stream NDJSON events to stdout
  log             Print the assistant log`;

async function call(method, path, body) {
    const res = await fetch(URL_BASE + path, { method, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.trim()}`);
    return text;
}

async function waitReady() {
    for (let i = 0; i < 100; i++) {
        try {
            return await call("GET", "/status");
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error("assistantd did not come up");
}

const stdin = () => fs.readFileSync(0, "utf8");
const [command, ...args] = process.argv.slice(2);

try {
    switch (command) {
        case "status":
            process.stdout.write(await waitReady());
            break;
        case "brief":
            await waitReady();
            process.stdout.write(await call("POST", "/brief", stdin()));
            break;
        case "fork":
            await waitReady();
            process.stdout.write(await call("POST", "/fork", JSON.stringify({ name: args[0] })));
            break;
        case "reconnect":
            await waitReady();
            process.stdout.write(await call("POST", "/reconnect"));
            break;
        case "quiesce":
            await waitReady();
            process.stdout.write(await call("POST", "/quiesce", JSON.stringify({ timeoutMs: Number(args[0] ?? 45) * 1000 })));
            break;
        case "prompt": {
            await waitReady();
            const res = await fetch(`${URL_BASE}/prompt`, { method: "POST", body: stdin() });
            if (!res.ok) throw new Error(`/prompt: HTTP ${res.status} ${(await res.text()).trim()}`);
            for await (const chunk of res.body) process.stdout.write(chunk);
            break;
        }
        case "log":
            process.stdout.write(fs.readFileSync(`${process.env.HOME}/assistant.log`, "utf8"));
            break;
        default:
            console.error(usage);
            process.exitCode = 2;
    }
} catch (err) {
    console.error(err.message);
    process.exitCode = 1;
}
