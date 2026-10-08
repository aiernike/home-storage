#!/bin/sh
# 家庭收纳同步服务 - NAS 一键部署脚本
# 用法：把 server 目录整个传到 NAS，然后 sh deploy.sh

set -e

cd "$(dirname "$0")"

echo "=================================================="
echo "  家庭收纳 · NAS 同步服务部署"
echo "=================================================="
echo ""

# 检查 docker
if ! command -v docker >/dev/null 2>&1; then
  echo "[错误] 没有找到 docker 命令。"
  echo "       请先在 NAS 上安装 Docker（群晖套件中心 / 威联通 Container Station）。"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1 && ! docker-compose version >/dev/null 2>&1; then
  echo "[错误] 没有找到 docker compose。请确认 Docker 版本支持 compose。"
  exit 1
fi

# 生成 .env
if [ ! -f .env ]; then
  echo "[1/4] 首次部署，生成配置文件 .env"
  cp .env.example .env
  # 生成随机密钥
  RAND=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if sed --version >/dev/null 2>&1; then
    sed -i "s|JWT_SECRET=.*|JWT_SECRET=${RAND}|" .env
  else
    sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=${RAND}|" .env
  fi
  echo "      已自动生成随机 JWT 密钥"
  echo ""
  echo "      请编辑 .env 修改数据库密码（当前为默认值 home123456）："
  echo "        vim .env"
  echo ""
  read -p "      修改完成后按回车继续…" dummy
else
  echo "[1/4] 已存在 .env，跳过生成"
fi

# 创建数据目录
echo "[2/4] 准备数据目录"
mkdir -p data/postgres
echo "      数据将保存在：$(pwd)/data/postgres"

# 构建并启动
echo "[3/4] 构建镜像并启动服务（首次约需 1-3 分钟）"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
else
  docker-compose up -d --build
fi

# 健康检查
echo "[4/4] 等待服务就绪"
PORT=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-8787}
i=0
while [ $i -lt 40 ]; do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo ""
    echo "=================================================="
    echo "  部署成功"
    echo "=================================================="
    echo ""
    echo "  本机地址： http://127.0.0.1:${PORT}"
    IP=$(hostname -i 2>/dev/null | awk '{print $1}' || echo "你的NAS的IP")
    echo "  局域网地址：http://${IP}:${PORT}"
    echo ""
    echo "  接下来："
    echo "  1. 打开家庭收纳客户端 → 设置 → 数据同步"
    echo "  2. 服务器地址填 http://${IP}:${PORT}"
    echo "  3. 点「注册新账号」创建账号，然后「登录并保存」"
    echo ""
    echo "  账号建好后，建议在 .env 里把 ALLOW_REGISTER 改为 false"
    echo "  然后执行：docker compose up -d  （或 docker-compose up -d）"
    echo ""
    exit 0
  fi
  i=$((i + 1))
  printf "."
  sleep 2
done

echo ""
echo "[警告] 服务启动较慢或未就绪，请查看日志："
echo "  docker compose logs -f api"
echo ""
exit 1
