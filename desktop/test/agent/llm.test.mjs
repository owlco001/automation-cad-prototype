import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { OpenAiCompatibleClient, testLlmConnection } from '../../src/agent/llm.ts';

const tools = [
  'list_components',
  'search_components',
  'import_cad',
  'get_bom',
  'run_interference_check',
  'insert_component',
  'undo_last'
].map((name) => ({ name, description: `${name} 描述`, inputSchema: { type: 'object', properties: {} } }));

async function startServer(handler) {
  let captured;
  const bodies = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      captured = {
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      };
      bodies.push(captured.body);
      handler(captured, response);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    get captured() {
      return captured;
    },
    get bodies() {
      return bodies;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function jsonResponse(response, status, payload, statusText = '') {
  const headers = { 'content-type': 'application/json' };
  if (statusText) response.writeHead(status, statusText, headers);
  else response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

test('LLM 客户端在发出请求前拒绝向远程 HTTP 发送 API Key', () => {
  let fetchCalls = 0;
  assert.throws(() => new OpenAiCompatibleClient({
    baseUrl: 'http://llm.example.com/v1',
    apiKey: 'sk-secret',
    model: 'gpt-test',
    tools,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('不应发起请求');
    }
  }), /明文传输 API Key/);
  assert.equal(fetchCalls, 0);
});

test('LLM 客户端发送工具表并解析 tool_calls', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 200, {
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'list_components', arguments: '{"category":"气缸"}' }
          }]
        }
      }]
    });
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools
    });
    const result = await client.chat([{ role: 'user', content: '列出气缸' }]);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'list_components');
    assert.equal(result.toolCalls[0].function.arguments, '{"category":"气缸"}');
    assert.equal(server.captured.authorization, 'Bearer sk-local-secret-1234');
    assert.equal(server.captured.body.tools.length, tools.length);
    assert.equal(server.captured.body.tool_choice, 'auto');
  } finally {
    await server.close();
  }
});

test('LLM 客户端在同一会话中动态读取工具清单，不需重建或重载', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 200, { choices: [{ message: { content: '收到' } }] });
  });
  try {
    const plcTool = { name: 'verify_plc_program', description: '验证 PLC 程序', inputSchema: { type: 'object' } };
    let enabled = true;
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: '',
      model: 'gpt-test',
      tools: () => enabled ? [plcTool] : []
    });
    await client.chat([{ role: 'user', content: '验证程序' }]);
    assert.deepEqual(server.bodies[0].tools.map((tool) => tool.function.name), ['verify_plc_program']);

    enabled = false;
    await client.chat([{ role: 'user', content: '再检查一次' }]);
    assert.equal('tools' in server.bodies[1], false);

    enabled = true;
    await client.chat([{ role: 'user', content: '重新启用后检查' }]);
    assert.deepEqual(server.bodies[2].tools.map((tool) => tool.function.name), ['verify_plc_program']);
  } finally {
    await server.close();
  }
});

test('LLM 客户端解析最终文本响应', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 200, {
      choices: [{ message: { content: '  已完成检查  ' } }]
    });
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools
    });
    const result = await client.chat([{ role: 'user', content: '检查干涉' }]);
    assert.equal(result.content, '已完成检查');
    assert.deepEqual(result.toolCalls, []);
  } finally {
    await server.close();
  }
});

test('非 2xx 返回含状态码的中文错误且不泄露 apiKey', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 401, { error: { message: 'bad key' } }, 'Unauthorized');
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools
    });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'ping' }]),
      (error) => {
        assert.equal(error.code, 'LLM_HTTP_ERROR');
        assert.match(error.message, /模型服务返回错误/);
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /sk-local-secret-1234/);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test('LLM 请求超时返回中文超时错误', async () => {
  const server = await startServer((_captured, response) => {
    setTimeout(() => jsonResponse(response, 200, { choices: [{ message: { content: 'late' } }] }), 400);
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools,
      timeoutMs: 40
    });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'ping' }]),
      (error) => error.code === 'LLM_TIMEOUT' && /超时/.test(error.message)
    );
  } finally {
    await server.close();
  }
});

test('测试连接发送 ping 且 max_tokens=8', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 200, { choices: [{ message: { content: 'pong' } }] });
  });
  try {
    const result = await testLlmConnection({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      maxIterations: 6
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /连接成功/);
    assert.equal(server.captured.body.max_tokens, 8);
    assert.deepEqual(server.captured.body.messages, [{ role: 'user', content: 'ping' }]);
    assert.equal('tools' in server.captured.body, false);
  } finally {
    await server.close();
  }
});

test('LLM 客户端默认发送 response_format=json_object 作为第一道保险', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 200, { choices: [{ message: { content: '', tool_calls: [] } }] });
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools
    });
    await client.chat([{ role: 'user', content: '只输出 JSON' }]);
    assert.deepEqual(server.captured.body.response_format, { type: 'json_object' });
  } finally {
    await server.close();
  }
});

test('LLM 端点不支持 response_format 时自动去掉并重试一次', async () => {
  const server = await startServer((captured, response) => {
    if (captured.body.response_format) {
      jsonResponse(response, 400, { error: { message: 'Unsupported parameter: response_format' } }, 'Bad Request');
      return;
    }
    jsonResponse(response, 200, {
      choices: [{ message: { content: '', tool_calls: [{
        id: 'call-retry',
        type: 'function',
        function: { name: 'list_components', arguments: '{}' }
      }] } }]
    });
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools
    });
    const result = await client.chat([{ role: 'user', content: '列出元件' }]);
    assert.equal(server.bodies.length, 2);
    assert.ok(server.bodies[0].response_format);
    assert.equal('response_format' in server.bodies[1], false);
    assert.equal(result.toolCalls[0].function.name, 'list_components');
  } finally {
    await server.close();
  }
});

test('LLM responseFormat:false 时不发送 response_format', async () => {
  const server = await startServer((_captured, response) => {
    jsonResponse(response, 200, { choices: [{ message: { content: 'ok' } }] });
  });
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: server.baseUrl,
      apiKey: 'sk-local-secret-1234',
      model: 'gpt-test',
      tools,
      responseFormat: false
    });
    await client.chat([{ role: 'user', content: 'ping' }]);
    assert.equal('response_format' in server.captured.body, false);
  } finally {
    await server.close();
  }
});
