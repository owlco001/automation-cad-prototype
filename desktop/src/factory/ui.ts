import type { TagNode, TagValue } from './types';
import { loadFactoryStationView } from './station-view.ts';
import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml,
  notify
} from '../ui/panels';

const FACTORY_ICON = '<svg viewBox="0 0 16 16"><path d="M2 13.5V6.2l4-2v3.2l4-2v3.2l4-2v6.9z"/><path d="M4.5 9.5h1M7.5 9.5h1M10.5 9.5h1"/></svg>';
const STATUS_LABELS: Record<string, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接异常'
};

interface UiStatus {
  kind: 'demo' | 'opcua' | 'mqtt' | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  connectedAt?: string;
  error?: string;
}

interface UiElements {
  kind: HTMLSelectElement;
  endpointField: HTMLElement;
  endpoint: HTMLInputElement;
  brokerField: HTMLElement;
  broker: HTMLInputElement;
  topicField: HTMLElement;
  topicMap: HTMLTextAreaElement;
  connect: HTMLButtonElement;
  disconnect: HTMLButtonElement;
  status: HTMLElement;
  stations: HTMLElement;
  footStatus: HTMLElement;
}

let elements: UiElements | null = null;
let values = new Map<string, TagValue>();
let statusListening = false;

function desktop() {
  return window.desktop;
}

function setStatus(message: string, kind: 'ok' | 'error' | 'warn' | 'idle' = 'idle'): void {
  if (!elements) return;
  elements.status.textContent = message;
  elements.status.classList.toggle('is-on', Boolean(message));
  elements.status.classList.toggle('is-error', kind === 'error');
  elements.status.classList.toggle('is-warn', kind === 'warn');
  if (kind !== 'idle') notify(message, kind === 'error');
}

function statusPill(status: UiStatus): string {
  const cls = status.status === 'connected'
    ? 'is-ok'
    : status.status === 'error'
      ? 'is-error'
      : status.status === 'connecting'
        ? 'is-warn'
        : '';
  const kind = status.kind ?? '—';
  return `<span class="acp-pill ${cls}">${escapeHtml(kind)} · ${STATUS_LABELS[status.status] ?? status.status}</span>`;
}

function renderStatus(status: UiStatus): void {
  if (!elements) return;
  elements.footStatus.innerHTML = `${statusPill(status)}${status.connectedAt ? `<span class="acp-pill">${escapeHtml(new Date(status.connectedAt).toLocaleTimeString('zh-CN'))}</span>` : ''}`;
  elements.connect.disabled = status.status === 'connecting' || status.status === 'connected';
  elements.disconnect.disabled = status.status !== 'connected' && status.status !== 'error';
  if (status.error) setStatus(`工厂状态异常：${status.error}`, 'error');
}

function updateKindFields(): void {
  if (!elements) return;
  const kind = elements.kind.value;
  elements.endpointField.hidden = kind !== 'opcua';
  elements.brokerField.hidden = kind !== 'mqtt';
  elements.topicField.hidden = kind !== 'mqtt';
}

function parseTopicMap(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`topicMap 不是合法 JSON：${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('topicMap 必须是 {"topic":"点位id"} 对象');
  }
  const result: Record<string, string> = {};
  for (const [topic, tagId] of Object.entries(parsed)) {
    if (typeof tagId !== 'string' || !tagId.trim()) throw new Error(`topicMap["${topic}"] 必须是非空字符串`);
    result[topic] = tagId.trim();
  }
  if (Object.keys(result).length === 0) throw new Error('topicMap 不能为空');
  return result;
}

function formatValue(value: TagValue): string {
  if (value.value === null || value.value === undefined) return '—';
  if (typeof value.value === 'boolean') return value.value ? '是' : '否';
  if (typeof value.value === 'number') {
    return Number.isInteger(value.value) ? String(value.value) : value.value.toFixed(2);
  }
  return String(value.value);
}

function updateTagValue(value: TagValue): void {
  values.set(value.id, value);
  if (!elements) return;
  const row = elements.stations.querySelector<HTMLElement>(`[data-tag-id="${cssEscape(value.id)}"]`);
  if (!row) return;
  const valueElement = row.querySelector<HTMLElement>('.acp-tag-value');
  const dot = row.querySelector<HTMLElement>('.acp-dot');
  if (valueElement) valueElement.textContent = formatValue(value);
  if (dot) {
    dot.classList.toggle('is-good', value.quality === 'good');
    dot.classList.toggle('is-bad', value.quality !== 'good');
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function renderStations(stations: TagNode[]): void {
  if (!elements) return;
  if (stations.length === 0) {
    elements.stations.innerHTML = '<div class="acp-empty">适配器已连接，但没有可浏览的工位/点位。</div>';
    return;
  }
  elements.stations.innerHTML = stations.map((station) => {
    const tags = station.children ?? [];
    return `<section class="acp-station" data-station-id="${escapeHtml(station.id)}">
      <header class="acp-station-head"><b>${escapeHtml(station.name)}</b><span>${tags.length} 个点位</span></header>
      ${tags.map((tag) => tagRow(tag)).join('')}
    </section>`;
  }).join('');
}

function tagRow(tag: TagNode): string {
  const current = values.get(tag.id);
  const writable = tag.writable === true;
  return `<div class="acp-tag" data-tag-id="${escapeHtml(tag.id)}">
    <div class="acp-tag-name"><span class="acp-dot ${current?.quality === 'good' ? 'is-good' : ''}"></span>
      <span>${escapeHtml(tag.name)}</span><em>${escapeHtml(tag.id)}</em></div>
    <div class="acp-tag-value">${current ? escapeHtml(formatValue(current)) : '—'}</div>
    ${writable
      ? `<div class="acp-tag-write"><input type="text" data-write-input value="${escapeHtml(current ? String(current.value) : '')}"><button type="button" data-write-tag>写入</button></div>`
      : '<div class="acp-tag-value">只读</div>'}
  </div>`;
}

async function refreshStations(): Promise<void> {
  const api = desktop();
  if (!api || !elements) return;
  await loadFactoryStationView(api.factory, {
    renderStations,
    updateTagValue,
    showError: (message) => setStatus(message, 'error')
  });
}

async function connect(): Promise<void> {
  const api = desktop();
  if (!api || !elements) {
    setStatus('工厂面板仅在桌面版可用。', 'error');
    return;
  }
  const kind = elements.kind.value;
  let config: Record<string, unknown>;
  try {
    if (kind === 'demo') {
      config = { kind };
    } else if (kind === 'opcua') {
      const endpointUrl = elements.endpoint.value.trim();
      if (!endpointUrl) throw new Error('请填写 OPC UA endpointUrl（例如 opc.tcp://127.0.0.1:4840）');
      config = { kind, endpointUrl, securityPolicy: 'None' };
    } else {
      const brokerUrl = elements.broker.value.trim();
      if (!brokerUrl) throw new Error('请填写 MQTT brokerUrl（例如 mqtt://127.0.0.1:1883）');
      config = { kind, brokerUrl, topicMap: parseTopicMap(elements.topicMap.value) };
    }
  } catch (error) {
    setStatus(errorMessage(error), 'error');
    return;
  }
  elements.connect.disabled = true;
  setStatus('正在连接工厂适配器…', 'idle');
  let result: DesktopFactoryResult<DesktopFactoryStatusInfo>;
  try {
    result = await api.factory.connect(config);
  } catch (error) {
    elements.connect.disabled = false;
    setStatus(`连接失败：${errorMessage(error)}`, 'error');
    return;
  }
  if (!result.ok || !result.data) {
    elements.connect.disabled = false;
    setStatus(result.message ?? '连接失败', 'error');
    return;
  }
  values = new Map();
  renderStatus(result.data);
  setStatus(`已连接：${kind}`, 'ok');
  await refreshStations();
}

async function disconnect(): Promise<void> {
  const api = desktop();
  if (!api || !elements) return;
  try {
    const result = await api.factory.disconnect();
    if (!result.ok) {
      setStatus(result.message ?? '断开失败', 'error');
      return;
    }
    values = new Map();
    elements.stations.innerHTML = '<div class="acp-empty">已断开。选择适配器后点击「连接」。</div>';
    if (result.data) renderStatus(result.data);
    setStatus('已断开工厂连接', 'ok');
  } catch (error) {
    setStatus(`断开失败：${errorMessage(error)}`, 'error');
  }
}

async function writeTag(row: HTMLElement): Promise<void> {
  const api = desktop();
  if (!api) return;
  const id = row.dataset.tagId;
  if (!id) return;
  const input = row.querySelector<HTMLInputElement>('[data-write-input]');
  if (!input) return;
  const current = values.get(id);
  const raw = input.value.trim();
  let value: unknown = raw;
  if (current?.dataType === 'boolean') {
    const normalized = raw.toLowerCase();
    value = ['true', '1', '是', 'on', '运行', '报警'].includes(normalized);
  } else if (current?.dataType === 'number') {
    value = Number(raw);
    if (!Number.isFinite(value)) {
      setStatus(`点位「${id}」需要数字，收到：${raw}`, 'error');
      return;
    }
  }
  if (!window.confirm(`确定写入点位「${id}」吗？\n\n当前值：${current ? formatValue(current) : '—'}\n写入值：${String(value)}`)) {
    return;
  }
  try {
    const result = await api.factory.writeTag(id, value);
    if (!result.ok) {
      setStatus(result.message ?? '写入失败', 'error');
      return;
    }
    const read = await api.factory.readTags([id]);
    if (read.ok && read.data?.[id]) updateTagValue(read.data[id]);
    setStatus(`点位「${id}」写入成功：${String(value)}`, 'ok');
  } catch (error) {
    setStatus(`写入失败：${errorMessage(error)}`, 'error');
  }
}

async function loadSavedConfig(): Promise<void> {
  const api = desktop();
  if (!api || !elements) return;
  try {
    const result = await api.factory.getConfig();
    if (!result.ok) {
      setStatus(result.message ?? '读取工厂配置失败', 'warn');
      return;
    }
    const config = result.data;
    if (!config) return;
    const kind = config.kind;
    if (kind === 'demo' || kind === 'opcua' || kind === 'mqtt') elements.kind.value = kind;
    if (typeof config.endpointUrl === 'string') elements.endpoint.value = config.endpointUrl;
    if (typeof config.brokerUrl === 'string') elements.broker.value = config.brokerUrl;
    if (config.topicMap && typeof config.topicMap === 'object') {
      elements.topicMap.value = JSON.stringify(config.topicMap, null, 2);
    }
    updateKindFields();
  } catch (error) {
    setStatus(`读取工厂配置失败：${errorMessage(error)}`, 'warn');
  }
}

async function refreshStatus(): Promise<void> {
  const api = desktop();
  if (!api || !elements) return;
  try {
    const result = await api.factory.status();
    if (result.ok && result.data) {
      renderStatus(result.data);
      if (result.data.status === 'connected') await refreshStations();
    } else if (result.message) {
      setStatus(result.message, 'error');
    }
  } catch (error) {
    setStatus(`读取工厂状态失败：${errorMessage(error)}`, 'error');
  }
}

function bindStatusEvents(): void {
  if (statusListening || !window.desktop) return;
  statusListening = true;
  window.desktop.factory.onStatus((status) => {
    renderStatus(status);
    if (status.status === 'disconnected') {
      values = new Map();
      if (elements) elements.stations.innerHTML = '<div class="acp-empty">已断开。</div>';
    }
  });
  window.desktop.factory.onValues((value) => updateTagValue(value));
}

export function initFactoryPanel(): void {
  ensurePanelStyles();
  const entry = buildEntryButton('factoryEntryButton', '工厂', FACTORY_ICON, () => {
    drawer.open();
    void loadSavedConfig();
    void refreshStatus();
  });
  if (!entry) return;
  const drawer = createDrawer('factoryDrawer', '智慧工厂', '演示产线 · OPC UA · MQTT · 写点位需二次确认');
  drawer.body.innerHTML = `
    <div class="acp-status" id="factoryStatusBar"></div>
    <div class="acp-field">
      <span>适配器</span>
      <select class="acp-select" id="factoryKind">
        <option value="demo">内置仿真产线（开箱即用）</option>
        <option value="opcua">OPC UA</option>
        <option value="mqtt">MQTT</option>
      </select>
    </div>
    <div class="acp-field" id="factoryEndpointField" hidden>
      <span>OPC UA endpointUrl</span>
      <input class="acp-input" id="factoryEndpoint" placeholder="opc.tcp://127.0.0.1:4840" autocomplete="off">
    </div>
    <div class="acp-field" id="factoryBrokerField" hidden>
      <span>MQTT brokerUrl</span>
      <input class="acp-input" id="factoryBroker" placeholder="mqtt://127.0.0.1:1883" autocomplete="off">
    </div>
    <div class="acp-field" id="factoryTopicField" hidden>
      <span>topic → 点位 id 映射（JSON）</span>
      <textarea class="acp-textarea" id="factoryTopicMap" spellcheck="false">{
  "line/press/run": "press.run",
  "line/press/cycle": "press.cycle",
  "line/press/good": "press.good",
  "line/press/alarm": "press.alarm"
}</textarea>
    </div>
    <div class="acp-row">
      <button type="button" class="acp-btn acp-btn-primary" id="factoryConnect">连接</button>
      <button type="button" class="acp-btn" id="factoryDisconnect" disabled>断开</button>
      <span class="acp-row-end" id="factoryFootStatus"></span>
    </div>
    <div class="acp-section-title"><span>工位与点位</span><b>实时</b></div>
    <div id="factoryStations"><div class="acp-empty">连接后自动列出工位、点位与实时值。写点位会弹出确认对话框。</div></div>
    <div class="acp-note">仿真产线每秒刷新 2 个工位 × 4 个点位（运行 / 节拍 / 良品数 / 报警）。OPC UA 目前使用 securityPolicy=None；所有网络操作 10 秒超时。</div>`;
  drawer.footer.innerHTML = '<span class="acp-pill">状态广播 EventEmitter</span><span class="acp-pill">写操作二次确认</span>';

  const kind = drawer.body.querySelector<HTMLSelectElement>('#factoryKind');
  const endpointField = drawer.body.querySelector<HTMLElement>('#factoryEndpointField');
  const endpoint = drawer.body.querySelector<HTMLInputElement>('#factoryEndpoint');
  const brokerField = drawer.body.querySelector<HTMLElement>('#factoryBrokerField');
  const broker = drawer.body.querySelector<HTMLInputElement>('#factoryBroker');
  const topicField = drawer.body.querySelector<HTMLElement>('#factoryTopicField');
  const topicMap = drawer.body.querySelector<HTMLTextAreaElement>('#factoryTopicMap');
  const connectButton = drawer.body.querySelector<HTMLButtonElement>('#factoryConnect');
  const disconnectButton = drawer.body.querySelector<HTMLButtonElement>('#factoryDisconnect');
  const status = drawer.body.querySelector<HTMLElement>('#factoryStatusBar');
  const stations = drawer.body.querySelector<HTMLElement>('#factoryStations');
  const footStatus = drawer.body.querySelector<HTMLElement>('#factoryFootStatus');
  if (!kind || !endpointField || !endpoint || !brokerField || !broker || !topicField || !topicMap ||
      !connectButton || !disconnectButton || !status || !stations || !footStatus) {
    throw new Error('工厂面板节点缺失');
  }
  elements = {
    kind,
    endpointField,
    endpoint,
    brokerField,
    broker,
    topicField,
    topicMap,
    connect: connectButton,
    disconnect: disconnectButton,
    status,
    stations,
    footStatus
  };
  kind.addEventListener('change', updateKindFields);
  connectButton.addEventListener('click', () => void connect());
  disconnectButton.addEventListener('click', () => void disconnect());
  stations.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-write-tag]');
    if (!target) return;
    const row = target.closest<HTMLElement>('[data-tag-id]');
    if (row) void writeTag(row);
  });
  updateKindFields();
  bindStatusEvents();
}
