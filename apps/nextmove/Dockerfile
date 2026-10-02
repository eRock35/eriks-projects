FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

# One image, two entrypoints. The Cloud Run SERVICE runs this default
# command; the Cloud Run JOBS override it with `node jobs/run.js daily`
# (or weekly / comp-refresh). See CLAUDE.md "One image, two entrypoints".
CMD ["node", "server.js"]
