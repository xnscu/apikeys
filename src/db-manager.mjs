/**
 * API Keys连接池数据库管理模块
 */

export class ApiKeyPoolManager {
  constructor(db) {
    this.db = db;
    this.lastUsedIndex = 0; // 用于round-robin策略
  }


  /**
   * 添加新的API Key
   */
  async addApiKey(apiKey, gmailEmail, notes = '') {
    try {
      const result = await this.db.prepare(`
        INSERT INTO api_keys (api_key, gmail_email, notes)
        VALUES (?, ?, ?)
      `).bind(apiKey, gmailEmail, notes).run();

      console.log(`新增API Key: ${gmailEmail} -> ${apiKey.substring(0, 10)}...`);
      return result.meta.last_row_id;
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        throw new Error('API Key已存在');
      }
      throw error;
    }
  }

  /**
   * 批量添加API Keys
   */
  async addApiKeysBatch(apiKeys) {
    const results = {
      success: [],
      errors: [],
      total: apiKeys.length
    };

    // 预处理和验证数据
    const validKeys = [];
    for (let i = 0; i < apiKeys.length; i++) {
      const { api_key, gmail_email, notes = '' } = apiKeys[i];

      // 验证必填字段
      if (!api_key || !gmail_email) {
        results.errors.push({
          index: i + 1,
          data: apiKeys[i],
          error: 'API Key和Gmail邮箱不能为空'
        });
        continue;
      }

      // 验证邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(gmail_email)) {
        results.errors.push({
          index: i + 1,
          data: apiKeys[i],
          error: '邮箱格式不正确'
        });
        continue;
      }

      validKeys.push({
        index: i + 1,
        api_key,
        gmail_email,
        notes,
        originalData: apiKeys[i]
      });
    }

    // 如果有有效数据，执行批量插入
    if (validKeys.length > 0) {
      try {
        // 构建批量插入SQL
        const placeholders = validKeys.map(() => '(?, ?, ?)').join(', ');
        const values = validKeys.flatMap(key => [key.api_key, key.gmail_email, key.notes]);

        const sql = `
          INSERT INTO api_keys (api_key, gmail_email, notes)
          VALUES ${placeholders}
        `;

        const result = await this.db.prepare(sql).bind(...values).run();

        // 记录成功的插入
        validKeys.forEach((key, idx) => {
          results.success.push({
            index: key.index,
            id: result.meta.last_row_id - validKeys.length + idx + 1, // 估算ID
            api_key: key.api_key.substring(0, 10) + '...',
            gmail_email: key.gmail_email,
            notes: key.notes
          });
        });

        console.log(`批量插入成功: ${validKeys.length}条记录`);

      } catch (error) {
        // 如果批量插入失败，可能是因为重复键等问题，回退到逐个插入
        console.log('批量插入失败，回退到逐个插入:', error.message);

        for (const key of validKeys) {
          try {
            const keyId = await this.addApiKey(key.api_key, key.gmail_email, key.notes);
            results.success.push({
              index: key.index,
              id: keyId,
              api_key: key.api_key.substring(0, 10) + '...',
              gmail_email: key.gmail_email,
              notes: key.notes
            });
          } catch (singleError) {
            results.errors.push({
              index: key.index,
              data: key.originalData,
              error: singleError.message
            });
          }
        }
      }
    }

    console.log(`批量添加API Keys完成: 成功${results.success.length}个, 失败${results.errors.length}个`);
    return results;
  }

  /**
   * 获取下一个可用的API Key（循环获取）
   */
  async getNextApiKey(strategy = 'round_robin') {
    // 首先清理过期的错误计数
    await this.resetExpiredErrors();

    // 获取所有可用的API Keys
    const activeKeys = await this.db.prepare(`
      SELECT * FROM api_keys
      WHERE is_active = 1 AND error_count < (
        SELECT CAST(value AS INTEGER) FROM pool_config WHERE key = 'max_errors_threshold'
      )
      ORDER BY id
    `).all();

    if (activeKeys.length === 0) {
      throw new Error('没有可用的API Keys');
    }

    let selectedKey;

    switch (strategy) {
      case 'round_robin':
        selectedKey = this.selectRoundRobin(activeKeys);
        break;
      case 'least_used':
        selectedKey = this.selectLeastUsed(activeKeys);
        break;
      case 'random':
        selectedKey = this.selectRandom(activeKeys);
        break;
      default:
        selectedKey = this.selectRoundRobin(activeKeys);
    }

    // 更新最后使用时间和使用次数
    await this.db.prepare(`
      UPDATE api_keys
      SET last_used_at = CURRENT_TIMESTAMP,
          total_requests = total_requests + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(selectedKey.id).run();

    console.log(`选择API Key: ${selectedKey.gmail_email} (ID: ${selectedKey.id})`);
    return selectedKey;
  }

  /**
   * 轮询选择策略
   */
  selectRoundRobin(keys) {
    const key = keys[this.lastUsedIndex % keys.length];
    this.lastUsedIndex = (this.lastUsedIndex + 1) % keys.length;
    return key;
  }

  /**
   * 最少使用选择策略
   */
  selectLeastUsed(keys) {
    return keys.reduce((min, current) =>
      current.total_requests < min.total_requests ? current : min
    );
  }

  /**
   * 随机选择策略
   */
  selectRandom(keys) {
    return keys[Math.floor(Math.random() * keys.length)];
  }

  /**
   * 记录API Key使用情况
   */
  async recordUsage(apiKeyId, endpoint, responseStatus, tokensUsed = 0, errorMessage = null) {
    const enableTracking = await this.getConfig('enable_usage_tracking');
    if (enableTracking !== '1') return;

    await this.db.prepare(`
      INSERT INTO api_key_usage (api_key_id, endpoint, response_status, tokens_used, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).bind(apiKeyId, endpoint, responseStatus, tokensUsed, errorMessage).run();
  }

  /**
   * 记录API Key错误
   */
  async recordError(apiKeyId, errorMessage) {
    await this.db.prepare(`
      UPDATE api_keys
      SET error_count = error_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(apiKeyId).run();

    console.log(`记录API Key错误: ID ${apiKeyId}, 错误: ${errorMessage}`);
  }

  /**
   * 重置过期的错误计数
   */
  async resetExpiredErrors() {
    const resetInterval = await this.getConfig('error_reset_interval');
    await this.db.prepare(`
      UPDATE api_keys
      SET error_count = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE error_count > 0
        AND datetime(updated_at, '+' || ? || ' seconds') < datetime('now')
    `).bind(resetInterval).run();
  }

  /**
   * 获取配置值
   */
  async getConfig(key) {
    const result = await this.db.prepare(`
      SELECT value FROM pool_config WHERE key = ?
    `).bind(key).first();
    return result?.value || null;
  }

  /**
   * 设置配置值
   */
  async setConfig(key, value, description = '') {
    await this.db.prepare(`
      INSERT OR REPLACE INTO pool_config (key, value, description, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(key, value, description).run();
  }

  /**
   * 获取所有API Keys
   */
  async getAllApiKeys() {
    const result = await this.db.prepare(`
      SELECT id, api_key, gmail_email, is_active, created_at, last_used_at,
             total_requests, error_count, notes
      FROM api_keys
      ORDER BY created_at DESC
    `).all();

    // 确保返回数组，即使查询结果为空
    return result?.results || [];
  }

  /**
   * 启用/禁用API Key
   */
  async toggleApiKey(id, isActive) {
    await this.db.prepare(`
      UPDATE api_keys
      SET is_active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(isActive ? 1 : 0, id).run();
  }

  /**
   * 删除API Key
   */
  async deleteApiKey(id) {
    await this.db.prepare(`DELETE FROM api_keys WHERE id = ?`).bind(id).run();
    await this.db.prepare(`DELETE FROM api_key_usage WHERE api_key_id = ?`).bind(id).run();
  }

  /**
   * 获取使用统计
   */
  async getUsageStats(days = 7) {
    return await this.db.prepare(`
      SELECT
        ak.gmail_email,
        COUNT(aku.id) as request_count,
        AVG(aku.tokens_used) as avg_tokens,
        SUM(CASE WHEN aku.response_status >= 400 THEN 1 ELSE 0 END) as error_count
      FROM api_keys ak
      LEFT JOIN api_key_usage aku ON ak.id = aku.api_key_id
        AND aku.request_timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY ak.id, ak.gmail_email
      ORDER BY request_count DESC
    `).bind(days).all();
  }
}
