# syntax=docker/dockerfile:1
# Contoso.ai dashboard server, run in the cluster (k8s/web.yaml) so it can call
# chat daemons over the Pod network. kubectl manages Pods with the in-cluster
# service account.
FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.35.6
ARG KUBECTL_SHA256=5d11e2ba01ea68ffd053f56e27738e2b4330013ee67f7e46c6da6c585d3c9926
ADD --checksum=sha256:${KUBECTL_SHA256} --chmod=0755 https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl /usr/local/bin/kubectl

WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public

USER node
ENV HOME=/tmp
EXPOSE 8080
CMD ["node", "server.mjs"]
