# Playwright needs its system dependencies — easiest is the official image.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build && npm cache clean --force

EXPOSE 3000
CMD ["node", "dist/main.js"]
