/**
 * API Keys连接池数据库管理模块
 */

export class ApiKeyPoolManager {
  constructor(db) {
    this.db = db;
    this._configCache = {};
  }

  /**
   * 批量获取配置值（带请求级缓存，避免重复查询）
   */
  async getConfigs(keys) {
    const uncachedKeys = keys.filter(k => !(k in this._configCache));
    if (uncachedKeys.length > 0) {
      const placeholders = uncachedKeys.map(() => '?').join(',');
      const result = await this.db.prepare(
        `SELECT key, value FROM pool_config WHERE key IN (${placeholders})`
      ).bind(...uncachedKeys).all();
      for (const row of (result.results || [])) {
        this._configCache[row.key] = row.value;
      }
      for (const key of uncachedKeys) {
        if (!(key in this._configCache)) {
          this._configCache[key] = null;
        }
      }
    }
    const configs = {};
    for (const key of keys) {
      configs[key] = this._configCache[key] ?? null;
    }
    return configs;
  }

  /**
   * 获取单个配置值
   */
  async getConfig(key) {
    const configs = await this.getConfigs([key]);
    return configs[key];
  }

  /**
   * 设置配置值
   */
  async setConfig(key, value, description = '') {
    await this.db.prepare(
      `INSERT OR REPLACE INTO pool_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(key, value, description).run();
    this._configCache[key] = value;
  }

  /**
   * 获取下一个可用的API Key（最近最少使用策略）
   *
   * 用 ORDER BY last_used_at ASC 替代原先的 round_robin_index：
   * - 天然并发安全，无需维护轮询索引
   * - 自动处理 key 增删，无需 validateRoundRobinIndex
   * - 从 7~12 次 DB 查询降到 3 次
   */
  async getNextApiKey() {
    const configs = await this.getConfigs(['cooldown_hours', 'max_errors_threshold']);
    const cooldownHours = parseInt(configs.cooldown_hours || '24');
    const maxErrorsThreshold = parseInt(configs.max_errors_threshold || '5');

    const selectedKey = await this.db.prepare(`
      SELECT * FROM api_keys
      WHERE (
        is_active = 1
        OR (
          is_active = 0
          AND last_used_at IS NOT NULL
          AND datetime(last_used_at, '+' || ? || ' hours') <= datetime('now')
        )
      )
      AND error_count < ?
      ORDER BY last_used_at ASC
      LIMIT 1
    `).bind(cooldownHours, maxErrorsThreshold).first();

    if (!selectedKey) {
      throw new Error('没有可用的API Keys');
    }

    await this.db.prepare(`
      UPDATE api_keys
      SET last_used_at = CURRENT_TIMESTAMP,
          total_requests = total_requests + 1,
          updated_at = CURRENT_TIMESTAMP,
          is_active = CASE WHEN is_active = 0 THEN 1 ELSE is_active END
      WHERE id = ?
    `).bind(selectedKey.id).run();

    console.log(`选择API Key: ${selectedKey.gmail_email} (ID: ${selectedKey.id}, 错误数: ${selectedKey.error_count})`);
    return selectedKey;
  }

  /**
   * 记录API Key使用情况
   */
  async recordUsage(apiKeyId, endpoint, responseStatus, tokensUsed = 0, errorMessage = null) {
    const config = await this.getConfigs(['enable_usage_tracking']);
    if (config.enable_usage_tracking !== '1') return;

    await this.db.prepare(`
      INSERT INTO api_key_usage (api_key_id, endpoint, response_status, tokens_used, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).bind(apiKeyId, endpoint, responseStatus, tokensUsed, errorMessage).run();
  }

  /**
   * 记录API Key错误（仅递增计数，阈值过滤在 getNextApiKey 中处理）
   */
  async recordError(apiKeyId, errorMessage) {
    await this.db.prepare(`
      UPDATE api_keys
      SET error_count = error_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(apiKeyId).run();
  }

  /**
   * 429/403 时暂时禁用Key，冷却期后可自动恢复
   */
  async disableKeyOnRateLimit(apiKeyId) {
    await this.db.prepare(`
      UPDATE api_keys
      SET is_active = 0,
          last_used_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(apiKeyId).run();
    console.log(`暂时禁用Key ID=${apiKeyId}，冷却期后可自动恢复`);
  }

  /**
   * 通过API Key值反查数据库记录
   */
  async getApiKeyByValue(apiKey) {
    if (!apiKey) return null;
    return await this.db.prepare(
      `SELECT * FROM api_keys WHERE api_key = ? LIMIT 1`
    ).bind(apiKey).first() || null;
  }

  /**
   * 清理过期的使用记录，防止 api_key_usage 表无限增长
   */
  async cleanupOldUsageRecords(retentionDays = 30) {
    await this.db.prepare(`
      DELETE FROM api_key_usage
      WHERE request_timestamp < datetime('now', '-' || ? || ' days')
    `).bind(retentionDays).run();
  }
}
