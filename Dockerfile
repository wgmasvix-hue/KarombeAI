# Use Node 20 slim (same as your local version)
FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the application
COPY . .

# Start the server
CMD ["node", "server.js"]# ── Build stage: install dependencies with npm ──
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --production

# ── Run stage: copy app and start ──
FROM node:20-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]