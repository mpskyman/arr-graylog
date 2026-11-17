FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# No runtime dependencies, so there is no install step.
COPY package.json ./
COPY src ./src

USER node

CMD ["node", "src/index.js"]
