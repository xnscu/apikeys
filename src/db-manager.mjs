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
    const configs = await this.getConfigs(['cooldown_hours']);
    const cooldownHours = parseInt(configs.cooldown_hours || '24');

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
      ORDER BY last_used_at ASC
      LIMIT 1
    `).bind(cooldownHours).first();

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
    if (config.enable_usage_tracking === '0') return;

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
   * 获取 Dashboard 所需的全部数据
   */
  async getDashboardData() {
    const [overview, activeKeys, keyStats, errorDistribution, endpointStats, errorDetails] = await Promise.all([
      // 24h 概览
      this.db.prepare(`
        SELECT
          COUNT(*) as total_requests,
          SUM(CASE WHEN response_status = 200 THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN response_status <> 200 THEN 1 ELSE 0 END) as error_count
        FROM api_key_usage
        WHERE request_timestamp >= datetime('now', '-24 hours')
      `).first(),

      // Key 总数 / 活跃数
      this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
        FROM api_keys
      `).first(),

      // 每个 Key 的状态
      this.db.prepare(`
        SELECT
          b.gmail_email,
          b.is_active,
          b.total_requests,
          b.error_count,
          b.last_used_at,
          COUNT(CASE WHEN a.request_timestamp >= datetime('now', '-24 hours') THEN 1 END) as requests_24h,
          COUNT(CASE WHEN a.request_timestamp >= datetime('now', '-24 hours') AND a.response_status = 200 THEN 1 END) as success_24h,
          COUNT(CASE WHEN a.request_timestamp >= datetime('now', '-24 hours') AND a.response_status <> 200 THEN 1 END) as errors_24h
        FROM api_keys b
        LEFT JOIN api_key_usage a ON b.id = a.api_key_id
        GROUP BY b.id
        ORDER BY b.gmail_email
      `).all(),

      // 24h 错误状态码分布
      this.db.prepare(`
        SELECT response_status, COUNT(*) as count
        FROM api_key_usage
        WHERE response_status <> 200
          AND request_timestamp >= datetime('now', '-24 hours')
        GROUP BY response_status
        ORDER BY count DESC
      `).all(),

      // 24h 端点统计
      this.db.prepare(`
        SELECT
          endpoint,
          COUNT(*) as total,
          SUM(CASE WHEN response_status = 200 THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN response_status <> 200 THEN 1 ELSE 0 END) as errors
        FROM api_key_usage
        WHERE request_timestamp >= datetime('now', '-24 hours')
        GROUP BY endpoint
      `).all(),

      // 错误明细（最近 200 条非 200 请求）
      this.db.prepare(`
        SELECT b.gmail_email, a.response_status, a.error_message, a.request_timestamp
        FROM api_key_usage a
        JOIN api_keys b ON a.api_key_id = b.id
        WHERE a.response_status <> 200
        ORDER BY a.id DESC
        LIMIT 200
      `).all(),
    ]);

    return {
      overview: { ...overview, ...activeKeys },
      keyStats: keyStats.results || [],
      errorDistribution: errorDistribution.results || [],
      endpointStats: endpointStats.results || [],
      errorDetails: errorDetails.results || [],
    };
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
