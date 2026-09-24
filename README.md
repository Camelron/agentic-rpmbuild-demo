# Agentic Azl4 Rpmbuild Demo

This repo builds a containerized rpmbuild environment for azl4, with copilot CLI in server mode ready to iterate on a given package.

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
| [image-load.sh](image-load.sh) | Streams the local image into each Kata node's containerd (erofs snapshotter); no registry needed |
| [progenitor-agent.yaml](progenitor-agent.yaml) | The progenitor Pod plus its (empty) task ConfigMap |
| [snapshot-create.sh](snapshot-create.sh) | Snapshots a running `kata-v2` Pod to `/var/lib/kata/snapshots/<pod>` on its node |
| [agents/](agents/) | One file per clone: a task ConfigMap and a Pod restored from `progenitor-agent` |

## Container Image Contents

The image is the azldev scenario image from `azure-linux-dev-tools/scenario/docker`
with the host bind mounts replaced by baked-in content:

```txt
/usr/local/bin/azldev      <-- azure-linux-dev-tools/out/bin/azldev
/workdir/azurelinux/       <-- full clone of azurelinux (AZL_REF, default 4.0), owned by testuser; WORKDIR
USER testuser:mock         <-- passwordless sudo, member of mock
CMD sleep infinity         <-- placeholder until the copilot server becomes the entrypoint
```

The scenario entrypoint (`sudo chown -R $PWD`) is dropped: on the erofs-backed
rootfs it would copy the whole checkout up into the writable layer.

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
| Pod IP, `/etc/hosts`, `/etc/hostname`, egress | Refreshed; HTTPS egress works | None |
| Guest clock | Resynced on restore | None for clones (see caveats for the progenitor) |
| Kernel hostname | Still `progenitor-agent` | Do not derive agent identity from `gethostname()`; a privileged hook can copy `/etc/hostname` into it |
| Pod spec | Must stay compatible (same image, containers, securityContext, volumes) | Clone manifests copy the progenitor spec verbatim |

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
./build-image.sh    # AZLDEV_REPO, IMAGE, AZL_REF, ... override defaults; see --help
```

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

Briefing is still a placeholder until the copilot server is in the image. For
now, a warm-up build stands in for it: it proves azldev and mock work inside the
Pod VM and leaves a warm mock root cache for every clone to inherit.

```bash
kubectl exec progenitor-agent -- azldev comp build -p nano
```

```bash
# TODO: converse with the progenitor's copilot server: its workspace
# (/workdir/azurelinux), the skills in .agents/skills, the inner loop
# (azldev comp build -p <pkg>), and the branch/push conventions.
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
kubectl wait --for=condition=Ready pod/nano-fixer pod/cloud-hypervisor-fixer --timeout=60s
kubectl exec nano-fixer -- sh -c 'cat "$ENTRY_PROMPT"'
```

To add an agent, copy a file in [agents/](agents/) and change only the names,
the ConfigMap `task.md`, and the ConfigMap reference.

A k8s lifecycle postStart hook, common across all agents, will trigger the prompt immediately (TODO):

```txt
"Wake up. Read your scope from the supplied config $ENTRY_PROMPT and work on the fix. The end result should be a topic branch off of the current azurelinux branch, containing the fix."
```

### Cleanup

```bash
kubectl delete -f agents/ -f progenitor-agent.yaml --ignore-not-found --timeout=60s
```

The snapshot stays on the node under `/var/lib/kata/snapshots/progenitor-agent`.

## Measured Results

Single `Standard_D16as_v5` node, VM templating on, 2 vCPU / 2 GiB Pod VMs:

| Step | Result |
| --- | --- |
| Progenitor Ready (cold, from template) | ~3 s |
| `azldev comp build -p nano` in the progenitor | 3m17s (includes two ~60 s mock root inits) |
| `snapshot-create.sh` after the build | ~44 s end to end, 4.6 GB artifact |
| Two clones Ready in parallel | ~4-6 s |
| Rebuild of nano in a clone | 1m23s (mock root init ~9 s from the inherited cache) |

## Caveats and Open Items

Kata-side issues are tracked with evidence in [kata-bugs.md](kata-bugs.md).

- **Progenitor clock skew.** A VM cloned from the node's VM template starts
  with the template's clock (observed about 50 h behind). Each snapshot pause
  adds roughly the pause time on top. Restored clones are resynced. Until this
  is fixed, the progenitor's build timestamps and any commits it makes carry
  wrong dates, and TLS certificates issued after the template was created would
  fail validation.
- **Writable layer is 10 GiB** (containerd erofs `default_size`). That holds the
  mock chroot and build tree; very large packages will not fit. Disk-backed
  `emptyDir` is not captured by snapshots, so it is not a workaround.
- **Task prompts are placeholders.** `nano` currently builds cleanly on `4.0`;
  the demo needs genuinely failing packages or a seeded breakage.
- **Push credentials.** Secret-volume refresh on restore is not yet verified.
  Clones will need per-clone or shared credentials and a fork remote to push to.
- **Next:** headless copilot server as the entrypoint, postStart prompt hook.

