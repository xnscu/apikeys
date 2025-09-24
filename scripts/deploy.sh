#!/bin/bash

# Gemini API Keys 连接池应用部署脚本

echo "🚀 开始部署Gemini API Keys连接池应用..."

# 检查wrangler是否已安装
if ! command -v wrangler &> /dev/null; then
    echo "❌ 错误: 请先安装Wrangler CLI"
    echo "   npm install -g wrangler"
    exit 1
fi

# 检查是否已登录Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo "🔐 请先登录Cloudflare账户..."
    wrangler login
fi

# 检查数据库配置
if grep -q "your-database-id-here" wrangler.toml; then
    echo "⚠️  检测到数据库配置未完成"
    echo "📝 正在创建D1数据库..."

    # 创建数据库
    DB_OUTPUT=$(wrangler d1 create apikeys-pool 2>&1)

    if [[ $DB_OUTPUT == *"database_id"* ]]; then
        # 提取database_id
        DATABASE_ID=$(echo "$DB_OUTPUT" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2)

        if [ -n "$DATABASE_ID" ]; then
            echo "✅ 数据库创建成功，ID: $DATABASE_ID"

            # 更新wrangler.toml
            sed -i "s/your-database-id-here/$DATABASE_ID/g" wrangler.toml
            echo "✅ 配置文件已更新"
        else
            echo "❌ 无法提取数据库ID，请手动更新wrangler.toml"
            exit 1
        fi
    else
        echo "❌ 数据库创建失败:"
        echo "$DB_OUTPUT"
        exit 1
    fi
fi

# 初始化数据库表
echo "📊 正在初始化数据库表..."
if ./scripts/init-db.sh; then
    echo "✅ 数据库初始化完成"
else
    echo "❌ 数据库初始化失败"
    echo "💡 你也可以单独运行: ./scripts/init-db.sh"
    exit 1
fi

# 部署Worker
echo "🚀 正在部署Worker..."
if wrangler deploy; then
    echo "✅ Worker部署成功!"
    echo ""
    echo "🎉 部署完成!"
    echo ""
    echo "📋 接下来的步骤:"
    echo "1. 访问你的Worker URL + '/admin' 打开管理面板"
    echo "2. 添加你的Gemini API Keys"
    echo "3. 开始使用连接池API!"
    echo ""
    echo "📖 更多信息请查看 README.md"
else
    echo "❌ Worker部署失败"
    exit 1
fi
