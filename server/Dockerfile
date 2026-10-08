FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY index.js ./

# 手机版网页（不装 App 直接用）。少了这一行，/app/ 会返回「还没上传」的提示页，
# 状态页上的手机版入口也就点不开了。
COPY public ./public

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:8787/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
