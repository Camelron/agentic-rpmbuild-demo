# Contoso.ai demo architecture

Every chat is a Kata Containers Pod on an AKS Kata node. An idle chat is snapshotted
to disk and its Pod deleted, which frees its memory. Clicking the chat again restores
the Pod from the snapshot, with Copilot and the conversation intact. New chats are
restores too, from a pre-briefed base snapshot.

## Components

### Live chat

```mermaid
flowchart LR
    browser(["Browser"])
    copilot[("GitHub Copilot API")]

    subgraph node["AKS Kata node (In the future on ACL)"]
        web["Contoso.ai web app"]
        kr["kata-runtime"]
        subgraph uvm["UVM"]
            subgraph pod["Pod"]
                agent["Copilot"]
            end
        end
        disk[("Snapshots on disk")]
    end

    browser <-->|"chat"| web
    web -->|"start Pod"| kr
    kr -->|"runs"| uvm
    web <-->|"prompt,<br/>streamed reply"| agent
    agent -->|"model calls"| copilot
    kr -.->|"idle 60 s: snapshot,<br/>then delete Pod"| disk

    classDef runtime fill:#2f6fdb,stroke:#1d4fa8,color:#ffffff
    classDef kata fill:#e8f1ff,stroke:#2f6fdb,stroke-width:2px,color:#0b2a5b
    classDef pod fill:#eaf7ea,stroke:#2e8b3e,color:#123d18
    classDef store fill:#fff6e0,stroke:#c88a00,color:#4a3300
    class kr runtime
    class uvm kata
    class pod pod
    class disk store
```

Each chat is a Pod inside its own UVM (Kata's utility VM), run by a kata-runtime
instance. When the chat goes idle, kata-runtime writes the UVM to disk as a snapshot,
the Pod is deleted, and the chat turns gray. A gray chat has no Pod and uses no memory:
with 5 chats and 1 in focus, only about 0.5 GiB of memory is in use instead of 2.5 GiB.

### Restoring a gray chat

```mermaid
flowchart LR
    browser(["Browser"])

    subgraph node["AKS Kata node (in the future on ACL)"]
        web["Contoso.ai web app"]
        disk[("Snapshots on disk<br/>contoso-base<br/>one per gray chat")]
        kr["kata-runtime"]
        subgraph uvm["UVM"]
            subgraph pod["Pod"]
                agent["Copilot<br/>conversation intact"]
            end
        end
    end

    browser -->|"click gray chat"| web
    web -->|"start Pod<br/>from snapshot"| kr
    disk ==>|"snapshot"| kr
    kr ==>|"restore<br/>~1.6 s"| uvm

    classDef runtime fill:#2f6fdb,stroke:#1d4fa8,color:#ffffff
    classDef kata fill:#e8f1ff,stroke:#2f6fdb,stroke-width:2px,color:#0b2a5b
    classDef pod fill:#eaf7ea,stroke:#2e8b3e,color:#123d18
    classDef store fill:#fff6e0,stroke:#c88a00,color:#4a3300
    class kr runtime
    class uvm kata
    class pod pod
    class disk store
```

A new kata-runtime instance is fed the chat's snapshot from disk and restores the UVM
where it left off, with the Pod, Copilot, and the conversation already running. New chats
start the same way, from the pre-briefed `contoso-base` snapshot.

## Chat lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant W as Contoso.ai web app
    participant K as kata-runtime
    participant P as Pod with Copilot
    participant D as Snapshots on disk

    Note over K,D: Once, at setup: a base Pod is briefed, then snapshotted as contoso-base
    Note over B,D: New chat, about 2.8 s
    B->>W: Create chat
    W->>K: Start Pod from contoso-base
    D->>K: Load contoso-base
    K->>P: Restore, Copilot already briefed
    W->>P: Fork a fresh conversation

    Note over B,D: Idle for 60 s, chat goes gray
    W->>K: Snapshot this Pod
    K->>D: Write chat snapshot
    W->>K: Delete Pod, freeing its memory

    Note over B,D: Click the gray chat, about 1.6 s
    B->>W: Resume
    W->>K: Start Pod from the chat snapshot
    D->>K: Load chat snapshot
    K->>P: Restore, conversation intact
    B->>W: Send message
    W->>P: Prompt
    P-->>B: Streamed reply
```

## Where things live

| Piece | Source |
|---|---|
| Dashboard server and session state machine | [server.mjs](server.mjs), [lib/sessions.mjs](lib/sessions.mjs) |
| Pod, snapshot, and restore calls | [lib/k8s-backend.mjs](lib/k8s-backend.mjs) |
| In-VM assistant daemon and demo tools | [agent/assistantd.mjs](agent/assistantd.mjs), [agent/tools.mjs](agent/tools.mjs) |
| Base snapshot build | [setup-base.mjs](setup-base.mjs) |
| Web Deployment, RBAC, Load Balancer | [k8s/web.yaml](k8s/web.yaml) |
| Node agent for `kata-ctl` | [k8s/node-agent.yaml](k8s/node-agent.yaml) |
