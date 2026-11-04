// 视觉自检（P2）：capture_view 之后把压缩截图以 OpenAI 兼容 image_url 回灌；模型不支持时
// 必须硬降级为纯文本并明说「未看到图像」，绝不给出「看起来没问题」这类伪造结论。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { AgentSession } from '../../src/agent/session.ts';
import { LlmError, OpenAiCompatibleClient } from '../../src/agent/llm.ts';
import {
  VISION_MAX_BYTES,
  VISION_MAX_EDGE,
  decodePng,
  encodePng
} from '../../src/agent/vision-image.ts';
import {
  VISION_DEGRADED_REPLY_NOTICE,
  VISION_NOT_SEEN_MARK,
  buildVisionSkippedMessage,
  isVisionRejection,
  loadShotImage
} from '../../src/agent/vision.ts';
import { mergeLlmConfig, normalizeLlmConfig, publicLlmConfig } from '../../src/agent/llm-config.ts';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-vision-'));
  mkdirSync(join(sandbox, 'agent-shots'), { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function solidImage(width, height, rgba = [30, 120, 200, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

/** 确定性伪随机噪声：几乎不可压缩，用来验证「超 400 KB → 真压缩」。 */
function noiseImage(width, height, seed = 7) {
  const data = new Uint8Array(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < width * height; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i * 4] = state & 0xff;
    data[i * 4 + 1] = (state >>> 8) & 0xff;
    data[i * 4 + 2] = (state >>> 16) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function writeShot(name, image) {
  const path = join(sandbox, 'agent-shots', name);
  writeFileSync(path, Buffer.from(encodePng(image)));
  return path;
}

function captureResult(path, view = '3d', width = 1600, height = 1000) {
  return {
    ok: true,
    data: { path, bytes: 1234, sha256: 'a'.repeat(64), width, height, view }
  };
}

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function imagePartsIn(messages) {
  return messages.flatMap((message) => (Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'image_url')
    : []));
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i];
  }
  return null;
}

function createLlm(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (typeof response === 'function') return await response(messages, calls.length);
      return response;
    }
  };
}

function createBus(shot) {
  const calls = [];
  return {
    calls,
    async execute(name, args = {}) {
      calls.push({ name, args });
      if (name === 'capture_view') return shot;
      return { ok: true, data: { name, args } };
    },
    async undoLast() {
      return { ok: true, data: { command: 'undo' } };
    }
  };
}

function createSession(llm, bus, vision = {}) {
  return new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    maxIterations: 6,
    vision: { mode: 'auto', userDataDir: sandbox, ...vision }
  });
}

// ---------------------------------------------------------------------------
// 1) off：永不发图，截图只回文本
// ---------------------------------------------------------------------------
test('vision=off：capture_view 只回文本，请求里没有 image_url', async () => {
  const shotPath = writeShot('off-3d.png', solidImage(64, 48));
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'capture_view', { view: '3d' })] },
    { content: '截图已落盘，按配置不发图。', toolCalls: [] }
  ]);
  const session = createSession(llm, createBus(captureResult(shotPath)), { mode: 'off' });
  const reply = await session.run('看下 3D 视图对不对');

  assert.equal(reply, '截图已落盘，按配置不发图。');
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(imagePartsIn(llm.calls[1]), [], 'off 模式不得下发任何图片段');
  // 仍然要有一条文本回执，明确告诉模型它没看到图。
  const feedback = lastUserMessage(llm.calls[1]);
  assert.equal(typeof feedback.content, 'string');
  assert.match(feedback.content, /vision 配置为 off/);
  assert.ok(feedback.content.includes(VISION_NOT_SEEN_MARK), '未发图时必须写「未看到图像」');
});

// ---------------------------------------------------------------------------
// 2) auto：首发带 image_url，data URL 前缀与尺寸都对
// ---------------------------------------------------------------------------
test('vision=auto：capture_view 成功后追加 user 消息，content 为 text + image_url 两段', async () => {
  const shotPath = writeShot('auto-3d.png', solidImage(1600, 1000, [200, 40, 40, 255]));
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'capture_view', { view: '3d' })] },
    { content: '我看到红色背景的 3D 视口。', toolCalls: [] }
  ]);
  const session = createSession(llm, createBus(captureResult(shotPath)));
  await session.run('看下 3D 视图');

  const parts = imagePartsIn(llm.calls[1]);
  assert.equal(parts.length, 1, 'auto 模式首发必须带一张图');
  const url = parts[0].image_url.url;
  assert.ok(url.startsWith('data:image/png;base64,'), `data URL 前缀不对：${url.slice(0, 32)}`);
  const sent = decodePng(new Uint8Array(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')));
  assert.ok(Math.max(sent.width, sent.height) <= VISION_MAX_EDGE, '长边必须 ≤1024');
  assert.equal(sent.width, 1024);
  assert.equal(sent.height, 640);

  const feedback = lastUserMessage(llm.calls[1]);
  assert.equal(feedback.role, 'user');
  assert.ok(Array.isArray(feedback.content));
  assert.equal(feedback.content[0].type, 'text');
  assert.match(feedback.content[0].text, /这是刚才请求的视图截图（3d，1024x640）/);
  assert.match(feedback.content[0].text, /看不到就说看不到/);
  // 同一条消息里既不能把图塞给 tool 角色，也不能丢一句「没看到图」的兜底要求。
  assert.ok(feedback.content[0].text.includes(VISION_NOT_SEEN_MARK));
  const toolMessage = llm.calls[1].find((message) => message.role === 'tool');
  assert.equal(typeof toolMessage.content, 'string', 'tool 角色只能是字符串');
  assert.ok(!toolMessage.content.includes('base64'));
});

// ---------------------------------------------------------------------------
// 3) 服务端 400 提到 image → 去掉图重试一次 + VISION_UNSUPPORTED 标记
// ---------------------------------------------------------------------------
async function startServer(script) {
  const bodies = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const step = script[bodies.length] ?? 'text';
      bodies.push({ body, step });
      if (step === 'tool') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [toolCall(`call-${bodies.length}`, 'capture_view', { view: '3d' })]
            }
          }]
        }));
        return;
      }
      if (step === 'reject') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: { message: 'image_url is not a valid content part for this model', type: 'invalid_request_error' }
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '模型回复：只能按尺寸判断。' } }]
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function realClient(baseUrl) {
  return new OpenAiCompatibleClient({
    baseUrl,
    apiKey: '',
    model: 'text-only-model',
    tools: [{ name: 'capture_view', description: '截图', inputSchema: { type: 'object', properties: {} } }],
    // 关掉 response_format 自动重试，让「图片被拒」这条路径不被格式降级干扰。
    responseFormat: false
  });
}

test('服务端 400 提到 image：自动去掉图重试一次，回复带降级说明与审计 VISION_UNSUPPORTED', async () => {
  const shotPath = writeShot('reject-3d.png', solidImage(800, 600, [10, 200, 10, 255]));
  const server = await startServer(['tool', 'reject', 'text']);
  const audits = [];
  try {
    const session = new AgentSession({
      llm: realClient(server.baseUrl),
      bus: createBus(captureResult(shotPath)),
      confirmWrite: async () => true,
      maxIterations: 6,
      audit: (record) => audits.push(record),
      vision: { mode: 'auto', userDataDir: sandbox }
    });
    const reply = await session.run('看下视图');

    assert.equal(server.bodies.length, 3, '第一次带图被拒 → 同一条请求去图重发一次');
    assert.equal(imagePartsIn(server.bodies[0].body.messages).length, 0, '首个请求还没有截图');
    assert.equal(imagePartsIn(server.bodies[1].body.messages).length, 1, '第二次请求带图');
    assert.equal(imagePartsIn(server.bodies[2].body.messages).length, 0, '重试必须不带图');
    // 去图后仍保留「未看到图像」的文字，模型不会凭空描述画面。
    const retryText = lastUserMessage(server.bodies[2].body.messages).content;
    assert.ok(typeof retryText === 'string' && retryText.includes(VISION_NOT_SEEN_MARK));

    assert.match(reply, /模型回复/);
    // 硬要求：回复末尾明说「不支持图片 + 只能按尺寸/哈希判断」。
    assert.ok(reply.includes(VISION_DEGRADED_REPLY_NOTICE), `回复里要明说不支持图片：${reply}`);
    assert.match(reply.trimEnd(), /（当前模型不支持图片，本次只能根据尺寸\/哈希判断。）$/);
    const degraded = audits.find((record) => record.code === 'VISION_UNSUPPORTED');
    assert.ok(degraded, '降级必须留审计');
    assert.equal(degraded.ok, false);
    assert.equal(degraded.tool, 'capture_view');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4) 降级后第二轮不再发图（本会话永久降级）
// ---------------------------------------------------------------------------
test('降级后同一会话第二轮：capture_view 不再发图，只回「未看到图像」文本', async () => {
  const shotPath = writeShot('degraded-3d.png', solidImage(800, 600));
  const server = await startServer(['tool', 'reject', 'text', 'tool', 'text']);
  try {
    const session = new AgentSession({
      llm: realClient(server.baseUrl),
      bus: createBus(captureResult(shotPath)),
      confirmWrite: async () => true,
      maxIterations: 6,
      vision: { mode: 'auto', userDataDir: sandbox }
    });
    await session.run('看下视图');
    const second = await session.run('再看一次');

    assert.equal(server.bodies.length, 5);
    const secondTurn = server.bodies.slice(3).map(({ body }) => body.messages);
    assert.equal(imagePartsIn(secondTurn[0]).length, 0);
    assert.equal(imagePartsIn(secondTurn[1]).length, 0, '降级后第二轮不能再发图');
    const feedback = lastUserMessage(secondTurn[1]);
    assert.match(feedback.content, /VISION_UNSUPPORTED/);
    assert.ok(feedback.content.includes(VISION_NOT_SEEN_MARK));
    assert.match(second, /模型回复/);
    // 历史里的图已摘掉：不会有第二轮请求偷偷带上 base64。
    assert.ok(secondTurn.every((messages) => imagePartsIn(messages).length === 0));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5) 超 400 KB 自动压缩：长边 ≤1024 且 ≤400 KB，像素内容仍然对得上
// ---------------------------------------------------------------------------
test('超过 400 KB 的截图自动压缩到 ≤400 KB 且长边 ≤1024（内容仍是同一张图）', () => {
  const source = noiseImage(1200, 900);
  const png = Buffer.from(encodePng(source));
  assert.ok(png.length > VISION_MAX_BYTES, `构造的图要足够大，实际 ${png.length} 字节`);
  const path = join(sandbox, 'agent-shots', 'big.png');
  writeFileSync(path, png);

  const loaded = loadShotImage(sandbox, path);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.ok(loaded.bytes <= VISION_MAX_BYTES, `压缩后 ${loaded.bytes} 字节，仍超过 400 KB`);
  assert.ok(Math.max(loaded.width, loaded.height) <= VISION_MAX_EDGE);
  assert.ok(loaded.bytes < loaded.sourceBytes, '必须真的变小');
  assert.equal(loaded.mime, 'image/png');
  assert.match(loaded.dataUrl, /^data:image\/png;base64,/);

  const decoded = decodePng(new Uint8Array(Buffer.from(loaded.dataUrl.split(',')[1], 'base64')));
  assert.equal(decoded.width, loaded.width);
  assert.equal(decoded.height, loaded.height);
  // 4x4 块的均值与源图对应区域均值一致（±8）：证明缩放/编码没有错位或花屏。
  const blockMean = (image, x0, y0, x1, y1) => {
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * image.width + x) * 4;
        sum += image.data[index] + image.data[index + 1] + image.data[index + 2];
        count += 3;
      }
    }
    return sum / count;
  };
  const sourceBlock = blockMean(source, 100, 100, 140, 140);
  const scaleX = loaded.width / source.width;
  const scaleY = loaded.height / source.height;
  const scaledBlock = blockMean(
    decoded,
    Math.floor(100 * scaleX),
    Math.floor(100 * scaleY),
    Math.floor(140 * scaleX),
    Math.floor(140 * scaleY)
  );
  assert.ok(Math.abs(sourceBlock - scaledBlock) < 8, `缩放后均值偏差过大：${sourceBlock} vs ${scaledBlock}`);
});

// ---------------------------------------------------------------------------
// 6) 路径越界拒读：只允许 agent-shots 下的 png/jpg（realpath 后判前缀）
// ---------------------------------------------------------------------------
test('只允许读 agent-shots 目录：越界路径与指向外部的符号链接都拒读', () => {
  const outside = join(sandbox, 'secret.png');
  writeFileSync(outside, Buffer.from(encodePng(solidImage(16, 16))));
  const outsideResult = loadShotImage(sandbox, outside);
  assert.equal(outsideResult.ok, false);
  assert.equal(outsideResult.code, 'VISION_PATH_DENIED');

  const traversal = join(sandbox, 'agent-shots', '..', 'secret.png');
  assert.equal(loadShotImage(sandbox, traversal).code, 'VISION_PATH_DENIED', '../ 逃逸必须拒');

  const link = join(sandbox, 'agent-shots', 'link.png');
  symlinkSync(outside, link);
  assert.equal(loadShotImage(sandbox, link).code, 'VISION_PATH_DENIED', '符号链接指到外部必须拒');

  const missing = loadShotImage(sandbox, join(sandbox, 'agent-shots', 'nope.png'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'VISION_UNREADABLE');

  const jpeg = join(sandbox, 'agent-shots', 'fake.png');
  writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  const notPng = loadShotImage(sandbox, jpeg);
  assert.equal(notPng.ok, false);
  assert.equal(notPng.code, 'VISION_UNSUPPORTED_FORMAT');

  assert.equal(loadShotImage(undefined, outside).code, 'VISION_UNREADABLE');
});

test('越界路径经会话回灌时也拒读：不发图，文本里给出原因码', async () => {
  const outside = join(sandbox, 'secret.png');
  writeFileSync(outside, Buffer.from(encodePng(solidImage(16, 16))));
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'capture_view', { view: '3d' })] },
    { content: '未看到图像，只能按尺寸与哈希判断。', toolCalls: [] }
  ]);
  const session = createSession(llm, createBus(captureResult(outside)));
  await session.run('看下视图');

  assert.deepEqual(imagePartsIn(llm.calls[1]), []);
  const feedback = lastUserMessage(llm.calls[1]);
  assert.match(feedback.content, /VISION_PATH_DENIED/);
  assert.ok(feedback.content.includes(VISION_NOT_SEEN_MARK));
});

// ---------------------------------------------------------------------------
// 7) 未见图的提示词快照：必须要求模型声明「未看到图像」
// ---------------------------------------------------------------------------
test('未发图提示词快照：包含「未看到图像」且禁止「看起来没问题」类结论', () => {
  const shot = { path: '/x/agent-shots/1-3d.png', view: '3d', width: 1600, height: 1000 };
  const parts = buildVisionSkippedMessage(shot, 'VISION_UNSUPPORTED：当前模型不支持图片');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'text');
  assert.equal(
    parts[0].text,
    [
      `这是刚才请求的视图截图（3d，1600x1000），但本次没有把图像发给你：VISION_UNSUPPORTED：当前模型不支持图片。`,
      `你${VISION_NOT_SEEN_MARK}：不要猜测画面内容，不要给「看起来没问题」这类结论。`,
      `只能根据 path/bytes/sha256 与尺寸说明这张图存在且未被校验过画面，并在回复里明确写出「${VISION_NOT_SEEN_MARK}」。`
    ].join('\n')
  );
});

test('带图提示词里也留了「没收到图就说没看到」的兜底，模型不能只夸尺寸', async () => {
  const shotPath = writeShot('guard-3d.png', solidImage(320, 200));
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'capture_view', { view: 'linkage' })] },
    { content: '已确认。', toolCalls: [] }
  ]);
  const session = createSession(llm, createBus(captureResult(shotPath, 'linkage', 1600, 1000)));
  await session.run('看下联调视图');

  const feedback = lastUserMessage(llm.calls[1]);
  const text = feedback.content[0].text;
  assert.ok(text.includes('如果你实际没有收到图像'));
  assert.ok(text.includes(VISION_NOT_SEEN_MARK));
  assert.match(text, /不要下「看起来没问题」的结论/);
});

// ---------------------------------------------------------------------------
// 8) on 模式：强制发图，但被拒仍然降级而不是把请求弄挂
// ---------------------------------------------------------------------------
test('vision=on：强制发图；服务端拒图也走降级重试，本轮仍然有回复', async () => {
  const shotPath = writeShot('on-3d.png', solidImage(400, 300));
  const audits = [];
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'capture_view', { view: '3d' })] },
    (messages) => {
      if (imagePartsIn(messages).length > 0) {
        throw new LlmError('LLM_HTTP_ERROR', '模型服务返回错误：HTTP 400', {
          status: 400,
          detail: '{"error":{"message":"image input is not supported"}}'
        });
      }
      return { content: '未看到图像，只能按尺寸判断。', toolCalls: [] };
    }
  ]);
  const session = new AgentSession({
    llm,
    bus: createBus(captureResult(shotPath)),
    confirmWrite: async () => true,
    maxIterations: 6,
    audit: (record) => audits.push(record),
    vision: { mode: 'on', userDataDir: sandbox }
  });
  const reply = await session.run('看下视图');

  assert.equal(llm.calls.length, 3, 'on 模式也要先发图，被拒后重试一次');
  assert.equal(imagePartsIn(llm.calls[1]).length, 1, 'on 模式必须强制带图');
  assert.equal(imagePartsIn(llm.calls[2]).length, 0, '重试不带图');
  assert.match(reply, /未看到图像/);
  assert.ok(audits.some((record) => record.code === 'VISION_UNSUPPORTED'));
});

// ---------------------------------------------------------------------------
// 10) 编解码自证：encodePng → decodePng 逐像素一致（缩放前的图不能被改花）
// ---------------------------------------------------------------------------
test('PNG 编解码逐像素无损：渐变 + 噪点 + 透明都原样回来（五种行过滤都跑到）', () => {
  const width = 257;
  const height = 129;
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const index = (y * width + x) * 4;
      data[index] = (x * 3 + y) & 0xff;
      data[index + 1] = (x * 7) & 0xff;
      data[index + 2] = seed & 0x1f;
      data[index + 3] = x % 3 === 0 ? 128 : 255;
    }
  }
  const decoded = decodePng(encodePng({ width, height, data }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  let mismatched = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== decoded.data[i]) mismatched += 1;
  }
  assert.equal(mismatched, 0, `${mismatched} 个通道值在编解码后变了`);
});

// ---------------------------------------------------------------------------
// 12) 配置字段：默认 auto，非法值报中文错，merge 不重置用户选择
// ---------------------------------------------------------------------------
test('agent-llm.json 的 vision 字段：默认 auto、非法值报错、保存时不丢', () => {
  const fallback = normalizeLlmConfig({});
  assert.equal(fallback.vision, 'auto');
  assert.equal(normalizeLlmConfig({ vision: 'off' }).vision, 'off');
  assert.equal(normalizeLlmConfig({ vision: 'on' }).vision, 'on');
  assert.throws(() => normalizeLlmConfig({ vision: 'yes' }), /vision 必须是 auto \/ on \/ off 之一/);
  const merged = mergeLlmConfig({ ...fallback, vision: 'off' }, { model: 'gpt-x' });
  assert.equal(merged.vision, 'off', '面板只改模型名时不能把 vision 重置回 auto');
  assert.equal(publicLlmConfig(merged).vision, 'off');
});

// ---------------------------------------------------------------------------
// 11) 误降级防护：与图片无关的 400 不触发降级
// ---------------------------------------------------------------------------
test('与图片无关的 400 不算视觉不支持，不触发降级重试', () => {
  const notVision = new LlmError('LLM_HTTP_ERROR', '模型服务返回错误：HTTP 400', {
    status: 400,
    detail: '{"error":{"message":"invalid request: max_tokens is required"}}'
  });
  assert.equal(isVisionRejection(notVision), false);

  const vision = new LlmError('LLM_HTTP_ERROR', '模型服务返回错误：HTTP 400', {
    status: 400,
    detail: '{"error":{"message":"content[1].type image_url is not supported"}}'
  });
  assert.equal(isVisionRejection(vision), true);

  const malformed = new LlmError('LLM_HTTP_ERROR', '模型服务返回错误：HTTP 422', {
    status: 422,
    detail: '{"error":{"message":"invalid content type in messages[2].content"}}'
  });
  assert.equal(isVisionRejection(malformed), true);

  assert.equal(isVisionRejection(new LlmError('LLM_TIMEOUT', '超时')), false);
  assert.equal(isVisionRejection(new Error('boom')), false);
});
