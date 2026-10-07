FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "serve"]
