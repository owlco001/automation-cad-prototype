// 机型库抽屉的纯渲染层（desktop/src/commission/machine-library-panel.ts 上半部分）。
//
// 断言的是「用户真会看到什么」：空库文案、行里的名称/版本、错误码中文、非法 id 的按钮状态。
// 这些函数不碰 DOM，所以这里直接对字符串断言，不引 jsdom。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MACHINE_LIBRARY_ERROR_TEXT,
  describeLibraryFailure,
  formatLibrarySize,
  formatLibraryUpdatedAt,
  isSafeLibraryId,
  libraryErrorText,
  librarySourceLabel,
  planImportFailure,
  renderMachineLibraryPanelHtml,
  renderMachineLibraryRemoteHtml
} from '../../src/commission/machine-library-panel.ts';

const entry = (overrides = {}) => ({
  id: 'six-station',
  name: '六工位锁螺丝机',
  version: '1.2.0',
  updatedAt: '2026-11-03T04:05:00.000Z',
  sizeBytes: 2 * 1024 * 1024,
  source: 'local',
  ...overrides
});

test('机型库面板：只有 LIBRARY_EXISTS 才会去问「是否覆盖」', () => {
  assert.equal(planImportFailure({ ok: false, code: 'LIBRARY_EXISTS', message: 'x' }), 'confirm-overwrite');
  for (const code of [
    'LIBRARY_BAD_ZIP',
    'LIBRARY_HASH_MISMATCH',
    'LIBRARY_BAD_PATH',
    'LIBRARY_TOO_LARGE',
    'LIBRARY_INVALID_CONFIG',
    'LIBRARY_UNSUPPORTED_SCHEMA',
    'LIBRARY_IO_FAILED'
  ]) {
    assert.equal(planImportFailure({ ok: false, code, message: 'x' }), 'report', `${code} 不该触发覆盖确认`);
  }
});

test('机型库面板：空库显示引导文案，且不渲染表格', () => {
  const html = renderMachineLibraryPanelHtml({ entries: [] });
  assert.match(html, /还没有机型/);
  assert.match(html, /存进机型库/);
  assert.match(html, /data-machine-library-empty/);
  assert.equal(html.includes('data-machine-library-table'), false);
  assert.equal(html.includes('data-library-row='), false);
});

test('机型库面板：有行时包含名称与版本，并给出可点选锚点', () => {
  const html = renderMachineLibraryPanelHtml({ entries: [entry()] });
  assert.match(html, /六工位锁螺丝机/);
  assert.match(html, /1\.2\.0/);
  assert.match(html, /data-library-row="six-station"/);
  assert.match(html, /data-library-select="six-station"/);
  assert.match(html, /共 1 台机型/);
  assert.equal(html.includes('还没有机型'), false);
});

test('机型库面板：名称与 id 做 HTML 转义（库里的脏数据不能注入标记）', () => {
  const html = renderMachineLibraryPanelHtml({
    entries: [entry({ id: 'evil', name: '<img src=x onerror=alert(1)>' })]
  });
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('机型库面板：底部四个按钮齐全，未选中时导出/删除/加载 disabled', () => {
  const html = renderMachineLibraryPanelHtml({ entries: [entry()], selectedId: null });
  assert.match(html, /data-machine-library-import/);
  assert.match(html, /data-machine-library-export disabled/);
  assert.match(html, /data-machine-library-remove disabled/);
  assert.match(html, /data-machine-library-apply disabled/);
  // 导入不依赖选中项：空选择时也必须能点
  assert.match(html, /data-machine-library-import>/);
});

test('机型库面板：选中合法行后加载/导出/删除可用', () => {
  const html = renderMachineLibraryPanelHtml({ entries: [entry()], selectedId: 'six-station' });
  assert.match(html, /data-machine-library-apply>/);
  assert.match(html, /data-machine-library-export>/);
  assert.match(html, /data-machine-library-remove>/);
  assert.match(html, /已选：六工位锁螺丝机/);
  assert.match(html, /aria-selected="true"/);
});

test('机型库面板：id 非法时不渲染选中锚点，且加载/导出/删除 disabled', () => {
  const html = renderMachineLibraryPanelHtml({
    entries: [entry({ id: '../escape', name: '路径穿越' })],
    // 就算上层把非法 id 当选中项传进来，也不能启用按钮
    selectedId: '../escape'
  });
  assert.equal(html.includes('data-library-select'), false);
  assert.match(html, /data-library-row-invalid="1"/);
  assert.match(html, /data-machine-library-apply disabled/);
  assert.match(html, /data-machine-library-export disabled/);
  assert.match(html, /data-machine-library-remove disabled/);
  // 行本身仍要看得见（用户得知道库里有坏条目）
  assert.match(html, /路径穿越/);
});

test('机型库面板：忙时导入按钮也 disabled，并显示处理中', () => {
  const html = renderMachineLibraryPanelHtml({ entries: [entry()], selectedId: 'six-station', busy: true });
  assert.match(html, /data-machine-library-import disabled/);
  assert.match(html, /data-machine-library-apply disabled/);
  assert.match(html, /data-machine-library-busy/);
});

test('机型库面板：错误码映射成中文并保留错误码', () => {
  for (const code of [
    'LIBRARY_EXISTS',
    'LIBRARY_BAD_ZIP',
    'LIBRARY_HASH_MISMATCH',
    'LIBRARY_BAD_PATH',
    'LIBRARY_TOO_LARGE'
  ]) {
    assert.equal(typeof MACHINE_LIBRARY_ERROR_TEXT[code], 'string', `${code} 必须有中文文案`);
    assert.ok(MACHINE_LIBRARY_ERROR_TEXT[code].length > 4, `${code} 文案不能是占位`);
    const text = libraryErrorText(code, 'raw message');
    assert.equal(/[\u4e00-\u9fa5]/.test(text), true, `${code} 文案必须是中文`);
    const described = describeLibraryFailure({ ok: false, code, message: 'raw' });
    assert.match(described, new RegExp(`〔${code}〕`));
  }
  assert.match(MACHINE_LIBRARY_ERROR_TEXT.LIBRARY_EXISTS, /同名机型已存在/);
  assert.match(MACHINE_LIBRARY_ERROR_TEXT.LIBRARY_HASH_MISMATCH, /SHA-256/);
});

test('机型库面板：未知错误码回落到主进程 message，不吞掉信息', () => {
  assert.equal(libraryErrorText('SOMETHING_NEW', '磁盘只读'), '机型库操作失败：磁盘只读');
  assert.equal(libraryErrorText(undefined, ''), '机型库操作失败，请重试');
});

test('机型库面板：错误行渲染在面板里（role=alert）', () => {
  const html = renderMachineLibraryPanelHtml({ entries: [], error: '机型库读写失败。请重试' });
  assert.match(html, /data-machine-library-error/);
  assert.match(html, /role="alert"/);
  assert.match(html, /机型库读写失败/);
});

test('机型库面板：大小/时间/来源格式化', () => {
  assert.equal(formatLibrarySize(512), '512 B');
  assert.equal(formatLibrarySize(1536), '1.5 KB');
  assert.equal(formatLibrarySize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatLibrarySize(undefined), '—');
  assert.equal(formatLibrarySize(Number.NaN), '—');
  assert.equal(formatLibraryUpdatedAt(''), '—');
  assert.equal(formatLibraryUpdatedAt('not-a-date'), 'not-a-date');
  assert.match(formatLibraryUpdatedAt('2026-11-03T04:05:00.000Z'), /^2026-11-03 \d\d:\d\d$/);
  assert.equal(librarySourceLabel('local'), '本机保存');
  assert.equal(librarySourceLabel('remote'), '外部导入');
  assert.equal(librarySourceLabel(undefined), '外部导入');
});

test('机型库面板：id 合法性判定与主进程口径一致（渲染层那道闸）', () => {
  for (const good of ['six-station', 'machine_1', '六工位锁螺丝机', 'a.b', 'A1']) {
    assert.equal(isSafeLibraryId(good), true, `${good} 应放行`);
  }
  for (const bad of [
    '',
    ' ',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    '/etc/passwd',
    'C:',
    'C:\\x',
    'six station',
    'a\u0000b',
    'a\tb',
    '.hidden',
    'trailing-',
    'trailing.',
    'a..b',
    'con',
    'CON',
    'nul',
    'x'.repeat(65),
    null,
    undefined,
    42
  ]) {
    assert.equal(isSafeLibraryId(bad), false, `${String(bad)} 应被拒`);
  }
});

const remoteSource = (overrides = {}) => ({
  id: 'corp',
  name: '公司目录',
  url: 'https://machines.example.com/catalog.json',
  enabled: true,
  online: true,
  stale: false,
  machineCount: 1,
  fetchedAt: '2026-11-04T02:00:00.000Z',
  ...overrides
});

const remoteMachine = (overrides = {}) => ({
  sourceId: 'corp',
  sourceName: '公司目录',
  id: 'design-screw-3st',
  name: '三工位锁螺丝机',
  version: '1.1.0',
  sizeBytes: 3 * 1024 * 1024,
  sha256: 'a'.repeat(64),
  stale: false,
  installed: false,
  ...overrides
});

test('远程来源区：列出可下载机型，每行一个「下载」按钮（带 sourceId/machineId 锚点）', () => {
  const html = renderMachineLibraryRemoteHtml({ sources: [remoteSource()], machines: [remoteMachine()] }, false);
  assert.match(html, /data-machine-library-remote/);
  assert.match(html, /公司目录/);
  assert.match(html, /在线/);
  assert.match(html, /三工位锁螺丝机/);
  assert.match(html, /data-ml-download-source="corp"/);
  assert.match(html, /data-ml-download-id="design-screw-3st"/);
  assert.match(html, />下载</);
  assert.doesNotMatch(html, /disabled>已安装/);
});

test('远程来源区：已安装的机型按钮 disabled 且写「已安装」（同名不覆盖）', () => {
  const html = renderMachineLibraryRemoteHtml(
    { sources: [remoteSource()], machines: [remoteMachine({ installed: true })] },
    false
  );
  assert.match(html, /<button type="button" class="acp-btn" data-ml-download-source="corp" data-ml-download-id="design-screw-3st" disabled>已安装<\/button>/);
});

test('远程来源区：未配置来源给引导文案，不渲染空表格', () => {
  const html = renderMachineLibraryRemoteHtml({ sources: [], machines: [] }, false);
  assert.match(html, /未配置远程来源/);
  assert.match(html, /sources\.json/);
  assert.doesNotMatch(html, /data-ml-remote-list/);
});

test('远程来源区：离线来源显示错误码中文，缓存来源标「缓存」', () => {
  const offline = renderMachineLibraryRemoteHtml(
    { sources: [remoteSource({ online: false, machineCount: 0, errorCode: 'LIBRARY_NETWORK_FAILED' })], machines: [] },
    false
  );
  assert.match(offline, /离线/);
  assert.match(offline, /远程来源连接失败/);
  assert.match(offline, /来源里没有可下载的机型/);

  const stale = renderMachineLibraryRemoteHtml(
    { sources: [remoteSource({ stale: true })], machines: [remoteMachine({ stale: true })], stale: true },
    false
  );
  assert.match(stale, /缓存/);
  assert.match(stale, /缓存（未刷新）/);
});

test('远程来源区：忙/加载中时所有下载按钮 disabled，且名称做 HTML 转义', () => {
  const busy = renderMachineLibraryRemoteHtml(
    { sources: [remoteSource()], machines: [remoteMachine({ name: '<img src=x onerror=alert(1)>' })] },
    true
  );
  assert.match(busy, /onerror=alert\(1\)/);
  assert.doesNotMatch(busy, /<img/, '名称必须转义，不能变成标签');
  assert.match(busy, /data-ml-download-id="design-screw-3st" disabled>下载/);

  const loading = renderMachineLibraryRemoteHtml({ sources: [], machines: [], loading: true }, false);
  assert.match(loading, /读取目录…/);
});

test('远程来源区：没拿到数据（null）时不渲染该区块', () => {
  assert.equal(renderMachineLibraryRemoteHtml(null, false), '');
  assert.equal(renderMachineLibraryRemoteHtml(undefined, false), '');
  // 面板整体渲染时 remote 缺省也不该出现区块
  assert.doesNotMatch(renderMachineLibraryPanelHtml({ entries: [entry()] }), /data-machine-library-remote/);
});
