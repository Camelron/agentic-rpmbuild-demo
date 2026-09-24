# Layers azldev, an azurelinux checkout, and the Copilot agent daemon onto the
# azldev scenario image (azure-linux-dev-tools/scenario/docker) so no host
# mounts are needed.
ARG BASE_IMAGE=azldev-scenario:agent
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS agent-deps
WORKDIR /opt/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev

FROM ${BASE_IMAGE}

ARG AZL_REPO_URL=https://github.com/Camelron/azurelinux.git
ARG AZL_REF=cameronbaird/4.0/broken-packages

USER root
COPY --from=azldev --chmod=0755 azldev /usr/local/bin/azldev
COPY --from=agent-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-deps /opt/agent/node_modules /opt/agent/node_modules
RUN install -d -o testuser -g mock /workdir

# Full history: rpmautospec derives Release/%changelog from git log.
USER testuser:mock
RUN git clone --single-branch --branch "${AZL_REF}" "${AZL_REPO_URL}" /workdir/azurelinux

# The Copilot runtime strips COPILOT_GITHUB_TOKEN from tool shells, so pushes read
# the copilot-auth Secret volume instead.
RUN git config --global user.name "rpmbuild agent" && \
    git config --global user.email "rpmbuild-agent@users.noreply.github.com" && \
    git config --global credential.https://github.com.helper \
        '!f() { test "$1" = get && echo username=x-access-token && echo "password=$(cat /etc/copilot-auth/COPILOT_GITHUB_TOKEN)"; }; f'

USER root
COPY agent/package.json agent/agentd.mjs /opt/agent/
COPY --chmod=0755 agent/agentctl /opt/agent/
RUN ln -s /opt/agent/agentctl /usr/local/bin/agentctl

USER testuser:mock
WORKDIR /workdir/azurelinux

# The base entrypoint runs `chown -R $PWD`, which would copy the whole
# checkout up into the writable layer; the tree is already owned by testuser.
ENTRYPOINT []
CMD ["node", "/opt/agent/agentd.mjs"]
