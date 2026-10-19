FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "start"]
