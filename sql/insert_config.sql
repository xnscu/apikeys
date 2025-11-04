-- wrangler d1 execute apikeys-pool --remote --file=./sql/insert_config.sql
INSERT
  OR IGNORE INTO pool_config(key, value, description)
    VALUES ('cooldown_hours', '24', 'API Key冷却期小时数（禁用后多久可重新使用，24=1天，168=7天，720=30天）');

