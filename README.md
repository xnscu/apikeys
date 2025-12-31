# Gemini API Keys 连接池

一个基于 Cloudflare Workers 的 Gemini API key 连接池应用，支持多个 API keys 的负载均衡和轮询使用。

# 查询可用模型

```
curl -s https://apikeys.xnscu.com/v1/models | jq -r '.data[] | .id' 2>/dev/null
```

## 📁 项目结构

```
/root/apikeys/
├── src/                    # 源代码
│   ├── worker.mjs         # 主Worker文件
│   └── db-manager.mjs     # 数据库管理模块
├── sql/                    # 数据库相关
│   └── schema.sql         # 数据库表结构
├── scripts/               # 部署脚本
│   ├── deploy.sh          # 自动部署脚本
│   └── init-db.sh         # 数据库初始化脚本
├── docs/                  # 文档
│   ├── README.md          # 详细使用文档
│   └── examples.md        # API调用示例
├── wrangler.toml          # Cloudflare配置
└── README.md              # 项目概览（本文件）
```

## 🚀 快速开始

### 1. 自动部署（推荐）

```bash
# 给脚本执行权限
chmod +x scripts/deploy.sh scripts/init-db.sh

# 一键部署
./scripts/deploy.sh
```

### 2. 手动部署

```bash
# 1. 创建数据库
wrangler d1 create apikeys-pool

# 2. 更新wrangler.toml中的database_id

# 3. 初始化数据库
./scripts/init-db.sh

# 4. 部署Worker
wrangler deploy
```

## 📖 详细文档

- **[完整使用文档](docs/README.md)** - 详细的部署和使用说明
- **[API 调用示例](docs/examples.md)** - 多语言调用示例和管理 API

## ✨ 主要功能

- 🔄 多种轮询策略（轮询、最少使用、随机）
- 📊 详细的使用统计和监控
- 🛡️ 自动错误处理和恢复
- 🔧 动态配置管理

## 🎯 使用场景

- 多个 Gemini API keys 的负载均衡
- API 调用的统计和监控
- 自动故障转移和恢复
- 企业级 API key 管理

## 📄 许可证

MIT License
