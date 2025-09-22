# Dockerfile
FROM node:20-alpine

# Install minimal build tools needed by some native deps (better-sqlite3)
RUN apk add --no-cache python3 make g++ bash

WORKDIR /app

# Copy package descriptors first to cache npm install
COPY package.json package-lock.json* ./

# Install dependencies (production)
RUN npm install --production

# Copy app source
COPY . .

# Ensure port envvar default
ENV PORT=3000
EXPOSE 3000

# Start command
CMD ["npm", "start"]
