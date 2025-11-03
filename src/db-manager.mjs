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
    // await this.resetExpiredErrors();

    // 获取冷却期配置（单位：小时）
    const cooldownHours = parseInt(await this.getConfig('cooldown_hours') || '24');

    // 获取所有可参与选择的API Keys：
    // 1) is_active = 1 的key
    // 2) is_active = 0 但 last_used_at 距今超过配置的冷却期的key（冷却期后允许重试）
    const queryResult = await this.db.prepare(`
      SELECT * FROM api_keys
      WHERE (
        is_active = 1
        OR (
          is_active = 0
          AND last_used_at IS NOT NULL
          AND datetime(last_used_at, '+' || ? || ' hours') <= datetime('now')
        )
      )
      ORDER BY id
    `).bind(cooldownHours).all();

    const allKeys = queryResult.results || [];

    if (allKeys.length === 0) {
      throw new Error('没有可用的API Keys');
    }

    // 获取错误阈值
    const maxErrorsThreshold = parseInt(await this.getConfig('max_errors_threshold') || '5');

    // 过滤出可用的keys（错误数未达到阈值）
    const availableKeys = allKeys.filter(key => key.error_count < maxErrorsThreshold);

    if (availableKeys.length === 0) {
      throw new Error('所有API Keys都已达到错误阈值，请检查key的有效性');
    }

    let selectedKey;

    switch (strategy) {
      case 'round_robin':
        selectedKey = await this.selectRoundRobinFromAvailable(allKeys, availableKeys);
        break;
      case 'least_used':
        selectedKey = this.selectLeastUsed(availableKeys);
        break;
      case 'random':
        selectedKey = this.selectRandom(availableKeys);
        break;
      default:
        selectedKey = await this.selectRoundRobinFromAvailable(allKeys, availableKeys);
    }

    if (!selectedKey || !selectedKey.id) {
      throw new Error(`选择的API Key无效: ${JSON.stringify(selectedKey)}`);
    }

    // 更新最后使用时间和使用次数，并在被动恢复时自动启用
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
   * 智能轮询选择策略 - 跳过出错的key，从可用的key中轮询选择
   */
  async selectRoundRobinFromAvailable(allKeys, availableKeys) {
    // 检查并处理索引重置逻辑
    await this.validateRoundRobinIndex(allKeys.length);

    // 从数据库获取当前轮询索引
    let currentIndex = await this.getConfig('round_robin_index');
    if (currentIndex === null) {
      // 首次使用，初始化为0
      currentIndex = 0;
      await this.setConfig('round_robin_index', '0', '轮询策略当前索引');
      await this.setConfig('round_robin_keys_count', allKeys.length.toString(), '轮询策略API Keys数量');
    } else {
      currentIndex = parseInt(currentIndex);
    }

    // 查找下一个可用的key
    let attempts = 0;
    let selectedKey = null;
    const maxAttempts = allKeys.length; // 最多尝试所有key的数量

    while (attempts < maxAttempts && !selectedKey) {
      const candidateIndex = currentIndex % allKeys.length;
      const candidateKey = allKeys[candidateIndex];

      // 检查这个key是否在可用列表中
      if (availableKeys.find(key => key.id === candidateKey.id)) {
        selectedKey = candidateKey;
        break;
      }

      // 如果当前key不可用，移动到下一个
      currentIndex = (currentIndex + 1) % allKeys.length;
      attempts++;
    }

    if (!selectedKey) {
      // 如果没找到可用的key，从可用列表中随机选择一个
      selectedKey = availableKeys[Math.floor(Math.random() * availableKeys.length)];
      console.log('轮询策略未找到合适的key，随机选择了一个可用key');
    }

    // 更新索引到下一个位置
    const nextIndex = (currentIndex + 1) % allKeys.length;
    await this.setConfig('round_robin_index', nextIndex.toString(), '轮询策略当前索引');

    return selectedKey;
  }

  /**
   * 传统轮询选择策略 - 保留原有方法以备其他地方使用
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
    // 获取当前错误计数和阈值
    const keyInfo = await this.db.prepare(`
      SELECT error_count, gmail_email FROM api_keys WHERE id = ?
    `).bind(apiKeyId).first();

    const maxErrorsThreshold = parseInt(await this.getConfig('max_errors_threshold') || '5');

    await this.db.prepare(`
      UPDATE api_keys
      SET error_count = error_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(apiKeyId).run();

    const newErrorCount = (keyInfo?.error_count || 0) + 1;

    if (newErrorCount >= maxErrorsThreshold) {
      console.log(`⚠️ API Key已达到错误阈值: ${keyInfo?.gmail_email || apiKeyId} (${newErrorCount}/${maxErrorsThreshold}), 将暂时跳过使用`);
    } else {
      console.log(`记录API Key错误: ${keyInfo?.gmail_email || apiKeyId} (${newErrorCount}/${maxErrorsThreshold}), 错误: ${errorMessage}`);
    }
  }

  /**
   * 429限流时暂时禁用Key，并记录最近一次使用时间为当前
   * 注意：该禁用为冷却机制，冷却期（由cooldown_hours配置决定）后在获取阶段可再次被选中
   */
  async disableKeyOnRateLimit(apiKeyId) {
    try {
      const cooldownHours = parseInt(await this.getConfig('cooldown_hours') || '24');
      await this.db.prepare(`
        UPDATE api_keys
        SET is_active = 0,
            last_used_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(apiKeyId).run();
      console.log(`⏸️ 因429限流，已临时禁用Key ID=${apiKeyId}（${cooldownHours}小时后可自动参与选择）`);
    } catch (err) {
      console.error('禁用Key(429)失败:', err);
      throw err;
    }
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


  /**
   * 通过API Key值反查数据库记录
   */
  async getApiKeyByValue(apiKey) {
    if (!apiKey) { return null; }
    const result = await this.db.prepare(`
      SELECT * FROM api_keys WHERE api_key = ? LIMIT 1
    `).bind(apiKey).first();
    return result || null;
  }


}
