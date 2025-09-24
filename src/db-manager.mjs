/**
 * API Keys连接池数据库管理模块
 */

export class ApiKeyPoolManager {
  constructor(db) {
    this.db = db;
    // 移除内存中的lastUsedIndex，改为从数据库读取
  }




  /**
   * 获取下一个可用的API Key（循环获取）
   */
  async getNextApiKey(strategy = 'round_robin') {
    // 首先清理过期的错误计数
    await this.resetExpiredErrors();

    // 获取所有可用的API Keys
    const queryResult = await this.db.prepare(`
      SELECT * FROM api_keys
      WHERE is_active = 1 AND error_count < (
        SELECT CAST(value AS INTEGER) FROM pool_config WHERE key = 'max_errors_threshold'
      )
      ORDER BY id
    `).all();

    const activeKeys = queryResult.results || [];

    if (activeKeys.length === 0) {
      throw new Error('没有可用的API Keys');
    }

    let selectedKey;

    switch (strategy) {
      case 'round_robin':
        selectedKey = await this.selectRoundRobin(activeKeys);
        break;
      case 'least_used':
        selectedKey = this.selectLeastUsed(activeKeys);
        break;
      case 'random':
        selectedKey = this.selectRandom(activeKeys);
        break;
      default:
        selectedKey = await this.selectRoundRobin(activeKeys);
    }

    if (!selectedKey || !selectedKey.id) {
      throw new Error(`选择的API Key无效: ${JSON.stringify(selectedKey)}`);
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
   * 轮询选择策略 - 从数据库读取和更新索引以确保持久化
   */
  async selectRoundRobin(keys) {
    // 检查并处理索引重置逻辑
    await this.validateRoundRobinIndex(keys.length);

    // 从数据库获取当前轮询索引
    let currentIndex = await this.getConfig('round_robin_index');
    if (currentIndex === null) {
      // 首次使用，初始化为0
      currentIndex = 0;
      await this.setConfig('round_robin_index', '0', '轮询策略当前索引');
      await this.setConfig('round_robin_keys_count', keys.length.toString(), '轮询策略API Keys数量');
    } else {
      currentIndex = parseInt(currentIndex);
    }

    // 选择当前索引对应的key
    const selectedKey = keys[currentIndex % keys.length];

    // 更新索引到下一个位置
    const nextIndex = (currentIndex + 1) % keys.length;
    await this.setConfig('round_robin_index', nextIndex.toString(), '轮询策略当前索引');

    return selectedKey;
  }

  /**
   * 验证轮询索引 - 检查API Keys数量是否变化，如有变化则重置索引
   */
  async validateRoundRobinIndex(currentKeysCount) {
    const savedKeysCount = await this.getConfig('round_robin_keys_count');

    if (savedKeysCount !== null && parseInt(savedKeysCount) !== currentKeysCount) {
      // API Keys数量发生变化，重置索引
      await this.resetRoundRobinIndex();
      await this.setConfig('round_robin_keys_count', currentKeysCount.toString(), '轮询策略API Keys数量');
      console.log(`检测到API Keys数量变化 (${savedKeysCount} -> ${currentKeysCount})，已重置轮询索引`);
    } else if (savedKeysCount === null) {
      // 首次记录API Keys数量
      await this.setConfig('round_robin_keys_count', currentKeysCount.toString(), '轮询策略API Keys数量');
    }
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
   * 重置轮询索引 - 当API Keys数量变化时使用
   */
  async resetRoundRobinIndex() {
    await this.setConfig('round_robin_index', '0', '轮询策略当前索引');
    console.log('轮询索引已重置为0');
  }




}
