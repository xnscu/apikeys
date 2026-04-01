import { createServerAdapter } from '@whatwg-node/server'
import { createServer } from 'node:http'
import worker from "./src/worker.mjs";

const port = +(process.env.PORT || 8080);

// Node.js 环境没有 D1，传入 DB: null 会自动回退到 GEMINI_API_KEYS 环境变量
const env = {
  DB: null,
  GEMINI_API_KEYS: process.env.GEMINI_API_KEYS,
};

const serverAdapter = createServerAdapter((req) => worker.fetch(req, env))
const server = createServer(serverAdapter)
server.listen(port, () => {
  console.log('Listening on:', server.address());
})
