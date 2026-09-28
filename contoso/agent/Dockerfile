# Slim Contoso.ai assistant: Node, the Copilot SDK (which bundles the Copilot
# CLI runtime), assistantd, and its simulated tools. No build tooling.
FROM node:22-bookworm-slim

# The Copilot runtime verifies TLS against the system CA store, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/assistant
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY assistantd.mjs tools.mjs ./
COPY --chmod=0755 assistantctl.mjs ./
RUN ln -s /opt/assistant/assistantctl.mjs /usr/local/bin/assistantctl

USER node
WORKDIR /home/node
CMD ["node", "/opt/assistant/assistantd.mjs"]
