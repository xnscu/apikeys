#!/bin/bash

# 数据库初始化脚本

echo "🗄️  开始初始化数据库..."

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

# 检查schema.sql文件是否存在
if [ ! -f "sql/schema.sql" ]; then
    echo "❌ 错误: 找不到sql/schema.sql文件"
    exit 1
fi

# 获取数据库名称
DATABASE_NAME="apikeys-pool"

echo "📊 正在初始化数据库表结构..."

# 执行schema.sql
if wrangler d1 execute $DATABASE_NAME --file=./sql/schema.sql; then
    echo "✅ 数据库表初始化成功"
else
    echo "❌ 数据库表初始化失败"
    echo "💡 请确保:"
    echo "   1. 数据库 '$DATABASE_NAME' 已经创建"
    echo "   2. wrangler.toml 中的数据库配置正确"
    echo "   3. 你有足够的权限操作数据库"
    exit 1
fi

# 验证表是否创建成功
echo "🔍 验证表结构..."
TABLES=$(wrangler d1 execute $DATABASE_NAME --command "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null)

if [[ $TABLES == *"api_keys"* ]] && [[ $TABLES == *"api_key_usage"* ]] && [[ $TABLES == *"pool_config"* ]]; then
    echo "✅ 所有表创建成功:"
    echo "   - api_keys (API密钥表)"
    echo "   - api_key_usage (使用统计表)"
    echo "   - pool_config (配置表)"
else
    echo "⚠️  表创建可能不完整，请检查:"
    echo "$TABLES"
fi

# 检查默认配置是否插入
echo "🔧 检查默认配置..."
CONFIG_COUNT=$(wrangler d1 execute $DATABASE_NAME --command "SELECT COUNT(*) as count FROM pool_config;" 2>/dev/null | grep -o '[0-9]\+' | tail -1)

if [ "$CONFIG_COUNT" -ge "4" ]; then
    echo "✅ 默认配置已插入"
else
    echo "⚠️  默认配置可能插入失败，请手动检查"
fi

echo ""
echo "🎉 数据库初始化完成!"
echo ""
echo "📋 接下来可以:"
echo "1. 运行 'wrangler deploy' 部署Worker"
echo "2. 通过数据库直接添加API Keys"
echo "3. 开始使用API连接池"
