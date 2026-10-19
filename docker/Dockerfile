# syntax=docker/dockerfile:1.7
# soltape: one image, three commands (service | replay | bench). See docs/llds/delivery.md.
# @spec DLV-IMG-001, DLV-IMG-002, DLV-IMG-003, DLV-IMG-004

ARG NODE_VERSION=24
ARG RUST_VERSION=1.99.0
ARG PNPM_VERSION=10.34.7

# ---- build: Rust addon + TypeScript ------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm AS build
ARG RUST_VERSION
ARG PNPM_VERSION
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} \
 && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/service/package.json apps/service/
COPY apps/replay/package.json apps/replay/
COPY packages/shared/package.json packages/shared/
COPY packages/decoder/package.json packages/decoder/
COPY bench/package.json bench/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target,target=/src/packages/decoder/native/target \
    pnpm --filter @soltape/decoder build:native
RUN pnpm build && test -f apps/service/dist/main.js && test -f bench/dist/run.js

# ---- production dependencies only ---------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/service/package.json apps/service/
COPY apps/replay/package.json apps/replay/
COPY packages/shared/package.json packages/shared/
COPY packages/decoder/package.json packages/decoder/
COPY bench/package.json bench/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime -------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG SOLTAPE_COMMIT=unknown
ENV NODE_ENV=production SOLTAPE_COMMIT=${SOLTAPE_COMMIT} PORT=8080
WORKDIR /app
COPY --from=deps --chown=node:node /app ./
COPY --from=build --chown=node:node /src/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /src/packages/decoder/dist packages/decoder/dist
COPY --from=build --chown=node:node /src/packages/decoder/native/*.node packages/decoder/native/
COPY --from=build --chown=node:node /src/packages/decoder/fixtures packages/decoder/fixtures
COPY --from=build --chown=node:node /src/apps/service/dist apps/service/dist
COPY --from=build --chown=node:node /src/apps/service/public apps/service/public
COPY --from=build --chown=node:node /src/apps/replay/dist apps/replay/dist
COPY --from=build --chown=node:node /src/bench/dist bench/dist
COPY --chown=node:node config config
COPY --chown=node:node fixtures fixtures
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/soltape
RUN mkdir -p bench/results && chown node:node bench/results
USER node
EXPOSE 8080 8899
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/soltape"]
CMD ["service"]
