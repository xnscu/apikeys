import { Buffer } from "node:buffer";
import { ApiKeyPoolManager } from "./db-manager.mjs";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    const poolManager = new ApiKeyPoolManager(env?.DB);

    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };

    try {
      const { pathname } = new URL(request.url);

      // 从 URL 中提取 API 版本和端点
      const pathMatch = pathname.match(/^\/([^/]+)\/(.+)$/);
      let apiVersion = "v1beta";
      let endpoint = pathname.substring(1);

      if (pathMatch) {
        if (pathMatch[1].startsWith('v')) {
          apiVersion = pathMatch[1];
          endpoint = pathMatch[2];
        } else {
          endpoint = pathMatch[1] + '/' + pathMatch[2];
        }
      }

      // 验证端点和请求方法
      switch (endpoint) {
        case "chat/completions":
        case "embeddings":
          if (request.method !== "POST") {
            throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
          }
          break;
        case "models":
          if (request.method !== "GET") {
            throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
          }
          break;
        default:
          throw new HttpError("404 Not Found", 404);
      }

      // POST 请求只解析一次 body（支持重试）
      let reqBody = null;
      if (request.method === "POST") {
        reqBody = await request.json();
      }

      // 获取用户提供的 API Key
      const auth = request.headers.get("Authorization");
      const userApiKey = auth?.split(" ")[1];

      if (userApiKey) {
        // 用户自带 Key：单次请求，可选统计
        let selectedKeyInfo = null;
        try {
          selectedKeyInfo = await poolManager.getApiKeyByValue(userApiKey);
        } catch (e) { /* 统计是可选的 */ }

        let response;
        try {
          response = await dispatchHandler(endpoint, reqBody, userApiKey, apiVersion);
        } catch (err) {
          return errHandler(err);
        }

        const recordPromise = recordApiResult(response, selectedKeyInfo, poolManager, endpoint);
        ctx?.waitUntil?.(recordPromise);
        return response;
      }

      // 连接池模式：429/403 时自动换 Key 重试
      const MAX_RETRIES = 3;
      let lastResponse = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let apiKey, selectedKeyInfo;

        try {
          selectedKeyInfo = await poolManager.getNextApiKey();
          apiKey = selectedKeyInfo.api_key;
          console.log(`使用连接池API Key: ${selectedKeyInfo.gmail_email}`);
        } catch (error) {
          console.error("获取API Key失败:", error);
          // 回退到环境变量
          if (env?.GEMINI_API_KEYS) {
            const keys = String(env.GEMINI_API_KEYS).split(",").map(s => s.trim()).filter(Boolean);
            if (keys.length) {
              apiKey = keys[Math.floor(Math.random() * keys.length)];
            }
          }
          if (!apiKey) {
            if (lastResponse) return lastResponse;
            throw new HttpError("No API keys available", 503);
          }
          // 环境变量 Key 不重试、不统计
          try {
            return await dispatchHandler(endpoint, reqBody, apiKey, apiVersion);
          } catch (err) {
            return errHandler(err);
          }
        }

        let response;
        try {
          response = await dispatchHandler(endpoint, reqBody, apiKey, apiVersion);
        } catch (err) {
          return errHandler(err);
        }

        // 429/403 时记录错误并重试下一个 Key
        if (isRateLimitOrForbidden(response.status) && attempt < MAX_RETRIES - 1) {
          await recordApiResult(response, selectedKeyInfo, poolManager, endpoint);
          console.log(`第${attempt + 1}次尝试失败(${response.status})，使用下一个Key重试...`);
          lastResponse = response;
          continue;
        }

        // 最终响应：后台记录统计，不阻塞返回
        const recordPromise = recordApiResult(response, selectedKeyInfo, poolManager, endpoint);
        ctx?.waitUntil?.(recordPromise);

        // 1% 概率清理过期使用记录
        if (Math.random() < 0.01) {
          ctx?.waitUntil?.(poolManager.cleanupOldUsageRecords(30).catch(() => {}));
        }

        return response;
      }

      // 所有重试耗尽
      if (lastResponse) return lastResponse;
      throw new HttpError("All API keys exhausted", 503);
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const isRateLimitOrForbidden = (status) => {
  return status === 429 || status === 403;
};

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

/**
 * 统一的 API 调用结果记录（提取自三个 handler 中的重复代码）
 * 仅对 Key 相关错误（401/403/429）递增 error_count
 */
async function recordApiResult(response, selectedKeyInfo, poolManager, endpoint) {
  if (!selectedKeyInfo || !poolManager) return;

  try {
    let errorText = null;
    if (!response.ok) {
      try {
        errorText = await response.clone().text();
      } catch (e) {
        errorText = '无法获取错误详情';
      }
    }

    await poolManager.recordUsage(
      selectedKeyInfo.id, endpoint, response.status, 0, errorText
    );

    const status = response.status;
    if (status === 401 || status === 403 || status === 429) {
      await poolManager.recordError(
        selectedKeyInfo.id,
        `HTTP ${status}: ${errorText}`
      );
      if (status === 429 || status === 403) {
        await poolManager.disableKeyOnRateLimit(selectedKeyInfo.id);
      }
    }
  } catch (error) {
    console.error('记录使用统计失败:', error);
  }
}

async function dispatchHandler(endpoint, reqBody, apiKey, apiVersion) {
  switch (endpoint) {
    case "chat/completions":
      return await handleCompletions(reqBody, apiKey, apiVersion);
    case "embeddings":
      return await handleEmbeddings(reqBody, apiKey, apiVersion);
    case "models":
      return await handleModels(apiKey, apiVersion);
  }
}

const BASE_URL = "https://generativelanguage.googleapis.com";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels(apiKey, apiVersion = "v1beta") {
  const response = await fetch(`${BASE_URL}/${apiVersion}/models`, {
    headers: makeHeaders(apiKey),
  });

  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "gemini-embedding-001";
async function handleEmbeddings(req, apiKey, apiVersion = "v1beta") {
  let modelFull, model;
  switch (true) {
    case typeof req.model !== "string":
      throw new HttpError("model is not specified", 400);
    case req.model.startsWith("models/"):
      modelFull = req.model;
      model = modelFull.substring(7);
      break;
    case req.model.startsWith("gemini-"):
      model = req.model;
      break;
    default:
      model = DEFAULT_EMBEDDINGS_MODEL;
  }
  modelFull = modelFull ?? "models/" + model;
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  const response = await fetch(`${BASE_URL}/${apiVersion}/${modelFull}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model: modelFull,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });

  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model,
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_MODEL = "gemini-2.5-flash";
async function handleCompletions(req, apiKey, apiVersion = "v1beta") {
  let model;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("gemma-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }
  model = model || DEFAULT_MODEL;
  let body = await transformRequest(req);
  const extra = req.extra_body?.google;
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig.thinkingConfig = extra.thinking_config;
    }
  }
  switch (true) {
    case model.endsWith(":search"):
      model = model.slice(0,-7);
      // eslint-disable-next-line no-fallthrough
    case req.model?.includes("-search-preview"):
      body.tools = body.tools || [];
      body.tools.push({googleSearch: {}});
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${apiVersion}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  body = response.body;
  if (response.ok) {
    let id = "chatcmpl-" + generateId();
    const shared = {};
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
          shared,
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      try {
        body = JSON.parse(body);
        if (!body.candidates) {
          throw new Error("Invalid completion object");
        }
      } catch (err) {
        console.error("Error parsing response:", err);
        return new Response(body, fixCors(response)); // output as is
      }
      body = processCompletionsResponse(body, model, id);
    }
  }
  return new Response(body, fixCors(response));
}

const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) {
    return;
  }
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  const obj = schema[schema.type];
  delete obj.strict;
  delete obj.parameters?.$schema;
  adjustProps(schema);
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount", // not for streaming
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK", // non-standard
  top_p: "topP",
};
const thinkingBudgetMap = {
  none: 0,
  //minimal: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
};
const transformConfig = (req) => {
  let cfg = {};
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
        // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  if (req.reasoning_effort) {
    cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }
  let response;
  try {
    response = JSON.parse(content);
  } catch (err) {
    console.error("Error parsing function response content:", err);
    throw new HttpError("Invalid function response: " + content, 400);
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }
  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    }
  };
};

const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type }, i) => {
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args;
    try {
      args = JSON.parse(argstr);
    } catch (err) {
      console.error("Error parsing function arguments:", err);
      throw new HttpError("Invalid function arguments: " + argstr, 400);
    }
    calls[id] = {i, name};
    return {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      }
    };
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    parts.push({ text: content });
    return parts;
  }
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool":
        // eslint-disable-next-line no-case-declarations
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "function") {
          const calls = parts?.calls;
          parts = []; parts.calls = calls;
          contents.push({
            role: "function", // ignored
            parts
          });
        }
        transformFnResponse(item, parts);
        continue;
      case "assistant":
        item.role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item) : await transformMsg(item)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some(part => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function");
    funcs.forEach(adjustSchema);
    tools = [{ function_declarations: funcs.map(schema => schema.function) }];
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [ req.tool_choice?.function?.name ] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => {
  const message = { role: "assistant", content: [] };
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        }
      });
    } else {
      message.content.push(part.text);
    }
  }
  message.content = message.content.join(SEP) || null;
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const notEmpty = (el) => Object.values(el).some(Boolean) ? el : undefined;
const sum = (...numbers) => numbers.reduce((total, num) => total + (num ?? 0), 0);
const transformUsage = (data) => ({
  completion_tokens: sum(data.candidatesTokenCount, data.toolUsePromptTokenCount, data.thoughtsTokenCount),
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount,
  completion_tokens_details: notEmpty({
    audio_tokens: data.candidatesTokensDetails
      ?.find(el => el.modality === "AUDIO")
      ?.tokenCount,
    reasoning_tokens: data.thoughtsTokenCount,
  }),
  prompt_tokens_details: notEmpty({
    audio_tokens: data.promptTokensDetails
      ?.find(el => el.modality === "AUDIO")
      ?.tokenCount,
    cached_tokens: data.cacheTokensDetails
      ?.reduce((acc,el) => acc + el.tokenCount, 0),
  }),
});

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) { return; }
  if (promptFeedback?.blockReason) {
    console.log("Prompt block reason:", promptFeedback.blockReason);
    if (promptFeedback.blockReason === "SAFETY") {
      promptFeedback.safetyRatings
        .filter(r => r.blocked)
        .forEach(r => console.log(r));
    }
    choices.push({
      index: 0,
      [key]: null,
      finish_reason: "content_filter",
    });
  }
  return true;
};

const processCompletionsResponse = (data, model, id) => {
  const obj = {
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? model,
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream(chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now()/1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
function toOpenAiStream(line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!this.shared.is_buffers_rest) { line += delimiter; } // fixed: was =+
    controller.enqueue(line); // output as is
    return;
  }
  const obj = {
    id: this.id,
    choices: data.candidates.map(transformCandidatesDelta),
    model: data.modelVersion ?? this.model,
    object: "chat.completion.chunk",
    usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  const cand = obj.choices[0];
  cand.index = cand.index || 0; // absent in new -002 models response
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!this.last[cand.index]) { // first
    controller.enqueue(sseline({
      ...obj,
      choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
    }));
  }
  delete cand.delta.role;
  if ("content" in cand.delta) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  this.last[cand.index] = obj;
}
function toOpenAiStreamFlush(controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
