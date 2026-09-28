#!/usr/bin/env node
// Builds the contoso-base snapshot every chat is restored from: start a base
// Pod, brief the assistant (agent/briefing.txt), snapshot it, delete the Pod.
// Runs from outside the cluster, so it drives the daemon through kubectl exec.
import fs from "node:fs";
import { KubernetesBackend } from "./lib/k8s-backend.mjs";

const backend = new KubernetesBackend({
    namespace: process.env.CONTOSO_NAMESPACE,
    image: process.env.CONTOSO_IMAGE,
    podMemoryMiB: Number(process.env.CONTOSO_POD_MEMORY_MIB ?? 512),
});
const pod = "contoso-base";
const briefing = fs.readFileSync(new URL("./agent/briefing.txt", import.meta.url), "utf8");
const step = async (label, fn) => {
    const t0 = Date.now();
    const result = await fn();
    console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return result;
};

await step("delete old base Pod", () => backend.deletePod(pod));
await step("start base Pod", async () => {
    await backend.createPod(pod, null, "base");
    await backend.waitReady(pod);
});
const reply = await step("brief", () => backend.exec(pod, ["assistantctl", "brief"], briefing));
console.log(`  ${JSON.parse(reply).reply}`);
const quiet = await step("quiesce", async () => JSON.parse(await backend.exec(pod, ["assistantctl", "quiesce", "45"])));
console.log(`  ${JSON.stringify(quiet)}`);
await step(`snapshot as ${backend.baseSnapshot}`, () => backend.snapshotPod(pod, backend.baseSnapshot));
await step("delete base Pod", () => backend.deletePod(pod));
