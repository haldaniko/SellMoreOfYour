FROM node:20-alpine AS base

WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && npm ci

FROM base AS dev

ENV NODE_ENV=development
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

FROM base AS build

COPY . .
RUN npm run build

FROM node:20-alpine AS prod

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=base /app/node_modules ./node_modules
RUN npm prune --omit=dev && apk add --no-cache su-exec
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
EXPOSE 4000
CMD ["npm", "run", "start"]
