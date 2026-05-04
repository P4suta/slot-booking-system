# syntax=docker/dockerfile:1.7
# Lean Node-only dev image for the TypeScript / Cloudflare stack.
# Coexists with the tmpl-managed Dockerfile (which carries the Rust
# toolchain for occasional template-engine work).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        ripgrep \
        jq \
        unzip \
        xz-utils \
    && corepack enable

ARG JUST_VERSION=1.36.0
RUN curl -fsSL https://just.systems/install.sh \
    | bash -s -- --to /usr/local/bin --tag ${JUST_VERSION}

ARG LEFTHOOK_VERSION=2.1.6
RUN curl -fsSL \
    "https://github.com/evilmartians/lefthook/releases/download/v${LEFTHOOK_VERSION}/lefthook_${LEFTHOOK_VERSION}_Linux_x86_64.gz" \
    | gunzip > /usr/local/bin/lefthook \
    && chmod +x /usr/local/bin/lefthook

FROM base AS dev

ENV PNPM_HOME=/workspace/.pnpm-home \
    PATH=/workspace/.pnpm-home:/usr/local/bin:/usr/bin:/bin

RUN mkdir -p /workspace/.pnpm-home /workspace/.pnpm-store

WORKDIR /workspace
CMD ["bash"]

FROM dev AS ci
