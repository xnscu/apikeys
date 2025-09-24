-- API Keys连接池数据库表结构
-- API Keys表 - 存储Gemini API keys和对应的Gmail邮箱
CREATE TABLE IF NOT EXISTS api_keys(
  id integer PRIMARY KEY AUTOINCREMENT,
  api_key text NOT NULL UNIQUE,
  gmail_email text NOT NULL,
  is_active boolean DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  total_requests integer DEFAULT 0,
  error_count integer DEFAULT 0,
  notes text
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

CREATE INDEX IF NOT EXISTS idx_api_keys_last_used ON api_keys(last_used_at);

CREATE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys(gmail_email);

-- API Keys使用统计表 - 记录详细的使用情况
CREATE TABLE IF NOT EXISTS api_key_usage(
  id integer PRIMARY KEY AUTOINCREMENT,
  api_key_id integer NOT NULL,
  endpoint text NOT NULL, -- 'chat/completions', 'embeddings', 'models'
  request_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  response_status integer, -- HTTP状态码
  tokens_used integer DEFAULT 0,
  error_message text,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

-- 创建使用统计表的索引
CREATE INDEX IF NOT EXISTS idx_usage_api_key_id ON api_key_usage(api_key_id);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON api_key_usage(request_timestamp);

CREATE INDEX IF NOT EXISTS idx_usage_endpoint ON api_key_usage(endpoint);

-- 连接池配置表 - 存储连接池的配置信息
CREATE TABLE IF NOT EXISTS pool_config(
  id integer PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value text NOT NULL,
  description text,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认配置
INSERT
  OR IGNORE INTO pool_config(key, value, description)
    VALUES ('rotation_strategy', 'round_robin', '轮询策略: round_robin, least_used, random'),
('max_errors_threshold', '5', '最大错误次数阈值，超过后暂时禁用key'),
('error_reset_interval', '3600', '错误计数重置间隔（秒）'),
('enable_usage_tracking', '1', '是否启用详细使用统计');

