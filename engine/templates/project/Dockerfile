# Runs the remake on Google Cloud Run: the passcode gate plus the files in site/.
FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY site ./site
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.js"]
