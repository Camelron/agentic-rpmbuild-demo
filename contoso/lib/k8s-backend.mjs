// SessionBackend on the real cluster: each chat is a kata-v2 Pod restored
// from a Kata snapshot, driven through kubectl. Snapshot and cleanup commands
// run on the node via the contoso-node-agent DaemonSet (k8s/node-agent.yaml).
import { spawn } from "node:child_process";

const SNAPSHOT_NAME = /^contoso-(base|[0-9a-f]{8}-g[0-9]+)$/;

// Executed in the node's host namespaces; arguments are validated again there.
const SNAPSHOT_SCRIPT = `set -eu
uid="$1"; name="$2"
echo "$name" | grep -Eq '^contoso-(base|[0-9a-f]{8}-g[0-9]+)$' || { echo "bad snapshot name" >&2; exit 2; }
sandbox=$(crictl pods --state Ready --label "io.kubernetes.pod.uid=$uid" --no-trunc -q)
[ -n "$sandbox" ] || { echo "no Ready sandbox for Pod $uid" >&2; exit 1; }
rm -rf -- "/var/lib/kata/snapshots/$name"
kata-ctl snapshot create --sandbox-id "$sandbox" --path "/var/lib/kata/snapshots/$name" >/dev/null
`;

const DELETE_SCRIPT = `set -eu
for name in "$@"; do
    echo "$name" | grep -Eq '^contoso-(base|[0-9a-f]{8}-g[0-9]+)$' || { echo "bad snapshot name" >&2; exit 2; }
    rm -rf -- "/var/lib/kata/snapshots/$name"
done
`;

const LIST_SCRIPT = `ls /var/lib/kata/snapshots | grep -E '^contoso-[0-9a-f]{8}-g[0-9]+$' || true
`;

/** @implements {import("./backend.mjs").SessionBackend} */
export class KubernetesBackend {
    constructor({
        namespace = "default",
        image = "contoso-assistant:dev",
        baseSnapshot = "contoso-base",
        secretName = "copilot-auth",
        nodeSelector = { "snapshot-sync.katacontainers.io/source": "true" },
        podMemoryMiB = 512,
        readyTimeoutMs = 120_000,
        kubectl = "kubectl",
    } = {}) {
        Object.assign(this, { namespace, image, baseSnapshot, secretName, nodeSelector, podMemoryMiB, readyTimeoutMs, kubectlBin: kubectl });
        this.nodeAgents = new Map();
    }

    podName(s) {
        return `contoso-${s.id}-g${s.generation}`;
    }

    // Base and chat Pods must share this spec: restore rejects any container difference.
    manifest(name, { snapshot = null, role = "session" } = {}) {
        return {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
                name,
                namespace: this.namespace,
                labels: { "app.kubernetes.io/name": "contoso-assistant", "contoso.ai/role": role },
                annotations: snapshot ? { "io.katacontainers.snapshot-name": snapshot } : {},
            },
            spec: {
                runtimeClassName: "kata-v2",
                nodeSelector: this.nodeSelector,
                restartPolicy: "Never",
                automountServiceAccountToken: false,
                terminationGracePeriodSeconds: 1,
                containers: [{
                    name: "assistant",
                    image: this.image,
                    imagePullPolicy: "Never",
                    env: [{
                        name: "COPILOT_GITHUB_TOKEN",
                        valueFrom: { secretKeyRef: { name: this.secretName, key: "COPILOT_GITHUB_TOKEN" } },
                    }],
                }],
            },
        };
    }

    async start(s) {
        const name = this.podName(s);
        await this.createPod(name, this.baseSnapshot);
        await this.waitReady(name);
        await this.exec(name, ["assistantctl", "fork", `contoso-${s.id}`]);
        return { podName: name };
    }

    async suspend(s) {
        const snapshotName = s.podName;
        await this.quiesce(s.podName);
        await this.snapshotPod(s.podName, snapshotName);
        // Pod teardown takes ~11 s and nothing depends on it; resume uses a new Pod name.
        await this.deletePod(s.podName, { wait: false });
        if (s.snapshotName && s.snapshotName !== snapshotName) {
            await this.deleteSnapshots(await this.podNode(null), [s.snapshotName]).catch(() => {});
        }
        return { snapshotName };
    }

    // The restored daemon still holds the chat's session; quiesce kept dead connections out of the snapshot.
    async resume(s) {
        const name = this.podName(s);
        await this.createPod(name, s.snapshotName);
        await this.waitReady(name);
        return { podName: name };
    }

    prompt(s, text, onDelta) {
        return new Promise((resolve, reject) => {
            const child = this.spawnKubectl(["exec", "-i", "-n", this.namespace, s.podName, "--", "assistantctl", "prompt"]);
            let full = "";
            let buffer = "";
            let failure = null;
            let stderr = "";
            const emit = (text) => {
                full += text;
                onDelta(text);
            };
            const handle = (line) => {
                if (!line.trim()) return;
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }
                if (event.type === "delta") emit(event.text);
                else if (event.type === "tool") emit(`${full && !full.endsWith("\n") ? "\n" : ""}→ ${event.name}(${summarize(event.arguments)})\n`);
                else if (event.type === "done" && !full.trim() && event.content) emit(event.content);
                else if (event.type === "error") failure = event.message;
            };
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop();
                lines.forEach(handle);
            });
            child.stderr.on("data", (chunk) => (stderr += chunk));
            child.on("error", reject);
            child.on("close", (code) => {
                handle(buffer);
                if (failure || code !== 0) reject(new Error(failure ?? (stderr.trim() || `kubectl exec exited ${code}`)));
                else resolve(full);
            });
            child.stdin.end(text);
        });
    }

    async destroy(s) {
        if (s.podName) await this.deletePod(s.podName);
        if (s.snapshotName) await this.deleteSnapshots(await this.podNode(null), [s.snapshotName]);
    }

    info() {
        return { podMemoryMiB: this.podMemoryMiB };
    }

    // Chats are held in memory, so any chat Pod or snapshot left from an earlier run is orphaned.
    async cleanupOrphans() {
        const pods = (await this.kubectl(["get", "pods", "-n", this.namespace, "-l", "contoso.ai/role=session", "-o", "name"])).trim();
        if (pods) await this.kubectl(["delete", "-n", this.namespace, "--wait=true", "--timeout=60s", ...pods.split("\n")]);
        const node = await this.podNode(null);
        const snapshots = (await this.onNode(node, LIST_SCRIPT, [])).trim().split("\n").filter(Boolean);
        if (snapshots.length) await this.deleteSnapshots(node, snapshots);
        return { pods: pods ? pods.split("\n").length : 0, snapshots: snapshots.length };
    }

    // --- Pods -----------------------------------------------------------------

    async createPod(name, snapshot, role = "session") {
        await this.kubectl(["create", "-f", "-"], JSON.stringify(this.manifest(name, { snapshot, role })));
    }

    async deletePod(name, { wait = true } = {}) {
        await this.kubectl(["delete", "pod", "-n", this.namespace, name, "--ignore-not-found", `--wait=${wait}`, "--timeout=60s"]);
    }

    async waitReady(name) {
        const deadline = Date.now() + this.readyTimeoutMs;
        while (Date.now() < deadline) {
            const pod = JSON.parse(await this.kubectl(["get", "pod", "-n", this.namespace, name, "-o", "json"]));
            if (pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")) return pod;
            const state = pod.status?.containerStatuses?.[0]?.state ?? {};
            if (state.terminated || pod.status?.phase === "Failed") {
                throw new Error(`Pod ${name} failed: ${state.terminated?.message ?? state.terminated?.reason ?? pod.status?.phase}`.slice(0, 500));
            }
            await sleep(250);
        }
        const events = await this.kubectl(["get", "events", "-n", this.namespace, "--field-selector", `involvedObject.name=${name},type=Warning`, "-o", "jsonpath={.items[-1:].message}"]).catch(() => "");
        throw new Error(`Pod ${name} not Ready after ${this.readyTimeoutMs / 1000}s${events ? `: ${events.slice(0, 400)}` : ""}`);
    }

    exec(pod, command, input) {
        return this.kubectl(["exec", input === undefined ? "" : "-i", "-n", this.namespace, pod, "--", ...command].filter(Boolean), input);
    }

    // Waits for the Pod's outbound connections to close; returns {quiet, open, waitedMs}.
    async quiesce(pod, timeoutSeconds = 45) {
        return JSON.parse(await this.exec(pod, ["assistantctl", "quiesce", String(timeoutSeconds)]));
    }

    // --- Node operations ------------------------------------------------------

    async snapshotPod(podName, snapshotName) {
        if (!SNAPSHOT_NAME.test(snapshotName)) throw new Error(`invalid snapshot name ${snapshotName}`);
        const pod = JSON.parse(await this.kubectl(["get", "pod", "-n", this.namespace, podName, "-o", "json"]));
        await this.onNode(pod.spec.nodeName, SNAPSHOT_SCRIPT, [pod.metadata.uid, snapshotName]);
    }

    async deleteSnapshots(node, names) {
        const valid = names.filter((n) => SNAPSHOT_NAME.test(n));
        if (valid.length) await this.onNode(node, DELETE_SCRIPT, valid);
    }

    // Snapshots are node-local and every chat Pod lands on the one selected node.
    async podNode(podName) {
        if (podName) {
            return (await this.kubectl(["get", "pod", "-n", this.namespace, podName, "-o", "jsonpath={.spec.nodeName}"])).trim();
        }
        const selector = Object.entries(this.nodeSelector).map(([k, v]) => `${k}=${v}`).join(",");
        const nodes = (await this.kubectl(["get", "nodes", "-l", selector, "-o", "jsonpath={.items[*].metadata.name}"])).trim().split(/\s+/).filter(Boolean);
        if (nodes.length !== 1) throw new Error(`expected one node matching ${selector}, found ${nodes.length}`);
        return nodes[0];
    }

    async onNode(node, script, args) {
        let agent = this.nodeAgents.get(node);
        if (!agent) {
            agent = (await this.kubectl(["get", "pods", "-n", this.namespace, "-l", "app=contoso-node-agent", "--field-selector", `spec.nodeName=${node},status.phase=Running`, "-o", "jsonpath={.items[0].metadata.name}"])).trim();
            if (!agent) throw new Error(`no contoso-node-agent Pod on node ${node}; apply k8s/node-agent.yaml`);
            this.nodeAgents.set(node, agent);
        }
        try {
            return await this.kubectl(["exec", "-i", "-n", this.namespace, agent, "--", "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-s", "--", ...args], script);
        } catch (err) {
            this.nodeAgents.delete(node);
            throw err;
        }
    }

    // --- kubectl --------------------------------------------------------------

    spawnKubectl(args) {
        return spawn(this.kubectlBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    }

    kubectl(args, input) {
        return new Promise((resolve, reject) => {
            const child = this.spawnKubectl(args);
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (c) => (stdout += c));
            child.stderr.on("data", (c) => (stderr += c));
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0) resolve(stdout);
                else reject(new Error(`kubectl ${args.slice(0, 3).join(" ")}: ${(stderr || stdout).trim().split("\n").slice(-2).join(" ")}`.slice(0, 600)));
            });
            child.stdin.end(input ?? "");
        });
    }
}

function summarize(args = {}) {
    return Object.entries(args)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? (v.length > 40 ? `${v.slice(0, 37)}…` : v) : JSON.stringify(v)}`)
        .join(", ");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
