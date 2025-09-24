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
        self.timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
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

                    if '@' not in email:
                        logger.warning(f"第 {line_num} 行邮箱格式错误，跳过: {email}")
                        continue

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

    def generate_insert_sql(self, api_keys):
        """动态生成INSERT SQL语句 - 适配现有表结构"""
        if not api_keys:
            logger.warning("没有API密钥数据，跳过生成插入SQL")
            return None

        sql_lines = [
            "-- 动态生成的API密钥插入SQL",
            "-- 适配现有的api_keys表结构",
            "-- 使用INSERT OR REPLACE来处理重复的api_key",
            ""
        ]

        for email, api_key in api_keys:
            # 转义单引号
            email_escaped = email.replace("'", "''")
            api_key_escaped = api_key.replace("'", "''")

            # 适配现有表结构：api_key为唯一键，gmail_email存储邮箱
            sql = f"INSERT OR REPLACE INTO api_keys (api_key, gmail_email, is_active, created_at, updated_at, total_requests, error_count) VALUES ('{api_key_escaped}', '{email_escaped}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 0);"
            sql_lines.append(sql)

        insert_file = os.path.join(self.migrations_dir, f"insert_apikeys_{self.timestamp}.sql")
        with open(insert_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(sql_lines))

        logger.info(f"已生成插入数据文件: {insert_file}")
        return insert_file

    def generate_upsert_sql(self, api_keys):
        """生成现代化UPSERT SQL (ON CONFLICT语法) - 适配现有表结构"""
        if not api_keys:
            return None

        sql_lines = [
            "-- 使用INSERT ... ON CONFLICT的现代化语法",
            "-- 适配现有的api_keys表结构",
            "-- 注意: 需要D1支持较新的SQLite版本",
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

        upsert_file = os.path.join(self.migrations_dir, f"upsert_apikeys_{self.timestamp}.sql")
        with open(upsert_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(sql_lines))

        logger.info(f"已生成UPSERT数据文件: {upsert_file}")
        return upsert_file

    def execute_wrangler_commands(self, schema_file, insert_file, auto_execute=False):
        """生成并可选执行wrangler命令"""
        commands = [
            f"wrangler d1 execute {self.database_name} --file={schema_file}",
            f"wrangler d1 execute {self.database_name} --file={insert_file}"
        ]

        # 生成命令文件
        commands_content = f"""# Cloudflare D1 数据库操作命令

## 1. 表结构已存在，跳过创建
# {commands[0]}  # 不需要执行，使用现有的sql/schema.sql

## 2. 插入API密钥数据
{commands[1]}

## 3. 验证数据
wrangler d1 execute {self.database_name} --command="SELECT COUNT(*) as total FROM api_keys;"
wrangler d1 execute {self.database_name} --command="SELECT api_key, gmail_email, is_active, created_at FROM api_keys ORDER BY created_at DESC LIMIT 10;"

## 4. 查询特定邮箱
wrangler d1 execute {self.database_name} --command="SELECT * FROM api_keys WHERE gmail_email LIKE '%gmail.com';"

## 5. 查询激活状态的API Keys
wrangler d1 execute {self.database_name} --command="SELECT * FROM api_keys WHERE is_active = 1;"

## 6. 如果需要清空表重新导入
wrangler d1 execute {self.database_name} --command="DELETE FROM api_keys;"

## 注意事项:
# - 表结构已存在于sql/schema.sql，无需重新创建
# - 使用api_key作为唯一键，重复的api_key会被更新
# - gmail_email字段存储邮箱地址
# - is_active默认为1（激活状态）
# - 当前配置的数据库名称是: {self.database_name}
"""

        commands_file = os.path.join(self.migrations_dir, f"wrangler_commands_{self.timestamp}.txt")
        with open(commands_file, 'w', encoding='utf-8') as f:
            f.write(commands_content)

        logger.info(f"已生成wrangler命令文件: {commands_file}")

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

        return commands_file

    def run(self, auto_execute=False):
        """运行完整的流程"""
        logger.info(f"开始处理文件: {self.input_file}")

        # 1. 读取API密钥数据
        api_keys = self.read_apikeys()
        if not api_keys:
            logger.error("没有读取到有效的API密钥数据")
            return False

        # 2. 生成SQL文件
        schema_file = self.generate_schema_sql()
        insert_file = self.generate_insert_sql(api_keys)
        upsert_file = self.generate_upsert_sql(api_keys)

        if not insert_file:
            logger.error("生成插入SQL文件失败")
            return False

        # 3. 处理wrangler命令
        result = self.execute_wrangler_commands(schema_file, insert_file, auto_execute)

        # 4. 输出结果
        print(f"\n🎉 处理完成！")
        print(f"📊 共处理 {len(api_keys)} 条API密钥记录")
        print(f"📄 生成的文件:")
        print(f"  - 表结构: {schema_file}")
        print(f"  - 插入数据: {insert_file}")
        print(f"  - UPSERT数据: {upsert_file}")

        if not auto_execute:
            print(f"  - 命令说明: {result}")
            print(f"\n🚀 接下来手动执行命令:")
            print(f"wrangler d1 execute {self.database_name} --file={schema_file}")
            print(f"wrangler d1 execute {self.database_name} --file={insert_file}")
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
