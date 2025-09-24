# API密钥并发测试工具

这个脚本用于并发测试 `apikeys.txt` 文件中所有API密钥的可用性。

## 功能特性

- 🚀 **并发测试**: 支持同时测试多个API密钥，提高测试效率
- ⏱️ **超时控制**: 可配置的请求超时时间，避免长时间等待
- 📊 **详细报告**: 生成详细的测试日志和汇总报告
- 🎨 **彩色输出**: 直观的彩色终端输出，便于查看结果
- 💾 **结果保存**: 自动保存测试结果到JSON格式文件

## 使用方法

### 1. 基本使用

```bash
# 运行测试脚本
./test_apikeys.sh
```

### 2. 配置参数

脚本顶部的配置参数可以根据需要修改：

```bash
API_ENDPOINT="http://localhost:8787/v1/chat/completions"  # API端点
MAX_CONCURRENT_JOBS=5                                     # 最大并发数
TIMEOUT=30                                                # 超时时间(秒)
```

### 3. API密钥格式

确保 `apikeys.txt` 文件格式正确：

```
username1:XXX
```

## 测试结果

### 终端输出

脚本运行时会显示：
- 🔵 测试开始信息
- ✅ 成功的测试（绿色）
- ⚠️ HTTP错误（黄色）
- ❌ 超时或连接失败（红色）
- 📊 最终汇总统计

### 日志文件

测试结果会保存在 `./test_logs/` 目录中：

```
test_logs/
├── test_username1_20240924_143022.log      # 错误日志
├── result_username1_20240924_143022.json   # 详细结果
├── status_username1_20240924_143022.txt    # 状态文件
└── summary_20240924_143022.json            # 汇总报告
```

### 结果JSON格式

每个API密钥的详细测试结果：

```json
{
    "username": "username1",
    "api_key": "XXX",
    "http_code": 200,
    "time_total": 1.234567,
    "timestamp": "2024-09-24T14:30:22+00:00",
    "test_id": 1
}
```

### 汇总报告格式

```json
{
    "timestamp": "2024-09-24T14:30:25+00:00",
    "total_tests": 9,
    "successful": 7,
    "errors": 1,
    "timeouts": 1,
    "endpoint": "http://localhost:8787/v1/chat/completions",
    "max_concurrent": 5,
    "timeout_seconds": 30
}
```

## 故障排除

### 常见问题

1. **脚本没有执行权限**
   ```bash
   chmod +x test_apikeys.sh
   ```

2. **curl命令不存在**
   ```bash
   # Ubuntu/Debian
   sudo apt-get install curl

   # CentOS/RHEL
   sudo yum install curl
   ```

3. **API端点不可访问**
   - 检查服务是否在运行
   - 确认端口和地址正确
   - 检查防火墙设置

4. **所有密钥都失败**
   - 检查API端点是否正确
   - 验证认证头格式
   - 确认服务器是否正常运行

### 调试技巧

1. **查看详细错误日志**
   ```bash
   cat test_logs/test_username_*.log
   ```

2. **手动测试单个密钥**
   ```bash
   curl -X POST http://localhost:8787/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer XXXX" \
     -d '{
       "model": "gemini-2.0-flash-exp",
       "messages": [{"role": "user", "content": "你好"}],
       "max_tokens": 1000,
       "temperature": 0.7
     }'
   ```

3. **减少并发数量**
   - 将 `MAX_CONCURRENT_JOBS` 设置为较小值（如2或3）

## 自定义配置

### 修改测试消息

编辑脚本中的测试消息：

```bash
"content": "你好，请介绍一下自己"  # 改为您想要的测试消息
```

### 调整并发设置

根据您的服务器性能调整：

```bash
MAX_CONCURRENT_JOBS=10  # 增加并发数
TIMEOUT=60             # 增加超时时间
```

### 更改API端点

如果使用不同的服务：

```bash
API_ENDPOINT="https://your-api-server.com/v1/chat/completions"
```

## 示例输出

```
=== API密钥并发测试开始 ===
测试端点: http://localhost:8787/v1/chat/completions
最大并发数: 5
超时时间: 30s
日志目录: ./test_logs

[测试 1] 开始测试用户: hungphambao128
[测试 2] 开始测试用户: xodeldev
[测试 1] ✅ 成功 - hungphambao128 (耗时: 2.345s)
[测试 2] ⚠️ HTTP错误 401 - xodeldev
...

=== 测试结果汇总 ===
✅ 成功: 7
⚠️ 错误: 1
❌ 超时: 1
📊 总计: 9

详细日志保存在: ./test_logs
汇总报告: ./test_logs/summary_20240924_143022.json
```
