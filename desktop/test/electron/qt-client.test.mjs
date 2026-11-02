// qt-client.ts 的用例：路径解析 / 环境注入 / 退出码文案 走纯函数，
// launchQt 用真实 spawn（不 mock）验证「拿得到 pid、收得到 stderr、退出时算得出人话」，
// 以及三条 P1 的行为：秒退要 ok:false、重复启动不能再起孤儿、退出要能广播出去。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  LAUNCH_GRACE_MS,
  STATUS_DLL_NOT_FOUND,
  activeQtPid,
  activeQtPids,
  buildLaunchEnv,
  describeQtExit,
  headBytes,
  isElectronRuntimePath,
  killActiveQt,
  launchQt,
  resolvePipelinePath,
  resolveQtExe,
  subscribeQtExit,
  STDERR_LIMIT
} from '../../electron/qt-client.ts';

const dirs = [];
after(() => {
  // 兜底：万一某个用例中途失败，也别把长驻子进程留到 CI 结束
  killActiveQt(process.platform);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'qt-client-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 造一个「有 Qt」的目录，返回它的 exe 路径 */
function plantQt(dir) {
  const exeDir = join(dir, 'vendor', 'qt');
  mkdirSync(exeDir, { recursive: true });
  const exe = join(exeDir, 'automationcad-qt.exe');
  writeFileSync(exe, 'stub');
  return exe;
}

function plantPipeline(dir) {
  const pipelineDir = join(dir, 'vendor', 'pipeline');
  mkdirSync(pipelineDir, { recursive: true });
  const pipeline = join(pipelineDir, 'machine-design-cli.cjs');
  writeFileSync(pipeline, '// stub\n');
  return pipeline;
}

/** pid 还活着吗（0 号信号只探活，不真发信号） */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等进程真的消失（SIGTERM 是异步生效的，不能断言完就查） */
async function waitDead(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

/** 一套「有 Qt + 有管线」的 launchQt 入参：exe 用 node 自己冒充（真 spawn，不 mock） */
function launchArgs(appRoot, script) {
  return {
    isPackaged: false,
    appRoot,
    env: { AUTOMATIONCAD_QT_EXE: process.execPath },
    electronExePath: process.execPath,
    args: ['-e', script]
  };
}

const LONG_RUNNING = 'setInterval(() => {}, 1000)';

// ---- resolveQtExe ----

test('resolveQtExe：dev 态 AUTOMATIONCAD_QT_EXE 优先于 vendor/qt', () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  const override = join(tempDir(), 'custom-qt.exe');
  writeFileSync(override, 'stub');
  assert.equal(resolveQtExe({ isPackaged: false, appRoot, env: { AUTOMATIONCAD_QT_EXE: override } }), override);
});

test('resolveQtExe：打包态不采信 AUTOMATIONCAD_QT_EXE（P2：只认 resources/qt）', () => {
  const resourcesPath = join(tempDir(), 'resources');
  mkdirSync(join(resourcesPath, 'qt'), { recursive: true });
  const packaged = join(resourcesPath, 'qt', 'automationcad-qt.exe');
  writeFileSync(packaged, 'stub');
  const evil = join(tempDir(), 'evil.exe');
  writeFileSync(evil, 'stub'); // 真实存在，也不能赢
  assert.equal(
    resolveQtExe({ isPackaged: true, resourcesPath, env: { AUTOMATIONCAD_QT_EXE: evil } }),
    packaged,
    '打包态的 Qt 位置是确定的，环境变量不该把它顶掉'
  );
  // 只有 env 指向的 exe 存在时，打包态宁可返回 null，也不能去执行它
  assert.equal(resolveQtExe({ isPackaged: true, resourcesPath: join(tempDir(), 'resources'), env: { AUTOMATIONCAD_QT_EXE: evil } }), null);
});

test('resolveQtExe：打包态落在 resources/qt 下（extraResources 的位置）', () => {
  const resourcesPath = join(tempDir(), 'resources');
  const exe = join(resourcesPath, 'qt', 'automationcad-qt.exe');
  mkdirSync(join(resourcesPath, 'qt'), { recursive: true });
  writeFileSync(exe, 'stub');
  assert.equal(resolveQtExe({ isPackaged: true, resourcesPath, appRoot: '/nope/app.asar' }), exe);
});

test('resolveQtExe：dev 态落在 appRoot/vendor/qt 下', () => {
  const appRoot = tempDir();
  const exe = plantQt(appRoot);
  assert.equal(resolveQtExe({ isPackaged: false, appRoot, resourcesPath: '/nope/resources' }), exe);
});

test('resolveQtExe：env 指向不存在的文件时回落，且全部缺失才返回 null', () => {
  const appRoot = tempDir();
  const exe = plantQt(appRoot);
  // env 配错不该让入口报废：继续走 dev 候选
  assert.equal(resolveQtExe({ isPackaged: false, appRoot, env: { AUTOMATIONCAD_QT_EXE: '/nope/qt.exe' } }), exe);
  assert.equal(resolveQtExe({ isPackaged: false, appRoot: tempDir() }), null);
  assert.equal(resolveQtExe({ isPackaged: true }), null);
});

// ---- 管线路径 ----

test('resolvePipelinePath：打包态 resources/pipeline、dev 态 vendor/pipeline，缺失返回 null', () => {
  const appRoot = tempDir();
  assert.equal(resolvePipelinePath({ isPackaged: false, appRoot }), null);
  const pipeline = plantPipeline(appRoot);
  assert.equal(resolvePipelinePath({ isPackaged: false, appRoot }), pipeline);
  const resourcesPath = join(tempDir(), 'resources');
  mkdirSync(join(resourcesPath, 'pipeline'), { recursive: true });
  writeFileSync(join(resourcesPath, 'pipeline', 'machine-design-cli.cjs'), '// stub\n');
  assert.equal(
    resolvePipelinePath({ isPackaged: true, resourcesPath }),
    join(resourcesPath, 'pipeline', 'machine-design-cli.cjs')
  );
});

// ---- buildLaunchEnv ----

test('buildLaunchEnv：注入 AUTOMATIONCAD_PIPELINE / AUTOMATIONCAD_NODE / ELECTRON_RUN_AS_NODE 且不改原 env', () => {
  const env = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: undefined };
  const built = buildLaunchEnv({
    electronExePath: 'C:\\AutomationCAD\\AutomationCAD.exe',
    pipelinePath: 'C:\\AutomationCAD\\resources\\pipeline\\machine-design-cli.cjs',
    env
  });
  assert.equal(built.AUTOMATIONCAD_PIPELINE, 'C:\\AutomationCAD\\resources\\pipeline\\machine-design-cli.cjs');
  assert.equal(built.AUTOMATIONCAD_NODE, 'C:\\AutomationCAD\\AutomationCAD.exe');
  assert.equal(built.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(built.PATH, '/usr/bin');
  assert.deepEqual(env, { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: undefined });
});

test('buildLaunchEnv：runner 是 Electron 才打 AUTOMATIONCAD_NODE_ELECTRON=1（P1-3：dev 的 electron.exe 也要认）', () => {
  const packaged = buildLaunchEnv({
    electronExePath: 'C:\\Program Files\\AutomationCAD\\AutomationCAD.exe',
    pipelinePath: '/p/p.cjs'
  });
  assert.equal(packaged.AUTOMATIONCAD_NODE_ELECTRON, '1', '打包态 AutomationCAD.exe 要打标记');

  for (const devExe of [
    '/repo/desktop/node_modules/electron/dist/electron',
    'C:/repo/desktop/node_modules/electron/dist/electron.exe',
    'C:\\repo\\desktop\\node_modules\\electron\\dist\\electron.exe'
  ]) {
    assert.equal(isElectronRuntimePath(devExe), true, `${devExe} 应当被认成 Electron`);
    assert.equal(buildLaunchEnv({ electronExePath: devExe, pipelinePath: '/p/p.cjs' }).AUTOMATIONCAD_NODE_ELECTRON, '1');
  }

  // 普通 node 不打标记：Qt 侧据此不注入 ELECTRON_RUN_AS_NODE（对真 node 没意义且会误导排查）
  const plain = buildLaunchEnv({ electronExePath: '/usr/local/bin/node', pipelinePath: '/p/p.cjs' });
  assert.equal(plain.AUTOMATIONCAD_NODE_ELECTRON, undefined);
  assert.equal(isElectronRuntimePath('/usr/local/bin/node'), false);
  assert.equal(isElectronRuntimePath('C:\\nodejs\\node.exe'), false);
});

// ---- describeQtExit ----

test('describeQtExit：0xC0000135 说清「缺 VC++ 运行库/DLL，请重装或检查 resources/qt」', () => {
  const positive = describeQtExit(STATUS_DLL_NOT_FOUND);
  assert.match(positive, /0xC0000135/);
  assert.match(positive, /缺 VC\+\+ 运行库\/DLL/);
  assert.match(positive, /重装/);
  assert.match(positive, /resources\/qt/);
  // 有符号 32 位表示也要认（Node 在不同 Windows 版本上给出的符号不同）
  assert.equal(describeQtExit(STATUS_DLL_NOT_FOUND - 0x1_0000_0000), positive);
});

test('describeQtExit：正常退出 / 被信号终止 / 普通非零码', () => {
  assert.equal(describeQtExit(0), 'Qt 工作台已退出');
  assert.match(describeQtExit(null), /被信号终止/);
  const crashed = describeQtExit(3, '  qt boom  ');
  assert.match(crashed, /异常退出（0x3）/);
  assert.match(crashed, /qt boom/);
  // 带上退出码也不改写 0xC0000135 的结论
  assert.match(describeQtExit(STATUS_DLL_NOT_FOUND, 'qInfo: 无显示'), /缺 VC\+\+ 运行库/);
});

test('headBytes：stderr 只留头 8KB', () => {
  const long = 'x'.repeat(STDERR_LIMIT + 100);
  assert.equal(headBytes(long).length, STDERR_LIMIT);
  assert.equal(headBytes('short'), 'short');
});

// ---- launchQt：真实 spawn，不 mock ----

test('launchQt：exe 不存在返回 { ok:false, message }，不抛', async () => {
  const appRoot = tempDir();
  plantPipeline(appRoot);
  const result = launchQt({
    isPackaged: false,
    appRoot,
    electronExePath: process.execPath,
    env: {}
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到 Qt 工作台/);
  assert.match(result.message, /automationcad-qt\.exe/);
  assert.match(result.message, /vendor-qt\.mjs/);
  // 同步结论与 await 结论必须一致（同一份真相，不是两套字段）
  const awaited = await result;
  assert.equal(awaited.ok, result.ok);
  assert.equal(awaited.message, result.message);
});

test('launchQt：管线单文件缺失也返回 { ok:false }（不能拿去 spawn 一个跑不动的 Qt）', () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  const result = launchQt({ isPackaged: false, appRoot, electronExePath: process.execPath, env: {} });
  assert.equal(result.ok, false);
  assert.match(result.message, /整机管线/);
  assert.match(result.message, /build-pipeline\.mjs/);
});

test('launchQt：900ms 内秒退 → 结论是 ok:false（P1-1：不再谎报已启动）', { timeout: 10000 }, async () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  const startedAt = Date.now();
  const result = await launchQt(launchArgs(appRoot, 'process.stderr.write("qt-quick-boom"); process.exit(3)'));
  assert.equal(result.ok, false, '秒退的进程不能报 ok:true');
  assert.match(result.message, /异常退出（0x3）/);
  assert.match(result.message, /qt-quick-boom/, 'stderr 要带进报错文案，否则用户仍然无从下手');
  assert.ok(Date.now() - startedAt < LAUNCH_GRACE_MS + 2000, '应当在观察窗内就下结论');
  assert.deepEqual(activeQtPids(), [], '退出的进程不该继续留在在案集合里');
});

test('launchQt：观察窗内没退出 → await 得到 ok:true 且 pid 在案', { timeout: 10000 }, async () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  try {
    const result = await launchQt(launchArgs(appRoot, LONG_RUNNING));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    assert.equal(typeof result.pid, 'number');
    assert.equal(activeQtPid(), result.pid);
    assert.equal(activeQtPids().length, 1);
    assert.equal(result.alreadyRunning, undefined, '第一次启动不该被标成 alreadyRunning');
  } finally {
    killActiveQt(process.platform);
  }
});

test('launchQt：已有存活实例时不再 spawn（P1-2：第二次 alreadyRunning、pid 相同、spawn 不调）', { timeout: 10000 }, async () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  try {
    const first = await launchQt(launchArgs(appRoot, LONG_RUNNING));
    assert.equal(first.ok, true, first.ok ? '' : first.message);

    let spawnedAgain = false;
    const second = await launchQt({
      ...launchArgs(appRoot, LONG_RUNNING),
      spawnImpl: () => {
        spawnedAgain = true;
        throw new Error('不该再 spawn：已有存活实例');
      }
    });
    assert.equal(spawnedAgain, false, '已有存活实例时 launchQt 不能再 spawn 新进程');
    assert.equal(second.ok, true);
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.pid, first.pid, '两次 launch 必须指向同一个 pid');
    assert.deepEqual(activeQtPids(), [first.pid], '在案进程只该有一个');
  } finally {
    killActiveQt(process.platform);
  }
});

test('killActiveQt：两次 launch 的 pid 都被收掉（真 SIGTERM），记录清空', { timeout: 10000 }, async () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  const exits = [];
  const first = await launchQt({ ...launchArgs(appRoot, LONG_RUNNING), onExit: (info) => exits.push(info) });
  assert.equal(first.ok, true, first.ok ? '' : first.message);
  const second = await launchQt(launchArgs(appRoot, LONG_RUNNING));
  assert.equal(second.pid, first.pid);
  assert.equal(isAlive(first.pid), true, 'kill 之前进程应当活着');

  assert.equal(killActiveQt(process.platform), true);
  assert.deepEqual(activeQtPids(), [], 'kill 之后在案集合要清空');

  // 两个 pid（实际上是同一个）都得真的死掉，不能只是把记录抹了
  assert.equal(await waitDead(first.pid), true, `pid ${first.pid} 应当被真的收掉`);
  assert.equal(await waitDead(second.pid), true, `pid ${second.pid} 应当被真的收掉`);

  await sleep(50);
  assert.equal(exits.length, 1, '退出事件只该来一次');
  // 重点是上面两条 waitDead：pid 用 process.kill(pid, 0) 探活失败才算真收掉。
  // 终止方式跨平台：POSIX 走 SIGTERM（code=null + signal=SIGTERM），Windows 走 taskkill /T /F
  // （没有 POSIX 信号，node 只看到退出码 1、signal=null），文案随之不同。
  if (process.platform === 'win32') {
    assert.equal(exits[0].code, 1, 'Windows 上 taskkill /F 结束的进程退出码为 1');
    assert.equal(exits[0].signal, null, 'Windows 没有 POSIX 信号，signal 恒为 null');
    assert.match(exits[0].message, /异常退出（0x1）/);
  } else {
    assert.equal(exits[0].code, null, '被信号终止时没有退出码');
    assert.equal(exits[0].signal, 'SIGTERM');
    assert.match(exits[0].message, /被信号终止/);
  }
  assert.equal(killActiveQt(process.platform), false, '没有活着的 Qt 时返回 false');
});

test('killActiveQt：win32 走 taskkill /PID <pid> /T /F（生产唯一路径，argv 不能写错）', () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  // win32 分支在 ubuntu 的 unit job 里永远跑不到：注入假 spawn 补上这条断言
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    stderr: null,
    stdout: null
  });
  const launched = launchQt({ ...launchArgs(appRoot, LONG_RUNNING), spawnImpl: () => fakeChild });
  assert.equal(launched.ok, true);
  assert.deepEqual(activeQtPids(), [4321]);

  const calls = [];
  const killImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return Object.assign(new EventEmitter(), { pid: 9999, exitCode: null, signalCode: null });
  };
  assert.equal(killActiveQt('win32', killImpl), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '4321', '/T', '/F'], '漏了 /T 就收不掉 Qt 的子孙进程');
  assert.deepEqual(activeQtPids(), [], '杀完要清空记录，否则「已在运行」会误判');
});

// ---- subscribeQtExit ----

test('subscribeQtExit：退出时广播 {pid, code, signal, stderrTail}，取消订阅后不再收到', { timeout: 10000 }, async () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  const events = [];
  const unsubscribe = subscribeQtExit((event) => events.push(event));
  try {
    const quick = await launchQt(launchArgs(appRoot, 'process.stderr.write("qt-broadcast"); process.exit(9)'));
    assert.equal(quick.ok, false);
    assert.equal(events.length, 1, '一次退出只广播一次');
    const [event] = events;
    assert.equal(typeof event.pid, 'number');
    assert.ok(event.pid > 0);
    assert.equal(event.code, 9);
    assert.equal(event.signal, null);
    assert.match(event.stderrTail, /qt-broadcast/, 'stderrTail 要能让界面说清怎么死的');

    unsubscribe();
    const second = await launchQt(launchArgs(appRoot, 'process.exit(2)'));
    assert.equal(second.ok, false);
    assert.equal(events.length, 1, '取消订阅后不该再收到广播');
  } finally {
    unsubscribe(); // 幂等：重复调用不该抛
  }
});

test('subscribeQtExit：单个订阅方抛异常不影响其他订阅方与进程收尾', { timeout: 10000 }, async () => {
  const appRoot = tempDir();
  plantQt(appRoot);
  plantPipeline(appRoot);
  const seen = [];
  const offBad = subscribeQtExit(() => {
    throw new Error('subscriber boom');
  });
  const offGood = subscribeQtExit((event) => seen.push(event.code));
  try {
    const result = await launchQt(launchArgs(appRoot, 'process.exit(5)'));
    assert.equal(result.ok, false, '订阅方抛异常不该把结论变成未定义');
    assert.deepEqual(seen, [5]);
    assert.equal(activeQtPid(), null, '订阅方抛异常也不该让 activeQt 收不了尾');
  } finally {
    offBad();
    offGood();
  }
});

test('vendor-qt：只搬运行时（exe + dll），跳过 CI 打包副产物（zip / vc_redist / 日志）', () => {
  // 首个双端安装包 238.7MB 里有 61MB 是 ci.yml 上传用的那个 zip、18MB 是 windeployqt 放的
  // vc_redist 安装器 —— 都已经把 CRT DLL 直接带进包了，这些再进安装包纯属白占体积。
  const src = mkdtempSync(join(tmpdir(), 'vq-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'vq-dst-'));
  const script = new URL('../../scripts/vendor-qt.mjs', import.meta.url);
  try {
    writeFileSync(join(src, 'automationcad-qt.exe'), 'exe');
    for (let i = 0; i < 45; i += 1) writeFileSync(join(src, `lib${i}.dll`), 'x'.repeat(1024 * 1024));
    mkdirSync(join(src, 'platforms'));
    writeFileSync(join(src, 'platforms', 'qwindows.dll'), 'x'.repeat(1024 * 1024));
    writeFileSync(join(src, 'automationcad-qt-windows-x64-occt.zip'), 'z'.repeat(2048));
    writeFileSync(join(src, 'vc_redist.x64.exe'), 'r'.repeat(2048));
    writeFileSync(join(src, 'version.out.txt'), 'log');
    const r = spawnSync(process.execPath, [script.pathname], {
      env: { ...process.env, QT_DIST: src, VENDOR_QT_TARGET: dst },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `vendor-qt 失败：${r.stderr}`);
    assert.match(r.stdout, /VENDOR_QT_SKIP automationcad-qt-windows-x64-occt\.zip/);
    assert.match(r.stdout, /VENDOR_QT_SKIP vc_redist\.x64\.exe/);
    assert.match(r.stdout, /VENDOR_QT_OK files=47/);
    for (const junk of ['automationcad-qt-windows-x64-occt.zip', 'vc_redist.x64.exe', 'version.out.txt']) {
      assert.equal(existsSync(join(dst, junk)), false, `${junk} 不该进 vendor/qt`);
    }
    assert.ok(existsSync(join(dst, 'platforms', 'qwindows.dll')), '插件子目录里的 DLL 必须保留');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});
