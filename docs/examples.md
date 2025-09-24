# API 使用示例

## 基本API调用

### 1. 聊天完成 (Chat Completions)

```bash
curl -X POST https://apikeys.xnscu.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.0-flash-exp",
    "messages": [
      {
        "role": "user",
        "content": "你好，请介绍一下自己"
      }
    ],
    "max_tokens": 1000,
    "temperature": 0.7
  }'
```
本地版本
```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.0-flash-exp",
    "messages": [
      {
        "role": "user",
        "content": "你好，请介绍一下自己"
      }
    ],
    "max_tokens": 1000,
    "temperature": 0.7
  }'
```

### 2. 文本嵌入 (Embeddings)

```bash
curl -X POST https://apikeys.xnscu.com/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-embedding-001",
    "input": ["这是一段需要向量化的文本"]
  }'
```

### 3. 获取模型列表 (Models)

```bash
curl https://apikeys.xnscu.com/v1/models
```


## JavaScript/Node.js 示例

### 使用fetch调用

```javascript
// 聊天完成
async function chatCompletion(message) {
  const response = await fetch('https://apikeys.xnscu.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gemini-2.0-flash-exp',
      messages: [
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    })
  });

  return await response.json();
}

// 调用示例
chatCompletion('你好，世界！').then(result => {
  console.log(result.choices[0].message.content);
});
```

### 流式响应

```javascript
async function streamChat(message) {
  const response = await fetch('https://apikeys.xnscu.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gemini-2.0-flash-exp',
      messages: [{ role: 'user', content: message }],
      stream: true
    })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        try {
          const data = JSON.parse(line.slice(6));
          const content = data.choices[0]?.delta?.content;
          if (content) {
            process.stdout.write(content);
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  }
}
```

## Python 示例

### 基本调用

```python
import requests
import json

def chat_completion(message, worker_url):
    """发送聊天完成请求"""
    url = f"{worker_url}/v1/chat/completions"

    payload = {
        "model": "gemini-2.0-flash-exp",
        "messages": [
            {
                "role": "user",
                "content": message
            }
        ],
        "max_tokens": 1000,
        "temperature": 0.7
    }

    response = requests.post(url, json=payload)
    return response.json()

# 使用示例
worker_url = "https://apikeys.xnscu.com"
result = chat_completion("你好，请介绍一下自己", worker_url)
print(result['choices'][0]['message']['content'])
```


## OpenAI SDK 兼容

由于这个API兼容OpenAI格式，你可以使用OpenAI的SDK：

### JavaScript/Node.js

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'https://apikeys.xnscu.com/v1',
  apiKey: 'not-needed', // 连接池会自动管理API keys
});

const completion = await openai.chat.completions.create({
  messages: [{ role: 'user', content: '你好' }],
  model: 'gemini-2.0-flash-exp',
});

console.log(completion.choices[0].message.content);
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://apikeys.xnscu.com/v1",
    api_key="not-needed"  # 连接池会自动管理API keys
)

completion = client.chat.completions.create(
    model="gemini-2.0-flash-exp",
    messages=[
        {"role": "user", "content": "你好"}
    ]
)

print(completion.choices[0].message.content)
```

## 错误处理

```javascript
async function safeApiCall(message) {
  try {
    const response = await fetch('https://apikeys.xnscu.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-2.0-flash-exp',
        messages: [{ role: 'user', content: message }]
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('API调用失败:', error.message);
    return null;
  }
}
```

## 注意事项

1. **替换域名**: 将示例中的 `apikeys.xnscu.com` 替换为你的实际Worker域名
2. **API Key管理**: 连接池会自动轮询使用数据库中的API keys，无需在请求中提供
3. **错误重试**: 建议在客户端实现重试逻辑，处理临时性错误
4. **速率限制**: 注意Gemini API的速率限制，合理控制请求频率
