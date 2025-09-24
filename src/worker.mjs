import { Buffer } from "node:buffer";
import { ApiKeyPoolManager } from "./db-manager.mjs";

// 懒加载包装器类
class LazyApiKeyPoolManager {
  constructor(db) {
    this._db = db;
    this._instance = null;
  }

  _getInstance() {
    if (!this._instance) {
      this._instance = new ApiKeyPoolManager(this._db);
    }
    return this._instance;
  }

  async getNextApiKey() {
    return this._getInstance().getNextApiKey();
  }

  async recordUsage(keyId, endpoint, status, tokensUsed, errorMessage) {
    return this._getInstance().recordUsage(keyId, endpoint, status, tokensUsed, errorMessage);
  }

  async recordError(keyId, errorMessage) {
    return this._getInstance().recordError(keyId, errorMessage);
  }

  async getAllApiKeys() {
    return this._getInstance().getAllApiKeys();
  }

  async addApiKey(apiKey, gmailEmail, notes) {
    return this._getInstance().addApiKey(apiKey, gmailEmail, notes);
  }

  async addApiKeysBatch(apiKeys) {
    return this._getInstance().addApiKeysBatch(apiKeys);
  }

  async deleteApiKey(keyId) {
    return this._getInstance().deleteApiKey(keyId);
  }

  async toggleApiKey(keyId, isActive) {
    return this._getInstance().toggleApiKey(keyId, isActive);
  }

  async getUsageStats(days) {
    return this._getInstance().getUsageStats(days);
  }

  async setConfig(key, value, description) {
    return this._getInstance().setConfig(key, value, description);
  }

  get db() {
    return this._getInstance().db;
  }
}

export default {
  async fetch (request, env) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    // 使用懒加载的数据库连接池管理器
    const poolManager = new LazyApiKeyPoolManager(env.LOG);

    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };

    try {
      const { pathname } = new URL(request.url);

      // 管理端点路由
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        return handleAdminEndpoints(request, poolManager, pathname);
      }

      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };

      // 获取API Key
      const auth = request.headers.get("Authorization");
      let apiKey = auth?.split(" ")[1];
      let selectedKeyInfo = null;

      if (!apiKey) {
        try {
          // 从连接池获取API Key
          selectedKeyInfo = await poolManager.getNextApiKey();
          apiKey = selectedKeyInfo.api_key;
          console.log(`使用连接池API Key: ${selectedKeyInfo.gmail_email}`);
        } catch (error) {
          console.error("获取API Key失败:", error.message);
          // 如果数据库连接池没有可用的key，回退到环境变量
          if (env?.GEMINI_API_KEYS) {
            const keys = String(env.GEMINI_API_KEYS)
              .split(",")
              .map(s => s.trim())
              .filter(Boolean);
            if (keys.length) {
              const index = Math.floor(Math.random() * keys.length);
              apiKey = keys[index];
              console.log(`回退使用环境变量API KEY ${index}: ${apiKey}`);
            }
          }
        }
      }

      // API端点路由
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey, selectedKeyInfo, poolManager)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey, selectedKeyInfo, poolManager)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey, selectedKeyInfo, poolManager)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
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

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels (apiKey, selectedKeyInfo = null, poolManager = null) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });

  // 记录使用统计
  if (selectedKeyInfo && poolManager) {
    try {
      await poolManager.recordUsage(
        selectedKeyInfo.id,
        'models',
        response.status,
        0, // models端点不涉及token使用
        response.ok ? null : await response.clone().text()
      );

      if (!response.ok) {
        await poolManager.recordError(selectedKeyInfo.id, `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error('记录使用统计失败:', error);
    }
  }

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
async function handleEmbeddings (req, apiKey, selectedKeyInfo = null, poolManager = null) {
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
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${modelFull}:batchEmbedContents`, {
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

  // 记录使用统计
  if (selectedKeyInfo && poolManager) {
    try {
      await poolManager.recordUsage(
        selectedKeyInfo.id,
        'embeddings',
        response.status,
        0, // embeddings的token计算比较复杂，暂时设为0
        response.ok ? null : await response.clone().text()
      );

      if (!response.ok) {
        await poolManager.recordError(selectedKeyInfo.id, `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error('记录使用统计失败:', error);
    }
  }

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
async function handleCompletions (req, apiKey, selectedKeyInfo = null, poolManager = null) {
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
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  // 记录使用统计
  let tokensUsed = 0;
  if (selectedKeyInfo && poolManager) {
    try {
      // 对于流式响应，我们无法立即获取token统计，所以先记录请求
      await poolManager.recordUsage(
        selectedKeyInfo.id,
        'chat/completions',
        response.status,
        tokensUsed, // 流式响应的token会在后续更新
        response.ok ? null : await response.clone().text()
      );

      if (!response.ok) {
        await poolManager.recordError(selectedKeyInfo.id, `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error('记录使用统计失败:', error);
    }
  }

  body = response.body;
  if (response.ok) {
    let id = "chatcmpl-" + generateId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
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
  return adjustProps(schema);
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
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
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
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return parts;
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
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
  //console.info(JSON.stringify(contents, 2));
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
    //original_finish_reason: cand.finishReason,
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
      //original_finish_reason: data.promptFeedback.blockReason,
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
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0 ) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream (chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
function parseStreamFlush (controller) {
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
function toOpenAiStream (line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!this.shared.is_buffers_rest) { line =+ delimiter; }
    controller.enqueue(line); // output as is
    return;
  }
  const obj = {
    id: this.id,
    choices: data.candidates.map(transformCandidatesDelta),
    //created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? this.model,
    //system_fingerprint: "fp_69829325d0",
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
function toOpenAiStreamFlush (controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

/**
 * 处理管理端点请求
 */
async function handleAdminEndpoints(request, poolManager, pathname) {
  const { method } = request;
  const url = new URL(request.url);

  try {
    switch (true) {
      // 获取所有API Keys
      case pathname === "/admin/keys" && method === "GET":
        const keys = await poolManager.getAllApiKeys();

        // 确保keys是数组
        const keysArray = Array.isArray(keys) ? keys : (keys?.results || []);

        return new Response(JSON.stringify({
          success: true,
          data: keysArray.map(key => ({
            ...key,
            api_key: key.api_key.substring(0, 10) + "..." // 隐藏完整的API key
          }))
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 200
        }));

      // 添加新的API Key
      case pathname === "/admin/keys" && method === "POST":
        const { api_key, gmail_email, notes } = await request.json();
        if (!api_key || !gmail_email) {
          throw new HttpError("api_key 和 gmail_email 是必填字段", 400);
        }
        const keyId = await poolManager.addApiKey(api_key, gmail_email, notes);
        return new Response(JSON.stringify({
          success: true,
          message: "API Key添加成功",
          data: { id: keyId }
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 201
        }));

      // 批量添加API Keys
      case pathname === "/admin/keys/batch" && method === "POST":
        const { api_keys } = await request.json();
        if (!api_keys || !Array.isArray(api_keys) || api_keys.length === 0) {
          throw new HttpError("api_keys 必须是非空数组", 400);
        }
        const batchResult = await poolManager.addApiKeysBatch(api_keys);
        return new Response(JSON.stringify({
          success: true,
          message: `批量添加完成: 成功${batchResult.success.length}个, 失败${batchResult.errors.length}个`,
          data: batchResult
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 201
        }));

      // 删除API Key
      case pathname.startsWith("/admin/keys/") && method === "DELETE":
        const keyId2 = parseInt(pathname.split("/").pop());
        if (isNaN(keyId2)) {
          throw new HttpError("无效的key ID", 400);
        }
        await poolManager.deleteApiKey(keyId2);
        return new Response(JSON.stringify({
          success: true,
          message: "API Key删除成功"
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 200
        }));

      // 启用/禁用API Key
      case pathname.startsWith("/admin/keys/") && pathname.endsWith("/toggle") && method === "POST":
        const keyId3 = parseInt(pathname.split("/")[3]);
        const { is_active } = await request.json();
        if (isNaN(keyId3)) {
          throw new HttpError("无效的key ID", 400);
        }
        await poolManager.toggleApiKey(keyId3, is_active);
        return new Response(JSON.stringify({
          success: true,
          message: `API Key已${is_active ? '启用' : '禁用'}`
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 200
        }));

      // 获取使用统计
      case pathname === "/admin/stats" && method === "GET":
        const days = parseInt(url.searchParams.get("days")) || 7;
        const stats = await poolManager.getUsageStats(days);
        return new Response(JSON.stringify({
          success: true,
          data: stats
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 200
        }));

      // 获取连接池配置
      case pathname === "/admin/config" && method === "GET":
        const configs = await poolManager.db.prepare(`
          SELECT key, value, description FROM pool_config ORDER BY key
        `).all();
        return new Response(JSON.stringify({
          success: true,
          data: configs
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 200
        }));

      // 更新连接池配置
      case pathname === "/admin/config" && method === "POST":
        const { key, value, description } = await request.json();
        if (!key || value === undefined) {
          throw new HttpError("key 和 value 是必填字段", 400);
        }
        await poolManager.setConfig(key, value, description);
        return new Response(JSON.stringify({
          success: true,
          message: "配置更新成功"
        }, null, 2), fixCors({
          headers: { "Content-Type": "application/json" },
          status: 200
        }));

      // 管理面板首页
      case pathname === "/admin" && method === "GET":
        try {
          const htmlContent = await getAdminHTML();
          return new Response(htmlContent, fixCors({
            headers: { "Content-Type": "text/html" },
            status: 200
          }));
        } catch (error) {
          console.error("读取管理页面失败:", error);
          return new Response("管理页面加载失败", fixCors({
            headers: { "Content-Type": "text/plain" },
            status: 500
          }));
        }

      // 静态文件服务 - 在 Workers 环境中不支持文件系统访问
      case pathname.startsWith("/public/") && method === "GET":
        return new Response('Static file access not supported in Workers environment', fixCors({ status: 404 }));

      default:
        throw new HttpError("管理端点不存在", 404);
    }
  } catch (error) {
    console.error("管理端点错误:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }, null, 2), fixCors({
      headers: { "Content-Type": "application/json" },
      status: error.status || 500
    }));
  }
}

// 移除了 handleStaticFile 函数，因为在 Cloudflare Workers 环境中无法使用 fs 模块
// 静态内容现在直接内嵌在 getAdminHTML 函数中

/**
 * 获取管理面板HTML
 */
async function getAdminHTML() {
  // 直接返回内嵌的HTML内容，避免在Workers环境中使用fs模块
    return `<!DOCTYPE html>
<html lang="zh-CN">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini API Keys 连接池管理</title>
    <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    }

    h1 {
      color: #333;
      text-align: center;
      margin-bottom: 30px;
    }

    .section {
      margin-bottom: 30px;
    }

    .section h2 {
      color: #555;
      border-bottom: 2px solid #007bff;
      padding-bottom: 10px;
    }

    .form-group {
      margin-bottom: 15px;
    }

    label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
    }

    input,
    textarea,
    select {
      width: 100%;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-sizing: border-box;
    }

    button {
      background: #007bff;
      color: white;
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      margin: 5px 5px 5px 0;
    }

    button:hover {
      background: #0056b3;
    }

    button:disabled {
      background: #6c757d;
      cursor: not-allowed;
    }

    .btn-danger {
      background: #dc3545;
    }

    .btn-danger:hover {
      background: #c82333;
    }

    .btn-success {
      background: #28a745;
    }

    .btn-success:hover {
      background: #218838;
    }

    .btn-warning {
      background: #ffc107;
      color: #212529;
    }

    .btn-warning:hover {
      background: #e0a800;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }

    th,
    td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }

    th {
      background-color: #f8f9fa;
      font-weight: bold;
    }

    .status-active {
      color: #28a745;
      font-weight: bold;
    }

    .status-inactive {
      color: #dc3545;
      font-weight: bold;
    }

    .api-key {
      font-family: monospace;
      background: #f8f9fa;
      padding: 2px 6px;
      border-radius: 3px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .stat-card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 6px;
      text-align: center;
    }

    .stat-number {
      font-size: 2em;
      font-weight: bold;
      color: #007bff;
    }

    .message {
      padding: 10px;
      border-radius: 4px;
      margin: 10px 0;
    }

    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }

    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }

    .message.warning {
      background: #fff3cd;
      color: #856404;
      border: 1px solid #ffeaa7;
    }

    /* 选项卡样式 */
    .tabs {
      display: flex;
      margin-bottom: 20px;
      border-bottom: 2px solid #dee2e6;
    }

    .tab-button {
      padding: 12px 24px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 16px;
      color: #666;
    }

    .tab-button.active {
      color: #007bff;
      border-bottom-color: #007bff;
      font-weight: bold;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* 批量添加样式 */
    .batch-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    .batch-input {
      min-height: 300px;
    }

    .batch-preview {
      background: #f8f9fa;
      border: 1px solid #dee2e6;
      border-radius: 4px;
      padding: 15px;
    }

    .preview-item {
      padding: 8px;
      margin: 5px 0;
      background: white;
      border-radius: 4px;
      border-left: 4px solid #007bff;
    }

    .preview-item.error {
      border-left-color: #dc3545;
      background: #f8d7da;
    }

    .batch-stats {
      display: flex;
      gap: 20px;
      margin: 15px 0;
    }

    .batch-stat {
      padding: 10px;
      background: #e9ecef;
      border-radius: 4px;
      text-align: center;
      min-width: 80px;
    }

    .batch-stat .number {
      font-size: 1.5em;
      font-weight: bold;
      color: #007bff;
    }

    .batch-stat.error .number {
      color: #dc3545;
    }

    .batch-result {
      margin-top: 20px;
    }

    .result-section {
      margin: 15px 0;
    }

    .result-section h4 {
      margin: 10px 0;
    }

    .result-item {
      padding: 8px;
      margin: 5px 0;
      border-radius: 4px;
    }

    .result-success {
      background: #d4edda;
      border-left: 4px solid #28a745;
    }

    .result-error {
      background: #f8d7da;
      border-left: 4px solid #dc3545;
    }
    </style>
</head>

<body>
  <div class="container">
    <h1>🔑 Gemini API Keys 连接池管理</h1>

    <div id="message"></div>

    <div class="section">
      <div class="tabs">
        <button class="tab-button active" onclick="switchTab('single')">单个添加</button>
        <button class="tab-button" onclick="switchTab('batch')">批量添加</button>
    </div>

      <!-- 单个添加选项卡 -->
      <div id="single-tab" class="tab-content active">
        <h2>添加新的 API Key</h2>
        <div class="form-group">
          <label for="apiKey">API Key:</label>
          <input type="text" id="apiKey" placeholder="输入Gemini API Key">
        </div>
        <div class="form-group">
          <label for="gmailEmail">Gmail邮箱:</label>
          <input type="email" id="gmailEmail" placeholder="输入对应的Gmail邮箱">
        </div>
        <div class="form-group">
          <label for="notes">备注:</label>
          <textarea id="notes" placeholder="可选的备注信息"></textarea>
        </div>
        <button onclick="addApiKey()">添加 API Key</button>
      </div>

      <!-- 批量添加选项卡 -->
      <div id="batch-tab" class="tab-content">
        <h2>批量添加 API Keys</h2>
        <p>请从Excel表格中复制数据并粘贴到下方文本框。支持的格式：</p>
        <ul>
          <li>第一列：API Key</li>
          <li>第二列：Gmail邮箱</li>
          <li>第三列：备注（可选）</li>
        </ul>

        <div class="batch-container">
          <div>
            <label for="batchData">Excel数据:</label>
            <textarea id="batchData" class="batch-input" placeholder="请从Excel复制粘贴数据到这里...
例如：
AIzaSyABC123...    user1@gmail.com    备注1
AIzaSyDEF456...    user2@gmail.com    备注2" oninput="parseBatchData()"></textarea>

            <div class="batch-stats" id="batchStats" style="display: none;">
              <div class="batch-stat">
                <div class="number" id="totalCount">0</div>
                <div>总计</div>
              </div>
              <div class="batch-stat">
                <div class="number" id="validCount">0</div>
                <div>有效</div>
              </div>
              <div class="batch-stat error">
                <div class="number" id="errorCount">0</div>
                <div>错误</div>
              </div>
            </div>

            <button id="batchSubmitBtn" onclick="submitBatchData()" disabled>提交批量添加</button>
            <button onclick="clearBatchData()">清空数据</button>
          </div>

          <div>
            <label>预览:</label>
            <div id="batchPreview" class="batch-preview">
              <p style="color: #666; text-align: center;">请在左侧输入数据以查看预览</p>
            </div>
          </div>
        </div>

        <div id="batchResult" class="batch-result" style="display: none;"></div>
      </div>
    </div>

    <div class="section">
      <h2>API Keys 列表</h2>
      <button onclick="loadApiKeys()">刷新列表</button>
      <div id="apiKeysTable"></div>
    </div>

    <div class="section">
      <h2>使用统计</h2>
      <label for="statsDays">统计天数:</label>
      <select id="statsDays" onchange="loadStats()">
        <option value="1">1天</option>
        <option value="7" selected>7天</option>
        <option value="30">30天</option>
      </select>
      <div id="statsContainer"></div>
    </div>
  </div>

  <script>
    let parsedBatchData = [];

    function showMessage(message, type = 'success') {
      const messageDiv = document.getElementById('message');
      messageDiv.innerHTML = \`<div class="message \${type}">\${message}</div>\`;
      setTimeout(() => messageDiv.innerHTML = '', 5000);
    }

    function switchTab(tabName) {
      // 隐藏所有选项卡内容
      document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
      document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));

      // 显示选中的选项卡
      document.getElementById(tabName + '-tab').classList.add('active');
      event.target.classList.add('active');
    }

    function parseBatchData() {
      const data = document.getElementById('batchData').value.trim();
      const preview = document.getElementById('batchPreview');
      const stats = document.getElementById('batchStats');
      const submitBtn = document.getElementById('batchSubmitBtn');

      if (!data) {
        preview.innerHTML = '<p style="color: #666; text-align: center;">请在左侧输入数据以查看预览</p>';
        stats.style.display = 'none';
        submitBtn.disabled = true;
        parsedBatchData = [];
        return;
      }

      const lines = data.split('\\n').filter(line => line.trim());
      parsedBatchData = [];
      let validCount = 0;
      let errorCount = 0;

      const previewHtml = lines.map((line, index) => {
        const columns = line.split('\\t').map(col => col.trim());
        if (columns.length === 1) {
          // 尝试用空格分割
          const spaceColumns = line.split(/\\s+/).filter(col => col.trim());
          if (spaceColumns.length >= 2) {
            columns.splice(0, columns.length, ...spaceColumns);
          }
        }

        const apiKey = columns[0] || '';
        const email = columns[1] || '';
        const notes = columns[2] || '';

        let isValid = true;
        let errors = [];

        if (!apiKey) {
          errors.push('API Key不能为空');
          isValid = false;
        }
        if (!email) {
          errors.push('邮箱不能为空');
          isValid = false;
        } else if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
          errors.push('邮箱格式不正确');
          isValid = false;
        }

        if (isValid) {
          validCount++;
          parsedBatchData.push({ api_key: apiKey, gmail_email: email, notes });
        } else {
          errorCount++;
        }

        const errorText = errors.length > 0 ? \` (错误: \${errors.join(', ')})\` : '';
        const className = isValid ? 'preview-item' : 'preview-item error';

        return \`<div class="\${className}">
                    <strong>第\${index + 1}行:</strong> \${apiKey.substring(0, 15)}... | \${email} | \${notes || '无备注'}\${errorText}
                </div>\`;
      }).join('');

      preview.innerHTML = previewHtml;

      // 更新统计
      document.getElementById('totalCount').textContent = lines.length;
      document.getElementById('validCount').textContent = validCount;
      document.getElementById('errorCount').textContent = errorCount;
      stats.style.display = 'flex';

      // 启用/禁用提交按钮
      submitBtn.disabled = validCount === 0;
    }

    function clearBatchData() {
      document.getElementById('batchData').value = '';
      parseBatchData();
      document.getElementById('batchResult').style.display = 'none';
    }

    async function submitBatchData() {
      if (parsedBatchData.length === 0) {
        showMessage('没有有效的数据可以提交', 'error');
        return;
      }

      const submitBtn = document.getElementById('batchSubmitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';

      try {
        const response = await fetch('/admin/keys/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_keys: parsedBatchData })
        });

        const result = await response.json();

        if (result.success) {
          showMessage(result.message, 'success');

          // 显示详细结果
          const resultDiv = document.getElementById('batchResult');
          let resultHtml = '<h3>批量添加结果</h3>';

          if (result.data.success.length > 0) {
            resultHtml += \`
                            <div class="result-section">
                                <h4 style="color: #28a745;">✅ 成功添加 (\${result.data.success.length}个)</h4>
                                \${result.data.success.map(item => \`
                                    <div class="result-success">
                                        第\${item.index}行: \${item.api_key} | \${item.gmail_email} | \${item.notes || '无备注'}
                                    </div>
                                \`).join('')}
                            </div>
                        \`;
          }

          if (result.data.errors.length > 0) {
            resultHtml += \`
                            <div class="result-section">
                                <h4 style="color: #dc3545;">❌ 添加失败 (\${result.data.errors.length}个)</h4>
                                \${result.data.errors.map(item => \`
                                    <div class="result-error">
                                        第\${item.index}行: \${item.error}<br>
                                        数据: \${JSON.stringify(item.data)}
                                    </div>
                                \`).join('')}
                            </div>
                        \`;
          }

          resultDiv.innerHTML = resultHtml;
          resultDiv.style.display = 'block';

          // 刷新API Keys列表
          loadApiKeys();

          // 清空输入
          if (result.data.success.length > 0) {
            clearBatchData();
          }
        } else {
          showMessage(result.error || '批量添加失败', 'error');
        }
  } catch (error) {
        showMessage('网络错误: ' + error.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '提交批量添加';
      }
    }

    async function addApiKey() {
      const apiKey = document.getElementById('apiKey').value;
      const gmailEmail = document.getElementById('gmailEmail').value;
      const notes = document.getElementById('notes').value;

      if (!apiKey || !gmailEmail) {
        showMessage('请填写API Key和Gmail邮箱', 'error');
        return;
      }

      try {
        const response = await fetch('/admin/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, gmail_email: gmailEmail, notes })
        });

        const result = await response.json();
        if (result.success) {
          showMessage('API Key添加成功');
          document.getElementById('apiKey').value = '';
          document.getElementById('gmailEmail').value = '';
          document.getElementById('notes').value = '';
          loadApiKeys();
        } else {
          showMessage(result.error || '添加失败', 'error');
        }
      } catch (error) {
        showMessage('网络错误: ' + error.message, 'error');
      }
    }

    async function loadApiKeys() {
      try {
        const response = await fetch('/admin/keys');
        const result = await response.json();

        if (result.success) {
          const table = \`
                        <table>
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>API Key</th>
                                    <th>Gmail邮箱</th>
                                    <th>状态</th>
                                    <th>总请求数</th>
                                    <th>错误次数</th>
                                    <th>最后使用</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${result.data.map(key => \`
                                    <tr>
                                        <td>\${key.id}</td>
                                        <td><span class="api-key">\${key.api_key}</span></td>
                                        <td>\${key.gmail_email}</td>
                                        <td class="\${key.is_active ? 'status-active' : 'status-inactive'}">
                                            \${key.is_active ? '启用' : '禁用'}
                                        </td>
                                        <td>\${key.total_requests}</td>
                                        <td>\${key.error_count}</td>
                                        <td>\${key.last_used_at || '从未使用'}</td>
                                        <td>
                                            <button class="\${key.is_active ? 'btn-danger' : 'btn-success'}"
                                                    onclick="toggleApiKey(\${key.id}, \${!key.is_active})">
                                                \${key.is_active ? '禁用' : '启用'}
                                            </button>
                                            <button class="btn-danger" onclick="deleteApiKey(\${key.id})">删除</button>
                                        </td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    \`;
          document.getElementById('apiKeysTable').innerHTML = table;
        } else {
          showMessage(result.error || '加载失败', 'error');
        }
      } catch (error) {
        showMessage('网络错误: ' + error.message, 'error');
      }
    }

    async function toggleApiKey(id, isActive) {
      try {
        const response = await fetch(\`/admin/keys/\${id}/toggle\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: isActive })
        });

        const result = await response.json();
        if (result.success) {
          showMessage(result.message);
          loadApiKeys();
        } else {
          showMessage(result.error || '操作失败', 'error');
        }
      } catch (error) {
        showMessage('网络错误: ' + error.message, 'error');
      }
    }

    async function deleteApiKey(id) {
      if (!confirm('确定要删除这个API Key吗？')) return;

      try {
        const response = await fetch(\`/admin/keys/\${id}\`, { method: 'DELETE' });
        const result = await response.json();

        if (result.success) {
          showMessage('API Key删除成功');
          loadApiKeys();
        } else {
          showMessage(result.error || '删除失败', 'error');
        }
      } catch (error) {
        showMessage('网络错误: ' + error.message, 'error');
      }
    }

    async function loadStats() {
      const days = document.getElementById('statsDays').value;

      try {
        const response = await fetch(\`/admin/stats?days=\${days}\`);
        const result = await response.json();

        if (result.success) {
          const statsHtml = \`
                        <div class="stats-grid">
                            \${result.data.map(stat => \`
                                <div class="stat-card">
                                    <div class="stat-number">\${stat.request_count || 0}</div>
                                    <div>\${stat.gmail_email}</div>
                                    <div>平均Token: \${Math.round(stat.avg_tokens || 0)}</div>
                                    <div>错误: \${stat.error_count || 0}</div>
                                </div>
                            \`).join('')}
                        </div>
                    \`;
          document.getElementById('statsContainer').innerHTML = statsHtml;
        } else {
          showMessage(result.error || '加载统计失败', 'error');
        }
      } catch (error) {
        showMessage('网络错误: ' + error.message, 'error');
      }
    }

    // 页面加载时初始化数据
    window.onload = function () {
      loadApiKeys();
      loadStats();
    };
  </script>
</body>

</html>`;
}
