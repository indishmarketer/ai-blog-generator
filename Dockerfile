# Dockerfile - simple Node app container
FROM node:20-alpine
WORKDIR /app

# Copy package.json first so Docker caches npm install step
COPY package.json package-lock.json* ./

# Install dependencies (production)
RUN npm install --production

# Copy rest of the repo
COPY . .

# Ensure port envvar default
ENV PORT=3000
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
