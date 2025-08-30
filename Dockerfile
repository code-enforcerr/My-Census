# ✅ Use official Playwright image with Chromium + all required libs
FROM mcr.microsoft.com/playwright:v1.54.1-jammy

# Set work directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first (better caching)
COPY package*.json ./

# Install dependencies (skip dev dependencies for production)
RUN npm install --omit=dev

# Copy the rest of your source code
COPY . .

# Environment
ENV NODE_ENV=production

# Start your Telegram bot
CMD ["node", "bot.js"]