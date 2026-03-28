FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
ENV PORT=3000
ENV DB_PATH=/app/data/finance.db
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
