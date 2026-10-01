# The canary's image: the reference app and the instrumentation as `main` has them, and the bench's load generator
# and canary. One image, three commands (docker-compose.yaml). Built from the repository's root, with its lockfile.
#
# The instrumentation is the workspace's and not the published one on purpose: the reference app of `main` calls
# what `main`'s instrumentation exports, and a published version may not have it yet. What is published is watched
# where users run it.
FROM node:24-alpine
WORKDIR /srv
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN corepack enable \
 && pnpm install --frozen-lockfile --prod --filter "@downtrace/reference-app..." --filter "@downtrace/bench..." \
 && chown -R node:node /srv
USER node
