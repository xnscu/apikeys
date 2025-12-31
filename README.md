# Gemini API Keys 连接池

一个基于 Cloudflare Workers 的 Gemini API key 连接池应用，支持多个 API keys 的负载均衡和轮询使用。

## 🆕 API 版本控制

现在支持通过 URL 路径控制使用的 Google API 版本：

### v1 (稳定版)

```bash
# 查询模型
curl https://apikeys.xnscu.com/v1/models

# 调用 Chat API
curl -X POST https://apikeys.xnscu.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "你好"}]}'
```

### v1beta (测试版，包含 Gemini 3)

```bash
# 查询所有模型（包含实验性模型）
curl https://apikeys.xnscu.com/v1beta/models

# 调用 Gemini 3 模型
curl -X POST https://apikeys.xnscu.com/v1beta/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-3-flash-preview", "messages": [{"role": "user", "content": "你好"}]}'
```

### v1alpha (内测版，功能同 v1beta)

```bash
# v1alpha 模型列表与 v1beta 完全相同
curl https://apikeys.xnscu.com/v1alpha/models

# 使用方式同 v1beta
curl -X POST https://apikeys.xnscu.com/v1alpha/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-3-flash-preview", "messages": [{"role": "user", "content": "你好"}]}'
```

**版本对比：**

- **v1**: 9 个稳定模型（仅 Gemini 2.x 系列）
- **v1beta** / **v1alpha**: 50+ 个模型（包含 Gemini 3.x、Gemma 3、Imagen 4.0、Veo 3.0 等）
- 注：v1alpha 和 v1beta 的模型列表完全相同

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
- 🆕 API 版本控制（v1 / v1beta）
- 🚀 支持最新的 Gemini 3 系列模型

## 🎯 使用场景

- 多个 Gemini API keys 的负载均衡
- API 调用的统计和监控
- 自动故障转移和恢复
- 企业级 API key 管理

## 📄 许可证

MIT License
