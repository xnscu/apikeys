#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API Keys 动态SQL生成器
读取apikeys.txt文件，动态生成SQL文件，然后使用wrangler插入D1数据库
"""

import os
import sys
from datetime import datetime
import subprocess
import logging

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class APIKeySQLGenerator:
    def __init__(self, input_file='apikeys.txt', database_name='apikeys-pool'):
        self.input_file = input_file
        self.database_name = database_name
        self.migrations_dir = 'migrations'

        # 确保migrations目录存在
        os.makedirs(self.migrations_dir, exist_ok=True)

    def read_apikeys(self):
        """动态读取apikeys.txt文件"""
        api_keys = []

        if not os.path.exists(self.input_file):
            logger.error(f"文件不存在: {self.input_file}")
            return api_keys

        try:
            with open(self.input_file, 'r', encoding='utf-8') as file:
                for line_num, line in enumerate(file, 1):
                    line = line.strip()

                    # 跳过空行和注释行
                    if not line or line.startswith('#'):
                        continue

                    # 解析 mail:key 格式
                    if ':' not in line:
                        logger.warning(f"第 {line_num} 行格式错误，跳过: {line}")
                        continue

                    parts = line.split(':', 1)  # 只分割第一个冒号
                    if len(parts) != 2:
                        logger.warning(f"第 {line_num} 行格式错误，跳过: {line}")
                        continue

                    email = parts[0].strip()
                    api_key = parts[1].strip()

                    # 基本验证
                    if not email or not api_key:
                        logger.warning(f"第 {line_num} 行数据不完整，跳过: {line}")
                        continue

                    # 如果不包含@符号，假设是用户名，添加@gmail.com后缀
                    if '@' not in email:
                        email = f"{email}@gmail.com"
                        logger.info(f"第 {line_num} 行自动添加@gmail.com后缀: {email}")

                    api_keys.append((email, api_key))

            logger.info(f"成功读取 {len(api_keys)} 条API密钥记录")
            return api_keys

        except Exception as e:
            logger.error(f"读取文件失败: {e}")
            return []

    def generate_schema_sql(self):
        """跳过生成表结构SQL - 使用现有的sql/schema.sql"""
        logger.info("跳过生成表结构文件 - 使用现有的 sql/schema.sql")
        return "sql/schema.sql"

    def generate_upsert_sql(self, api_keys):
        """生成UPSERT SQL (ON CONFLICT语法) - 适配现有表结构"""
        if not api_keys:
            logger.warning("没有API密钥数据，跳过生成UPSERT SQL")
            return None

        sql_lines = [
            "-- 动态生成的API密钥UPSERT SQL",
            "-- 适配现有的api_keys表结构",
            "-- 使用INSERT ... ON CONFLICT来处理重复的api_key",
            ""
        ]

        for email, api_key in api_keys:
            # 转义单引号
            email_escaped = email.replace("'", "''")
            api_key_escaped = api_key.replace("'", "''")

            sql = f"""INSERT INTO api_keys (api_key, gmail_email, is_active, created_at, updated_at, total_requests, error_count)
VALUES ('{api_key_escaped}', '{email_escaped}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 0)
ON CONFLICT(api_key) DO UPDATE SET
    gmail_email = excluded.gmail_email,
    updated_at = CURRENT_TIMESTAMP,
    is_active = 1;"""

            sql_lines.append(sql)

        upsert_file = os.path.join(self.migrations_dir, "apikeys_upsert.sql")
        with open(upsert_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(sql_lines))

        logger.info(f"已生成UPSERT数据文件: {upsert_file}")
        return upsert_file


    def execute_wrangler_commands(self, schema_file, upsert_file, auto_execute=False):
        """生成并可选执行wrangler命令"""
        commands = [
            f"wrangler d1 execute {self.database_name} --file={upsert_file}"
        ]

        # 生成命令文件
        # 生成本地数据库命令脚本
        local_commands = f"""#!/bin/bash
# Cloudflare D1 本地数据库操作脚本

echo "执行本地数据库操作..."

# 1. 执行UPSERT操作
wrangler d1 execute {self.database_name} --file={upsert_file}

# 2. 验证数据
echo "验证数据..."
wrangler d1 execute {self.database_name} --command="SELECT COUNT(*) as total FROM api_keys;"
wrangler d1 execute {self.database_name} --command="SELECT api_key, gmail_email, is_active, created_at FROM api_keys ORDER BY created_at DESC LIMIT 10;"

# 3. 查询特定邮箱
echo "查询Gmail邮箱..."
wrangler d1 execute {self.database_name} --command="SELECT * FROM api_keys WHERE gmail_email LIKE '%gmail.com';"

# 4. 查询激活状态的API Keys
echo "查询激活状态的API Keys..."
wrangler d1 execute {self.database_name} --command="SELECT * FROM api_keys WHERE is_active = 1;"

echo "本地数据库操作完成！"
"""

        # 生成远程数据库命令脚本
        remote_commands = f"""#!/bin/bash
# Cloudflare D1 远程数据库操作脚本

echo "执行远程数据库操作..."

# 1. 执行UPSERT操作
wrangler d1 execute {self.database_name} --remote --file={upsert_file}

# 2. 验证数据
echo "验证数据..."
wrangler d1 execute {self.database_name} --remote --command="SELECT COUNT(*) as total FROM api_keys;"
wrangler d1 execute {self.database_name} --remote --command="SELECT api_key, gmail_email, is_active, created_at FROM api_keys ORDER BY created_at DESC LIMIT 10;"

# 3. 查询特定邮箱
echo "查询Gmail邮箱..."
wrangler d1 execute {self.database_name} --remote --command="SELECT * FROM api_keys WHERE gmail_email LIKE '%gmail.com';"

# 4. 查询激活状态的API Keys
echo "查询激活状态的API Keys..."
wrangler d1 execute {self.database_name} --remote --command="SELECT * FROM api_keys WHERE is_active = 1;"

echo "远程数据库操作完成！"
"""

        # 写入本地脚本文件
        local_file = os.path.join(self.migrations_dir, "local_commands.sh")
        with open(local_file, 'w', encoding='utf-8') as f:
            f.write(local_commands)

        # 写入远程脚本文件
        remote_file = os.path.join(self.migrations_dir, "remote_commands.sh")
        with open(remote_file, 'w', encoding='utf-8') as f:
            f.write(remote_commands)

        logger.info(f"已生成本地命令脚本: {local_file}")
        logger.info(f"已生成远程命令脚本: {remote_file}")

        # 如果启用自动执行
        if auto_execute:
            logger.info("开始自动执行wrangler命令...")
            for i, cmd in enumerate(commands, 1):
                logger.info(f"执行命令 {i}: {cmd}")
                try:
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
                    if result.returncode == 0:
                        logger.info(f"命令 {i} 执行成功")
                        if result.stdout:
                            logger.info(f"输出: {result.stdout}")
                    else:
                        logger.error(f"命令 {i} 执行失败: {result.stderr}")
                        return False
                except Exception as e:
                    logger.error(f"执行命令 {i} 时出错: {e}")
                    return False

            logger.info("所有wrangler命令执行完成")
            return True

        return (local_file, remote_file)

    def run(self, auto_execute=False):
        """运行完整的流程"""
        logger.info(f"开始处理文件: {self.input_file}")

        # 1. 读取API密钥数据
        api_keys = self.read_apikeys()
        if not api_keys:
            logger.error("没有读取到有效的API密钥数据")
            return False

        # 2. 生成UPSERT SQL文件
        schema_file = self.generate_schema_sql()
        upsert_file = self.generate_upsert_sql(api_keys)

        if not upsert_file:
            logger.error("生成UPSERT SQL文件失败")
            return False

        # 3. 处理wrangler命令
        result = self.execute_wrangler_commands(schema_file, upsert_file, auto_execute)

        # 4. 输出结果
        print(f"\n🎉 处理完成！")
        print(f"📊 共处理 {len(api_keys)} 条API密钥记录")
        print(f"📄 生成的文件:")
        print(f"  - UPSERT数据: {upsert_file}")

        if not auto_execute:
            local_file, remote_file = result
            print(f"  - 本地命令脚本: {local_file}")
            print(f"  - 远程命令脚本: {remote_file}")
            print(f"\n🚀 接下来执行以下命令:")
            print(f"# 本地数据库:")
            print(f"chmod +x {local_file} && {local_file}")
            print(f"# 远程数据库:")
            print(f"chmod +x {remote_file} && {remote_file}")
        else:
            print(f"✅ 数据已自动导入到数据库: {self.database_name}")

        return True

def main():
    """主函数"""
    # 解析命令行参数
    input_file = 'apikeys.txt'
    database_name = 'apikeys-pool'
    auto_execute = False

    if len(sys.argv) > 1:
        input_file = sys.argv[1]
    if len(sys.argv) > 2:
        database_name = sys.argv[2]
    if len(sys.argv) > 3:
        auto_execute = sys.argv[3].lower() in ['true', '1', 'yes', 'auto']

    # 创建生成器并运行
    generator = APIKeySQLGenerator(input_file, database_name)
    success = generator.run(auto_execute)

    if not success:
        sys.exit(1)

    print(f"\n💡 使用说明:")
    print(f"python {sys.argv[0]} [输入文件] [数据库名] [自动执行]")
    print(f"示例: python {sys.argv[0]} apikeys.txt apikeys-pool true")

if __name__ == "__main__":
    main()
