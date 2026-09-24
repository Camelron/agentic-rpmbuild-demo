# Layers azldev and an azurelinux checkout onto the azldev scenario image
# (azure-linux-dev-tools/scenario/docker) so no host mounts are needed.
ARG BASE_IMAGE=azldev-scenario:agent
FROM ${BASE_IMAGE}

ARG AZL_REPO_URL=https://github.com/microsoft/azurelinux.git
ARG AZL_REF=4.0

USER root
COPY --from=azldev --chmod=0755 azldev /usr/local/bin/azldev
RUN install -d -o testuser -g mock /workdir

# Full history: rpmautospec derives Release/%changelog from git log.
USER testuser:mock
RUN git clone --single-branch --branch "${AZL_REF}" "${AZL_REPO_URL}" /workdir/azurelinux

WORKDIR /workdir/azurelinux

# The base entrypoint runs `chown -R $PWD`, which would copy the whole
# checkout up into the writable layer; the tree is already owned by testuser.
ENTRYPOINT []
CMD ["sleep", "infinity"]
