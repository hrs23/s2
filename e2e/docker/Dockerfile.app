FROM node:20-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN printf '%s\n' \
  "AUTH_SECRET=e2e-test-auth-secret-fixed" \
  "APP_URL=http://localhost:8888" \
  > .dev.vars

EXPOSE 8888

CMD ["pnpm", "exec", "react-router", "dev", "--port", "8888", "--host", "0.0.0.0"]
