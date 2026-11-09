# syntax=docker/dockerfile:1
# The MCP server served over HTTP (README, «Served over HTTP»): this package as npm publishes it, at the version
# below, running `downtrace-mcp --http`. Nothing of this directory is copied in, so the image runs what
# `npx -y @downtrace/mcp@<version>` runs. Plain HTTP on 8787: TLS, and the public origin, are the proxy's in front.
#
# Its variables are set where it runs: `DOWNTRACE_URL`, the cloud, and `DOWNTRACE_MCP_PUBLIC_URL`, the origin
# clients reach it at. Without either it exits 2 and says which.
FROM --platform=$BUILDPLATFORM node:24-alpine AS install
ARG DOWNTRACE_MCP_VERSION=0.4.0
WORKDIR /srv
# No dependencies to run, and no install scripts run.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier \
      "@downtrace/mcp@${DOWNTRACE_MCP_VERSION}"

# No shell and no package manager: Node, the package, and a user that is not root.
FROM gcr.io/distroless/nodejs24-debian12:nonroot
COPY --from=install /srv/node_modules /srv/node_modules
ENV DOWNTRACE_MCP_HOST=0.0.0.0 DOWNTRACE_MCP_PORT=8787
EXPOSE 8787
# With no shell or curl in the image, Node asks the server for a project's metadata, which it answers without
# calling the cloud.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/nodejs/bin/node", "-e", \
  "fetch('http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp/healthcheck').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["/srv/node_modules/@downtrace/mcp/dist/cli.js", "--http"]
