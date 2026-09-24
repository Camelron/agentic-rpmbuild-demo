# Agentic Azl4 Rpmbuild Demo

This repo builds a containerized rpmbuild environment for azl4, with a headless Copilot agent (Copilot SDK) ready to iterate on a given package.

The demo is meant to demonstrate an agentic usecase for the snapshot/restore capability in AKS kata-v2. 

First a 'progenitor agent' is deployed on the cluster. The user prompts the progenitor agent to the point that it understands the tooling, local build flow utilizing azldev. In live/generic workflows this agent may be asked to first set up and smoketest its own development environment. For this demo, the target codebase (azl4) and tooling (azldev) is made available directly through the container image.

Next, the user snapshots the progenitor agent. This produces a reusable agent payload which can be leveraged in the next step.

Finally, an arbitrary number of cloned agents can be cloned as new Pods. The copilot server wakes up, reads its specific task supplied natively by k8s ConfigMaps ("the package \<nano\> is failing to build. Reproduce, iterate, confirm with a rebuild, push the change to a topic branch") and completes the task. 

## Dependencies

- https://github.com/microsoft/azurelinux/tree/4.0
- https://github.com/microsoft/azure-linux-dev-tools
- https://github.com/github/copilot-sdk

## Repository Layout

| File | Purpose |
| --- | --- |
| [build-image.sh](build-image.sh) | Builds the azldev scenario base image, then [image/Dockerfile](image/Dockerfile) on top of it |
| [image/agent/agentd.mjs](image/agent/agentd.mjs) | Agent daemon (container entrypoint): owns the Copilot SDK client and a loopback control API |
| [image/agent/agentctl](image/agent/agentctl) | In-Pod CLI for the daemon: `prompt`, `status`, `log`, and the clones' postStart `wake` |
| [image-load.sh](image-load.sh) | Streams the local image into each Kata node's containerd (erofs snapshotter); no registry needed |
| [progenitor-agent.yaml](progenitor-agent.yaml) | The progenitor Pod plus its (empty) task ConfigMap |
| [briefing.md](briefing.md) | The prompt that briefs the progenitor before it is snapshotted |
| [snapshot-create.sh](snapshot-create.sh) | Snapshots a running `kata-v2` Pod to `/var/lib/kata/snapshots/<pod>` on its node |
| [agents/](agents/) | One file per clone: a task ConfigMap and a Pod restored from `progenitor-agent` |

## Container Image Contents

The image is the azldev scenario image from `azure-linux-dev-tools/scenario/docker`
with the host bind mounts replaced by baked-in content:

```txt
/usr/local/bin/azldev      <-- azure-linux-dev-tools/out/bin/azldev
/usr/local/bin/node        <-- Node.js 22, for the agent daemon
/opt/agent/                <-- agentd.mjs, agentctl, @github/copilot-sdk 1.0.14 (bundles the Copilot CLI runtime)
/workdir/azurelinux/       <-- full clone of AZL_REPO_URL at AZL_REF, owned by testuser; WORKDIR
                               (default: Camelron/azurelinux, cameronbaird/4.0/broken-packages)
~/.gitconfig               <-- agent identity; credential helper reads /etc/copilot-auth
USER testuser:mock         <-- passwordless sudo, member of mock
CMD node /opt/agent/agentd.mjs
```

The scenario entrypoint (`sudo chown -R $PWD`) is dropped: on the erofs-backed
rootfs it would copy the whole checkout up into the writable layer.

## Agent Daemon

`agentd` is the container's main process, so it and its Copilot runtime are
captured in the snapshot. It listens on `127.0.0.1:8765` inside the Pod VM only.
The API has no authentication and approves every tool call, so it is driven
through `kubectl exec <pod> -- agentctl ...`:

| Command | What it does |
| --- | --- |
| `agentctl prompt TEXT` | Sends TEXT to the current session (the progenitor's is `progenitor`) and prints the reply |
| `agentctl status` | Shows the session ID, whether a turn is running, and the Pod name |
| `agentctl log` | Follows `~/agent.log`: prompts, tool calls, and replies |
| `agentctl wake` | Clone postStart hook, described below |

`wake` does the clone-specific start-up:

1. Copies `/etc/hostname` into the kernel hostname, which restore leaves set to
   the progenitor's name.
2. Restarts the Copilot runtime, so no connection opened from the progenitor's
   Pod IP is reused.
3. Forks the `progenitor` session (`client.rpc.sessions.fork`) into a new
   session named after the clone. Clones inherit the briefing but never write
   into the progenitor's session.
4. Sends the wake prompt with the task from `$ENTRY_PROMPT`, then returns
   without waiting for the agent.

## How Snapshot/Restore Shapes the Design

`kata-v2` restores a new Pod from a node-local snapshot when the Pod carries
`io.katacontainers.snapshot-name: <snapshot>`. See
[kata-snapshot-restore-samples](https://github.com/Camelron/kata-snapshot-restore-samples)
for the feature itself. The pieces this demo depends on were verified on a
single-node `kata-v2` cluster (VM templating enabled):

| Aspect | Behavior in a restored clone | Design consequence |
| --- | --- | --- |
| Container writable rootfs | Captured | Workspace, build outputs, and the warm mock root cache live in the image rootfs, not in volumes |
| Running processes / memory | Captured (same PIDs) | The briefed agent process carries over into every clone |
| ConfigMap volume | Refreshed from the clone's own ConfigMap, even under a different ConfigMap name | Per-clone task is a ConfigMap mounted at `/etc/agent-task`; volume name and mount path stay fixed |
| Environment variables | Must match the progenitor exactly, or the container fails with `live container identity mismatch` | `ENTRY_PROMPT` is a constant path; never put per-clone data in env |
| Secret volume | Refreshed, even if the Secret changed after the snapshot | git reads the push token from the `copilot-auth` volume |
| Pod IP, `/etc/hosts`, `/etc/hostname`, egress | Refreshed; HTTPS egress works | None |
| Guest clock | Resynced on restore | None for clones; the progenitor runs on the VM template's clock (see prerequisites) |
| Kernel hostname | Still `progenitor-agent` | `agentctl wake` copies `/etc/hostname` into it |
| Pod spec | Must stay compatible (same image, containers, securityContext, volumes); the postStart hook may differ | Clone manifests copy the progenitor spec and add only the hook |

`privileged: true` is needed because mock uses mount namespaces and chroot.
`kata-v2` sets `privileged_without_host_devices`, so these capabilities stay
inside the Pod VM.

## Demo

### Cluster prerequisites

- A `kata-v2` RuntimeClass whose handler supports snapshot/restore, with Kata
  nodes labeled `katacontainers.io/kata-runtime=true`.
- Exactly one node labeled `snapshot-sync.katacontainers.io/source=true`. The
  progenitor and all clones select it, so no snapshot distribution is needed.
  For multi-node fan-out, drop the clones' `nodeSelector` and distribute the
  snapshot with `snapshot-sync.sh` from the samples repo.
- The [kubectl node-shell](https://github.com/kvaps/kubectl-node-shell) plugin.
- A `copilot-auth` Secret holding a GitHub token that has Copilot access and
  can push to the fork. A fine-grained PAT with Copilot Requests plus Contents
  read/write on the fork works:

  ```bash
  kubectl create secret generic copilot-auth --from-literal=COPILOT_GITHUB_TOKEN=<token>
  ```

  The runtime reads the token from the `COPILOT_GITHUB_TOKEN` env var, and git
  reads the same Secret mounted at `/etc/copilot-auth`. Keep the value fixed
  between snapshot and clone start, because the env var is part of the restore
  identity check.
- A recent VM template. A Pod cloned from the template starts with the
  template's clock, so refresh it shortly before briefing the progenitor. The
  progenitor's clock should then be close enough for TLS and Copilot auth. Do
  this while no templated `kata-v2` Pods are running:

  ```bash
  NODE=<kata-node>
  CONFIG=/usr/share/defaults/kata-containers/configuration-clh-azure-runtime-rs-v2.toml
  kubectl node-shell "$NODE" -- kata-ctl --config "$CONFIG" factory destroy
  kubectl node-shell "$NODE" -- kata-ctl --config "$CONFIG" factory init
  ```

#### Pod VM sizing

`kata-v2` ignores Pod requests/limits when sizing the VM. Every `kata-v2` Pod VM
on a node gets `static_sandbox_default_workload_mem` (MiB) and
`static_sandbox_default_workload_vcpus` from
`/usr/share/defaults/kata-containers/configuration-clh-azure-runtime-rs-v2.toml`,
so the manifests set no `resources`. The default of 2 vCPU / 2 GiB builds
`nano`, but larger packages need more. To resize (affects every `kata-v2` Pod
on the node):

```bash
NODE=<kata-node>
CONFIG=/usr/share/defaults/kata-containers/configuration-clh-azure-runtime-rs-v2.toml
kubectl node-shell "$NODE" -- sed -i \
    -e 's/^static_sandbox_default_workload_mem = .*/static_sandbox_default_workload_mem = 16384/' \
    -e 's/^static_sandbox_default_workload_vcpus = .*/static_sandbox_default_workload_vcpus = 8/' \
    "$CONFIG"
# With VM templating enabled, rebuild the template at the new size:
kubectl node-shell "$NODE" -- kata-ctl --config "$CONFIG" factory destroy
kubectl node-shell "$NODE" -- kata-ctl --config "$CONFIG" factory init
```

Recreate the progenitor and its snapshot after resizing. The snapshot's memory
file scales with VM memory.

### 1. Build the image

Build `azldev` in `azure-linux-dev-tools` first (`out/bin/azldev`), then:

```bash
./build-image.sh    # AZL_REPO_URL, AZL_REF, AZLDEV_REPO, IMAGE override defaults; see --help
```

The clone's `origin` is `AZL_REPO_URL`, and agents push their topic branches
there.

To check the image on its own, run the whole build flow in Docker with no host mounts:

```bash
docker run --rm --privileged agentic-rpmbuild:dev azldev comp build -p nano
```

### 2. Put the image on the Kata nodes

The manifests use `image: agentic-rpmbuild:dev` with `imagePullPolicy: Never`,
so source and clones are guaranteed to use the same image:

```bash
./image-load.sh     # every Ready node labeled katacontainers.io/kata-runtime=true
```

Registry alternative (not yet exercised): push to ACR, `az aks update --attach-acr <acr>`,
then point `image:` in every manifest at the ACR reference, pinned by digest.

### 3. Start and brief the progenitor

```bash
kubectl apply -f progenitor-agent.yaml
kubectl wait --for=condition=Ready pod/progenitor-agent --timeout=60s
```

[briefing.md](briefing.md) covers the workspace, `AGENTS.md` and its skills,
the inner loop, and git conventions. It also has the agent build the healthy
package `bc`, which smoke-tests azldev and mock inside the Pod VM and leaves a
warm mock cache for every clone. Each run gets a random branch prefix so it
does not collide with branches from earlier runs:

```bash
RUN_ID=$(openssl rand -hex 3)
kubectl exec progenitor-agent -- agentctl prompt "$(sed "s/RUN_ID/$RUN_ID/g" briefing.md)"
kubectl exec progenitor-agent -- agentctl status   # wait for "busy":false before snapshotting
```

### 4. Snapshot the progenitor

```bash
./snapshot-create.sh progenitor-agent       # add --replace to refresh
```

The progenitor keeps running afterwards.

### 5. Spawn the clones

Clones already know what to do. The fixer manifests vary only in their ConfigMap:

```bash
kubectl apply -f agents/
kubectl wait --for=condition=Ready pod -l rpmbuild-agent/role=clone --timeout=180s
kubectl exec nano-fixer -- agentctl log                             # watch one agent work
git ls-remote https://github.com/Camelron/azurelinux.git 'refs/heads/agent/*'
```

To add an agent, copy a file in [agents/](agents/) and change only the names,
the ConfigMap `task.md`, and the ConfigMap reference.

Each clone's postStart hook runs `agentctl wake`, which forks the briefed
session and sends:

```txt
Wake up. You are <pod>, a clone of the progenitor agent you remember being.
Your scope, from /etc/agent-task/task.md: <task>
Work on the fix. The end result should be a topic branch off of the current
azurelinux branch, containing the fix, pushed to origin. Do not open a pull
request. Finish by summarizing the root cause, the fix, how you verified it,
and the pushed branch name.
```

### Cleanup

```bash
kubectl delete -f agents/ -f progenitor-agent.yaml --ignore-not-found --timeout=60s
```

The snapshot stays on the node under `/var/lib/kata/snapshots/progenitor-agent`.

## Measured Results

Single `Standard_D16as_v5` node, VM templating on, 2 vCPU / 2 GiB Pod VMs, 10
clones fixing the 10 packages broken on `cameronbaird/4.0/broken-packages`:

| Step | Result |
| --- | --- |
| Briefing (read `AGENTS.md` and skills, build `bc`, summarize workflow) | 2m25s-2m32s |
| `snapshot-create.sh` of the briefed progenitor | ~47 s, 4.8 GB artifact |
| One clone, apply to Ready (includes the postStart session fork) | 4.9 s |
| Ten clones applied together, until all Ready | 86 s |
| Clones that pushed a verified fix | 9 of 10, each 5-9.5 min after waking |
| `vim` | Still in its final rebuild after 20 min; stopped before pushing |

Each finished agent reproduced its failure and fixed the component overlay. It
then rebuilt, smoke-tested the RPM in a mock chroot, refreshed the lock, and
pushed.

## Caveats and Open Items

- **Writable layer is 10 GiB** (containerd erofs `default_size`). That holds the
  mock chroot and build tree; very large packages will not fit. Disk-backed
  `emptyDir` is not captured by snapshots, so it is not a workaround.
- **Push credentials.** The `copilot-auth` Secret reaches each Pod two ways.
  The `COPILOT_GITHUB_TOKEN` env var authenticates the Copilot runtime. The
  runtime strips that variable from the shells it runs for the agent, so git
  pushes read the same Secret mounted at `/etc/copilot-auth`. A Secret volume is
  refreshed on restore; an env var must keep its snapshot-time value, or clones
  fail to start. Agents can read the token file, so scope the token to Copilot
  and the fork.
- **Branch names.** The task ConfigMaps name branches `agent/<package>-fix`, and
  the briefing asks for an `agent/<RUN_ID>/` prefix. In the measured run, 5 of 10
  agents used the task's plain name. Change the names in [agents/](agents/)
  if branches from an earlier run are still on the fork.
- **Concurrency.** Every clone keeps a private copy of its writable disk on the
  node (1.2-1.7 GiB each after a few minutes of building; 24 GB for 10 clones).
  Size node storage for the number of clones.

