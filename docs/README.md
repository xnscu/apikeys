# Gemini API Keys 连接池应用

这是一个基于Cloudflare Workers的Gemini API key连接池应用，可以管理多个API keys，实现负载均衡和平均调用。

## ✨ 功能特性

- 🔄 **循环获取API Keys**: 支持round-robin、最少使用、随机三种轮询策略
- 📊 **使用统计**: 详细记录每个API key的使用情况和错误次数
- 🛡️ **错误处理**: 自动禁用错误过多的API keys，支持错误计数重置
- 🔧 **配置管理**: 支持动态配置连接池参数

## 🚀 部署步骤

### 方法一：自动部署（推荐）

```bash
# 给脚本执行权限
chmod +x scripts/deploy.sh scripts/init-db.sh

# 一键自动部署
./scripts/deploy.sh
```

自动部署脚本会：
1. 检查并创建D1数据库
2. 自动更新wrangler.toml配置
3. 初始化数据库表结构
4. 部署Worker到Cloudflare

### 方法二：手动部署

#### 1. 准备环境

确保你已经有Cloudflare账户，并且安装了Wrangler CLI：

```bash
# 安装Wrangler CLI
npm install -g wrangler

# 登录Cloudflare
wrangler login
```

#### 2. 创建D1数据库

```bash
# 创建数据库
wrangler d1 create apikeys-pool

# 记录返回的database_id
```

#### 3. 更新配置文件

修改 `wrangler.toml` 中的 `database_id` 为你实际的数据库ID：

```toml
[[d1_databases]]
binding = "LOG"
database_name = "apikeys-pool"
database_id = "你的实际数据库ID"
```

#### 4. 初始化数据库

```bash
# 使用专用脚本初始化（推荐）
./scripts/init-db.sh

# 或手动执行
wrangler d1 execute apikeys-pool --file=./sql/schema.sql
```

#### 5. 部署Worker

```bash
# 部署到Cloudflare Workers
wrangler deploy
```

## 📖 使用指南


### API端点

应用支持以下Gemini API端点：

- `POST /v1/chat/completions` - 聊天完成
- `POST /v1/embeddings` - 文本嵌入
- `GET /v1/models` - 模型列表


## 🔧 配置参数

连接池支持以下配置参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `rotation_strategy` | `round_robin` | 轮询策略: round_robin, least_used, random |
| `max_errors_threshold` | `5` | 最大错误次数阈值，超过后暂时禁用key |
| `error_reset_interval` | `3600` | 错误计数重置间隔（秒） |
| `enable_usage_tracking` | `1` | 是否启用详细使用统计 |

## 📊 轮询策略说明

### Round Robin (轮询)
- 按顺序循环使用每个API key
- 确保所有key得到平均使用
- **推荐用于大部分场景**

### Least Used (最少使用)
- 优先使用请求次数最少的API key
- 适合key性能差异较大的场景
- 可能导致某些key长期不被使用

### Random (随机)
- 随机选择可用的API key
- 简单快速，但分布可能不够均匀
- 适合对均衡性要求不高的场景

## 🛠️ 开发说明

### 项目结构

```
/root/apikeys/
├── src/
│   ├── worker.mjs          # 主Worker文件
│   └── db-manager.mjs      # 数据库管理模块
├── schema.sql              # 数据库表结构
├── wrangler.toml           # Cloudflare配置
└── README.md               # 说明文档
```

### 数据库表结构

#### api_keys 表
存储API keys和基本信息：
- `id`: 主键
- `api_key`: Gemini API Key
- `gmail_email`: 对应的Gmail邮箱
- `is_active`: 是否启用
- `total_requests`: 总请求数
- `error_count`: 错误次数
- `last_used_at`: 最后使用时间

#### api_key_usage 表
详细使用记录：
- `api_key_id`: 关联的API key ID
- `endpoint`: 调用的端点
- `response_status`: HTTP状态码
- `tokens_used`: 使用的token数量
- `request_timestamp`: 请求时间

#### pool_config 表
连接池配置：
- `key`: 配置键
- `value`: 配置值
- `description`: 配置说明

## 🔍 监控和维护

### 查看日志

```bash
# 查看Worker日志
wrangler tail

# 查看特定时间段的日志
wrangler tail --since 1h
```

### 数据库操作

#### 初始化和管理

```bash
# 创建数据库（如果还没有创建）
wrangler d1 create apikeys-pool

# 初始化数据库表结构（只需执行一次）
wrangler d1 execute apikeys-pool --file=./sql/schema.sql

# 查看数据库状态
wrangler d1 info apikeys-pool

# 验证表是否创建成功
wrangler d1 execute apikeys-pool --command "SELECT name FROM sqlite_master WHERE type='table';"
```

#### 常用查询

```bash
# 查看所有API keys
wrangler d1 execute apikeys-pool --command "SELECT id, gmail_email, is_active, total_requests, error_count FROM api_keys;"

# 查看使用统计
wrangler d1 execute apikeys-pool --command "SELECT endpoint, COUNT(*) as count FROM api_key_usage GROUP BY endpoint;"

# 查看配置
wrangler d1 execute apikeys-pool --command "SELECT * FROM pool_config;"

# 备份数据库
wrangler d1 export apikeys-pool --output backup.sql

# 清空使用统计（如果需要）
wrangler d1 execute apikeys-pool --command "DELETE FROM api_key_usage;"
```

## 🚨 注意事项

1. **API Key安全**: 确保只在安全环境下添加API keys，管理面板应该有适当的访问控制
2. **配额管理**: 注意Google Gemini API的配额限制，合理设置轮询策略
3. **错误处理**: 监控错误日志，及时处理失效的API keys
4. **性能优化**: 大量请求时建议使用round-robin策略以获得最佳性能

## 🤝 贡献

欢迎提交Issue和Pull Request来改进这个项目！

## 📄 许可证

MIT License