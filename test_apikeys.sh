#!/bin/bash

# API密钥并发测试脚本
# 使用curl测试apikeys.txt中所有密钥的可用性

# 配置
API_ENDPOINT="http://localhost:8787/v1/chat/completions"
APIKEYS_FILE="apikeys.txt"
MAX_CONCURRENT_JOBS=5
TIMEOUT=30

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# 测试单个API密钥的函数
test_api_key() {
    local username=$1
    local api_key=$2
    local test_id=$3

    print_message $BLUE "[测试 $test_id] 开始测试用户: $username"

    # 构建curl命令
    local curl_response=$(curl -s -w "\n%{http_code}\n%{time_total}" \
        --max-time $TIMEOUT \
        -X POST "$API_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $api_key" \
        -d '{
            "model": "gemini-2.0-flash-exp",
            "messages": [
                {
                    "role": "user",
                    "content": "你好"
                }
            ],
            "max_tokens": 1000,
            "temperature": 0.1
        }' 2>/dev/null)

    # 解析响应
    local response_body=$(echo "$curl_response" | head -n -2)
    local http_code=$(echo "$curl_response" | tail -n 2 | head -n 1)
    local time_total=$(echo "$curl_response" | tail -n 1)

    # 根据HTTP状态码判断结果
    if [ "$http_code" = "200" ]; then
        print_message $GREEN "[测试 $test_id] ✅ 成功 - $username (耗时: ${time_total}s)"
    elif [ "$http_code" = "000" ]; then
        print_message $RED "[测试 $test_id] ❌ 超时或连接失败 - $username"
    else
        print_message $YELLOW "[测试 $test_id] ⚠️  HTTP错误 $http_code - $username"
    fi
}

# 主函数
main() {
    print_message $BLUE "=== API密钥并发测试开始 ==="
    print_message $BLUE "测试端点: $API_ENDPOINT"
    print_message $BLUE "最大并发数: $MAX_CONCURRENT_JOBS"
    print_message $BLUE "超时时间: ${TIMEOUT}s"
    echo ""

    # 检查apikeys.txt文件是否存在
    if [ ! -f "$APIKEYS_FILE" ]; then
        print_message $RED "错误: 找不到文件 $APIKEYS_FILE"
        exit 1
    fi

    # 读取并解析API密钥
    local test_count=0
    local pids=()

    while IFS=':' read -r username api_key; do
        # 跳过空行和注释
        if [[ -z "$username" || "$username" =~ ^#.* ]]; then
            continue
        fi

        test_count=$((test_count + 1))

        # 控制并发数量
        while [ ${#pids[@]} -ge $MAX_CONCURRENT_JOBS ]; do
            for i in "${!pids[@]}"; do
                if ! kill -0 "${pids[i]}" 2>/dev/null; then
                    unset "pids[i]"
                fi
            done
            pids=("${pids[@]}")  # 重新索引数组
            sleep 0.1
        done

        # 启动后台测试进程
        test_api_key "$username" "$api_key" "$test_count" &
        pids+=($!)

        # 短暂延迟避免同时发起太多请求
        sleep 0.2

    done < "$APIKEYS_FILE"

    # 等待所有后台进程完成
    print_message $BLUE "等待所有测试完成..."
    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null
    done

    echo ""
    print_message $BLUE "=== 测试完成 ==="
    print_message $BLUE "📊 总计测试: $test_count 个API密钥"
}

# 检查依赖
if ! command -v curl &> /dev/null; then
    print_message $RED "错误: 需要安装curl命令"
    exit 1
fi

# 运行主函数
main "$@"
