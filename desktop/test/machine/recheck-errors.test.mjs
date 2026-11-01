// 复核错误的可操作性：401/403 要点名 FT_BUILD_TOKEN，响应非 JSON 要带状态码，
// 且任何错误信息都不准出现 token 原文 —— 包括 base64 形态、片段形态和长随机串。
//
// 这些用例全部用注入的 fake fetch（替换 globalThis.fetch），不发真实网络、不依赖 sidecar。
//
// 位置说明：纯逻辑单测按 `test/MODULE.md` 的分层约定放在 test/**/*.test.mjs，
// 跟 src/ 同目录的 `*.test.ts` 只是历史写法（node --test 顺手也能收集），不再新增。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { recheckPairs } from '../../src/machine/recheck.ts';
import { buildRecheckReport, buildSkipReport, describePair } from '../../scripts/boolean-recheck.mjs';

const TOKEN = 'ftk-live-9f3a2b7c1d4e'; // 专门用来验证「错误信息里不出现 token 原文」

/** token 的 base64（自己算，避免用例和实现共用同一段代码）。 */
const TOKEN_B64 = Buffer.from(TOKEN, 'utf8').toString('base64');

function part(id, center = [0, 0, 0]) {
  return {
    id,
    name: id,
    role: 'structure',
    shape: { type: 'box', size: [20, 20, 20] },
    center,
    rotationZDeg: 0,
    color: '#888888',
    material: 'Q235',
    bomGroup: 'structure'
  };
}

const PARTS = [part('a'), part('b', [10, 0, 0])];
const SUSPECTS = [{ a: 'a', b: 'b' }];

const originalFetch = globalThis.fetch;
const seen = [];

/** 把 globalThis.fetch 换成固定响应；每个用例结束自动还原。 */
function stubFetch(make) {
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: headers.get('authorization') });
    return make();
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  seen.length = 0;
});

test('401：错误信息点名 FT_BUILD_TOKEN、带状态码，且不含 token 原文', async () => {
  stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }));
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false, '鉴权失败不能声称复核过');
  assert.equal(result.checked, 0);
  assert.match(result.message ?? '', /FT_BUILD_TOKEN/);
  assert.match(result.message ?? '', /401/);
  assert.match(result.message ?? '', /--token/, '要给「核对 --token」这条可操作提示');
  assert.ok(!(result.message ?? '').includes(TOKEN), `错误信息泄露了 token：${result.message}`);
  assert.equal(seen.length, 1);
});

test('403 且没带 token：提示里也点名 FT_BUILD_TOKEN 并说明请求没带 token', async () => {
  stubFetch(() => new Response('forbidden', { status: 403 }));
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test' });

  assert.equal(result.available, false);
  assert.match(result.message ?? '', /403/);
  assert.match(result.message ?? '', /FT_BUILD_TOKEN/);
  assert.match(result.message ?? '', /没带 token/);
  assert.equal(seen[0]?.authorization, null, '没给 token 就不该带 Authorization 头');
});

test('200 但 body 是非 JSON（HTML）：报出含状态码与摘要的明确错误，且不泄 token', async () => {
  stubFetch(
    () =>
      new Response('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
  );
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false, '解析不了响应就不能说复核过');
  assert.match(result.message ?? '', /不是可解析的 JSON/);
  assert.match(result.message ?? '', /HTTP 200/, '必须带 HTTP 状态码');
  assert.match(result.message ?? '', /<html>/, '必须带响应摘要，便于判断是错误页');
  assert.ok(!(result.message ?? '').includes(TOKEN), '错误信息不得含 token');
  // 请求侧确实带了 Bearer，且我们没把它回显进 message
  assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`);
});

test('500 空响应体：错误信息说清「空响应体」并带状态码', async () => {
  stubFetch(() => new Response('', { status: 500 }));
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false);
  assert.match(result.message ?? '', /HTTP 500/);
  assert.match(result.message ?? '', /空响应体/);
  assert.ok(!(result.message ?? '').includes(TOKEN));
});

test('500 错误页回显了 Authorization：摘要里的 Bearer/token 必须被抹掉', async () => {
  stubFetch(
    () =>
      new Response(`Unauthorized: Authorization: Bearer ${TOKEN} rejected by proxy`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      })
  );
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false);
  assert.match(result.message ?? '', /HTTP 500/);
  assert.ok(!(result.message ?? '').includes(TOKEN), `回显的 token 必须被脱敏：${result.message}`);
  assert.match(result.message ?? '', /\*\*\*/, '被抹掉的位置应留下 ***');
});

test('回归：200 + 合法 JSON 的判定口径不变（真撞 / AABB 误报）', async () => {
  stubFetch(() => new Response(JSON.stringify({ ok: true, pairs: [{ overlapMm3: 42.5 }] }), { status: 200 }));
  const hit = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test/', token: TOKEN });
  assert.equal(hit.available, true);
  assert.equal(hit.checked, 1);
  assert.equal(hit.confirmed, 1);
  assert.equal(hit.misreported, 0);
  assert.equal(hit.pairs[0]?.overlapMm3, 42.5);
  assert.equal(seen[0]?.url, 'http://sidecar.test/interfere', '末尾斜杠只应保留一个');

  stubFetch(() => new Response(JSON.stringify({ ok: true, pairs: [{ overlapMm3: 0 }] }), { status: 200 }));
  const miss = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test' });
  assert.equal(miss.available, true);
  assert.equal(miss.confirmed, 0);
  assert.equal(miss.misreported, 1);
});

// —— 以下是本轮复审整改新增：P1-1 与 P2-1/P2-2/P2-3/P2-4 ——

test('P1-1：200 + ok:false 且 message 回显 Bearer —— pairs[0].reason 不得含 token 原文', async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify({ ok: false, message: `bad token: Authorization: Bearer ${TOKEN}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  );
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  const reason = result.pairs[0]?.reason ?? '';
  assert.equal(result.pairs[0]?.verdict, 'unchecked', 'sidecar 明说失败，不能记成「不撞」');
  assert.ok(!reason.includes(TOKEN), `reason 泄露了 token：${reason}`);
  assert.match(reason, /\*\*\*/, '被抹掉的位置应留下 ***');
  assert.match(reason, /bad token/, '脱敏不能把可排查的信息一起抹掉');
  // 这条 reason 会进 CI 日志 / case.json / Qt 弹窗，任何一处漏都是凭证泄露
  assert.ok(!JSON.stringify(result).includes(TOKEN), `结果序列化后仍含 token：${JSON.stringify(result)}`);
});

test('P2-2：fetch 自身抛错时，错误文案同样要脱敏（与读 body 失败同一口径）', async () => {
  globalThis.fetch = async () => {
    throw new Error(`connect ECONNREFUSED http://sidecar.test (Authorization: Bearer ${TOKEN})`);
  };
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false);
  assert.match(result.message ?? '', /不可用/);
  assert.ok(!(result.message ?? '').includes(TOKEN), `fetch 错误路径泄露了 token：${result.message}`);
  assert.match(result.message ?? '', /\*\*\*/, '被抹掉的位置应留下 ***');
  assert.match(result.message ?? '', /ECONNREFUSED/, '排查需要的信息要保留');
});

test('P2-1：错误页回显 token 的 base64（Basic 认证形态）也要抹掉', async () => {
  stubFetch(
    () =>
      new Response(`proxy rejected: Authorization: Basic ${TOKEN_B64}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      })
  );
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false);
  assert.ok(!(result.message ?? '').includes(TOKEN_B64), `base64 形态泄露：${result.message}`);
  assert.ok(!(result.message ?? '').includes(TOKEN), '原文更不能出现');
  assert.match(result.message ?? '', /HTTP 502/);
});

test('P2-1：token 片段 + 长随机串走兜底规则（宁可多抹，不可漏抹）', async () => {
  const prefix = TOKEN.slice(0, 8); // ftk-live 这类前缀，整词替换挡不住
  const signature = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  stubFetch(
    () =>
      new Response(`bad request: token prefix ${prefix}; signature=${signature}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      })
  );
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false);
  assert.ok(!(result.message ?? '').includes(signature), `长随机串原样带出：${result.message}`);
  assert.ok(!(result.message ?? '').includes(prefix), `token 片段原样带出：${result.message}`);
  assert.match(result.message ?? '', /bad request/, '摘要里的可读部分要留着');
});

test('P2-3：JSON 合法但不是对象，文案说「不是预期的 JSON 对象」而不是「不是可解析的 JSON」', async () => {
  stubFetch(() => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const result = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false);
  assert.match(result.message ?? '', /不是预期的 JSON 对象/, 'body=null 是形状问题，不是解析问题');
  assert.ok(!/不是可解析的 JSON/.test(result.message ?? ''), `文案把形状问题说成了解析问题：${result.message}`);
  assert.match(result.message ?? '', /HTTP 200/);

  // 数组同理：旧代码会一路 payload.ok===undefined 变成「复核过但没撞」，现在是明确的不可用
  stubFetch(() => new Response('[{"ok":true}]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const arrayBody = await recheckPairs(PARTS, SUSPECTS, { buildUrl: 'http://sidecar.test', token: TOKEN });
  assert.equal(arrayBody.available, false);
  assert.match(arrayBody.message ?? '', /不是预期的 JSON 对象/);
});

test('P2-4：中途失败时，已经复核完的对不丢（checked 计数 + pairs 保留）', async () => {
  const parts = [part('a'), part('b', [10, 0, 0]), part('c', [20, 0, 0])];
  const suspects = [
    { a: 'a', b: 'b' },
    { a: 'b', b: 'c' }
  ];
  let call = 0;
  stubFetch(() => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ ok: true, pairs: [{ overlapMm3: 42.5 }] }), { status: 200 });
    return new Response('<html>502</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  });
  const result = await recheckPairs(parts, suspects, { buildUrl: 'http://sidecar.test', token: TOKEN });

  assert.equal(result.available, false, '第二对失败，整体仍不可用');
  assert.equal(result.checked, 1, '已完成的那一对必须计入 checked（以前是 0）');
  assert.equal(result.confirmed, 1, '真撞的结论不能因为后面失败而消失');
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0]?.a, 'a');
  assert.equal(result.pairs[0]?.overlapMm3, 42.5);
  assert.match(result.message ?? '', /已完成 1\/2 对/, '文案要说明这次到底拿到了多少结论');
});

// —— 以下是第二轮复审整改（W3 残留）——

test('反向用例：脱敏不许抹掉定位信息（长零件 id / UUID / 型号必须留着）', async () => {
  // 上一版的兜底 `/[A-Za-z0-9_\-+/]{20,}/` 会把这条摘要糊成 `unknown part id: *** (ST-8800)`，
  // 也就是把「是哪个零件」——复核失败时唯一有用的信息——抹没了。
  const body =
    'unknown part id: station-1-rotary-table-assembly (ST-8800), ' +
    'case 3f2a91c4-77be-4d0e-9a51-2b8c0d4e6f71, model ASM-WD-8800-PRO-X2, ' +
    'signature q9Xv2LmN4pR7sT1uW3yZ6aB8, retry later';
  const parts = [part('a'), part('b', [10, 0, 0]), part('c', [20, 0, 0])];
  const suspects = [
    { a: 'a', b: 'b' },
    { a: 'b', b: 'c' }
  ];
  let call = 0;
  stubFetch(() => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ ok: true, pairs: [{ overlapMm3: 0 }] }), { status: 200 });
    return new Response(body, { status: 502, headers: { 'Content-Type': 'text/plain' } });
  });
  const result = await recheckPairs(parts, suspects, { buildUrl: 'http://sidecar.test', token: TOKEN });
  const message = result.message ?? '';

  assert.equal(result.available, false);
  assert.ok(
    message.includes('station-1-rotary-table-assembly'),
    `长零件 id 被脱敏抹掉了（这正是「哪个零件」的唯一线索）：${message}`
  );
  assert.ok(message.includes('ST-8800'), `零件型号被抹掉了：${message}`);
  assert.ok(
    message.includes('3f2a91c4-77be-4d0e-9a51-2b8c0d4e6f71'),
    `UUID 被抹掉了（日志关联要靠它）：${message}`
  );
  assert.ok(message.includes('ASM-WD-8800-PRO-X2'), `机型被抹掉了：${message}`);
  assert.match(message, /retry later/, '可读部分要留着');
  // 但「长得像凭据」的串（大小写+数字混合的 24 字符）仍然必须抹：收紧不等于放行
  assert.ok(!message.includes('q9Xv2LmN4pR7sT1uW3yZ6aB8'), `凭据形态的长串被放过了：${message}`);
  assert.match(message, /\*\*\*/, '被抹掉的位置应留下 ***');
  assert.ok(!message.includes(TOKEN), 'token 原文仍然不得出现');
});

test('P2：中途失败的附注不再提 pairs 这个 JSON 字段名', async () => {
  const parts = [part('a'), part('b', [10, 0, 0]), part('c', [20, 0, 0])];
  let call = 0;
  stubFetch(() => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ ok: true, pairs: [{ overlapMm3: 0 }] }), { status: 200 });
    return new Response('<html>502</html>', { status: 200 });
  });
  const result = await recheckPairs(
    parts,
    [
      { a: 'a', b: 'b' },
      { a: 'b', b: 'c' }
    ],
    { buildUrl: 'http://sidecar.test', token: TOKEN }
  );
  const message = result.message ?? '';

  assert.equal(result.available, false);
  assert.equal(result.checked, 1);
  assert.match(message, /已完成 1\/2 对，其余未复核/, '文案要直接说「还有多少未复核」');
  assert.ok(!message.includes('pairs'), `弹窗里没有 pairs 这个指代，不能出现在文案里：${message}`);
});

test('CLI 分支：available=false 且已完成若干对 → UNAVAILABLE + PARTIAL 明细，退出码 1', () => {
  const report = buildRecheckReport({
    checked: 1,
    confirmed: 1,
    misreported: 0,
    unchecked: 0,
    pairs: [{ a: 'base-1', b: 'plate-1', overlapMm3: 12.5, verdict: 'confirmed' }],
    available: false,
    message: '复核不可用：sidecar 响应不是可解析的 JSON（HTTP 502），无法判定干涉。（本次已完成 1/2 对，其余未复核）'
  });

  assert.equal(report.status, 'unavailable');
  assert.equal(report.exitCode, 1, '退出码语义不变：还是非 0');
  assert.match(report.lines[0], /^BOOLEAN_RECHECK_UNAVAILABLE 复核不可用：/);
  assert.ok(
    report.lines.includes('BOOLEAN_RECHECK_PARTIAL checked=1 confirmed=1 misreported=0 unchecked=0'),
    `缺 PARTIAL 汇总行：${report.lines.join(' | ')}`
  );
  assert.ok(
    report.lines.some((line) => line.includes('真撞 base-1 × plate-1 12.5 mm³')),
    `已完成的对必须打出来：${report.lines.join(' | ')}`
  );
  assert.ok(report.lines.some((line) => line.includes('中断前已完成的复核')));
});

test('CLI 分支：available=false 且一对都没跑完 → 只打 UNAVAILABLE，不打 PARTIAL', () => {
  const report = buildRecheckReport({
    checked: 0,
    confirmed: 0,
    misreported: 0,
    unchecked: 0,
    pairs: [],
    available: false,
    message: '复核不可用：fetch failed（结论仍是 AABB 初筛，不能当真实布尔）'
  });

  assert.equal(report.exitCode, 1);
  assert.equal(report.lines.length, 1, `没有已完成的对就不该打明细：${report.lines.join(' | ')}`);
  assert.match(report.lines[0], /^BOOLEAN_RECHECK_UNAVAILABLE /);
  assert.ok(!report.lines.some((line) => line.includes('BOOLEAN_RECHECK_PARTIAL')));
});

test('CLI 分支：available=true → OK 汇总 + 明细 + 可选附注，退出码 0', () => {
  const report = buildRecheckReport({
    checked: 2,
    confirmed: 0,
    misreported: 2,
    unchecked: 0,
    pairs: [
      { a: 'a', b: 'b', overlapMm3: 0, verdict: 'misreported' },
      { a: 'b', b: 'c', overlapMm3: 0, verdict: 'misreported' }
    ],
    available: true,
    message: '只复核了前 2/5 对（其余仍是 AABB 初筛）'
  });

  assert.equal(report.status, 'ok');
  assert.equal(report.exitCode, 0);
  assert.match(report.lines[0], /^BOOLEAN_RECHECK_OK checked=2 confirmed=0 misreported=2 unchecked=0$/);
  assert.equal(report.lines.filter((line) => line.includes('AABB 误报')).length, 2);
  assert.ok(report.lines.some((line) => line.startsWith('  注：只复核了前 2/5 对')));
});

test('CLI：describePair 三种结论的标签与附加信息', () => {
  assert.equal(
    describePair({ a: 'x', b: 'y', overlapMm3: 3.5, verdict: 'confirmed' }),
    '  真撞 x × y 3.5 mm³'
  );
  assert.equal(describePair({ a: 'x', b: 'y', overlapMm3: 0, verdict: 'misreported' }), '  AABB 误报 x × y 0 mm³');
  assert.equal(
    describePair({ a: 'x', b: 'y', overlapMm3: null, verdict: 'unchecked', reason: '零件不在几何里' }),
    '  复核不了 x × y（零件不在几何里）'
  );
  assert.match(buildSkipReport().lines[0], /^BOOLEAN_RECHECK_SKIP /);
  assert.equal(buildSkipReport().exitCode, 0);
});

// —— 下面两条起真 server 跑真脚本：分支判定整体（读 case.json → 复核 → 打印 → 退出码）真跑一遍 ——

const SCRIPT = fileURLToPath(new URL('../../scripts/boolean-recheck.mjs', import.meta.url));

function cliCase() {
  const dir = mkdtempSync(join(tmpdir(), 'boolean-recheck-'));
  const path = join(dir, 'case.json');
  // 三个 20mm 方块，中心相隔 10mm：a×b、b×c 各 10mm 重叠 → 2 对疑似（a×c 刚好贴面，不算）
  writeFileSync(
    path,
    JSON.stringify({ geometry: { parts: [part('a'), part('b', [10, 0, 0]), part('c', [20, 0, 0])] } }),
    'utf8'
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 起本地 sidecar 替身；handler 收到解析后的请求体，返回 { status, body }。 */
async function startSidecar(handler) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const reply = handler(body ? JSON.parse(body) : {});
      response.writeHead(reply.status, {
        'Content-Type': reply.type ?? 'application/json',
        Connection: 'close'
      });
      response.end(reply.body);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done))
  };
}

function runCli(args) {
  // 必须异步 spawn：spawnSync 会卡住本进程的事件循环，同进程里的 sidecar 替身就永远回不了包。
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, FT_BUILD_URL: '', FT_BUILD_TOKEN: '' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

test('CLI 端到端：中途不可用 → 退出码 1，PARTIAL 汇总 + 已完成的对 + 中断说明', async () => {
  const fixture = cliCase();
  let calls = 0;
  const sidecar = await startSidecar(() => {
    // 第 1 对正常返回「不撞」，第 2 对故意返回 HTML —— 模拟反代 502
    calls += 1;
    if (calls === 1) return { status: 200, body: JSON.stringify({ ok: true, pairs: [{ overlapMm3: 0 }] }) };
    return { status: 502, body: '<html>502 Bad Gateway</html>', type: 'text/html' };
  });
  try {
    const result = await runCli(['--case', fixture.path, '--url', sidecar.url, '--token', TOKEN]);

    const stdout = result.stdout ?? '';
    assert.equal(result.status, 1, `中途不可用时退出码必须是 1，实际 ${result.status}\n${stdout}\n${result.stderr}`);
    assert.match(stdout, /AABB 初筛：3 个零件，疑似干涉 2 对/);
    assert.match(stdout, /BOOLEAN_RECHECK_UNAVAILABLE /);
    assert.match(stdout, /BOOLEAN_RECHECK_PARTIAL checked=1 confirmed=0 misreported=1 unchecked=0/, stdout);
    assert.match(stdout, /AABB 误报 a × b 0 mm³/, '已完成的那一对必须打出来');
    assert.match(stdout, /中断前已完成的复核/);
    assert.ok(!stdout.includes(TOKEN), 'CLI 输出不得出现 token');
    assert.ok(!stdout.includes('BOOLEAN_RECHECK_OK'), '不可用时不能打 OK 行');
  } finally {
    await sidecar.close();
    fixture.cleanup();
  }
});

test('CLI 端到端：全部复核完成 → OK 汇总 + 明细，退出码 0；没给 --url 走 SKIP', async () => {
  const fixture = cliCase();
  const sidecar = await startSidecar(() => ({
    status: 200,
    body: JSON.stringify({ ok: true, pairs: [{ overlapMm3: 4.5 }] })
  }));
  try {
    const result = await runCli(['--case', fixture.path, '--url', sidecar.url]);
    const stdout = result.stdout ?? '';
    assert.equal(result.status, 0, `全部完成时退出码必须是 0\n${stdout}\n${result.stderr}`);
    assert.match(stdout, /BOOLEAN_RECHECK_OK checked=2 confirmed=2 misreported=0 unchecked=0/);
    assert.equal((stdout.match(/真撞 /g) ?? []).length, 2, '两对都要打出来');

    const skip = await runCli(['--case', fixture.path]);
    assert.equal(skip.status, 0);
    assert.match(skip.stdout ?? '', /BOOLEAN_RECHECK_SKIP 没给 --url\/FT_BUILD_URL/);
  } finally {
    await sidecar.close();
    fixture.cleanup();
  }
});
