# The lab host plus every trial app, each with its own dependencies.
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install --omit=dev --no-audit --no-fund \
 && for d in apps/*/; do (cd "$d" && npm install --omit=dev --no-audit --no-fund) || exit 1; done
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
