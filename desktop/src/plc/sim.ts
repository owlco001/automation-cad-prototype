import type { PlcAdapter, PlcConfig, PlcPoint, PlcStatus, PlcValue, SimRule } from './types.ts';
import { trackedClearInterval, trackedSetInterval } from '../shared/resources.ts';
import { validatePlcValue } from './value.ts';

type ValueMap = Record<string, PlcValue>;
type Predicate = (values: ValueMap) => boolean;

interface CompiledRule {
  target: string;
  apply(values: ValueMap, sim: SimPlcAdapter): void;
}

interface TimerState {
  since: number | null;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < expr.length) {
    const char = expr[index];
    if (char === undefined) break;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (expr.startsWith('&&', index) || expr.startsWith('||', index)) {
      tokens.push(expr.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (char === '!' || char === '(' || char === ')') {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (/[A-Za-z_0-9.]/.test(char)) {
      let end = index + 1;
      while (end < expr.length && /[A-Za-z_0-9.]/.test(expr[end] ?? '')) end += 1;
      tokens.push(expr.slice(index, end));
      index = end;
      continue;
    }
    throw new Error(`表达式含非法字符「${char}」`);
  }
  if (tokens.length === 0) throw new Error('表达式不能为空');
  return tokens;
}

/** 解析只含 &&、||、!、括号与布尔点位的表达式，不执行任意 JS。 */
export function compileExpr(expr: string, knownIds: Set<string>): Predicate {
  const tokens = tokenize(expr);
  let cursor = 0;
  const referenced = new Set<string>();

  const peek = (): string | undefined => tokens[cursor];
  const take = (): string => {
    const token = tokens[cursor];
    if (token === undefined) throw new Error('表达式不完整');
    cursor += 1;
    return token;
  };

  const parsePrimary = (): Predicate => {
    const token = take();
    if (token === '(') {
      const inner = parseOr();
      if (take() !== ')') throw new Error('表达式缺少右括号');
      return inner;
    }
    if (token === 'true') return () => true;
    if (token === 'false') return () => false;
    if (!/^[A-Za-z_][A-Za-z_0-9.]*$/.test(token)) throw new Error(`表达式中的点位名非法：${token}`);
    if (!knownIds.has(token)) throw new Error(`表达式引用了不存在的点位：${token}`);
    referenced.add(token);
    return (values) => values[token] === true;
  };

  const parseUnary = (): Predicate => {
    if (peek() === '!') {
      take();
      const inner = parseUnary();
      return (values) => !inner(values);
    }
    return parsePrimary();
  };

  const parseAnd = (): Predicate => {
    let left = parseUnary();
    while (peek() === '&&') {
      take();
      const right = parseUnary();
      const previous = left;
      left = (values) => previous(values) && right(values);
    }
    return left;
  };

  function parseOr(): Predicate {
    let left = parseAnd();
    while (peek() === '||') {
      take();
      const right = parseAnd();
      const previous = left;
      left = (values) => previous(values) || right(values);
    }
    return left;
  }

  const result = parseOr();
  if (cursor !== tokens.length) throw new Error(`表达式含多余内容：${tokens.slice(cursor).join(' ')}`);
  void referenced;
  return result;
}

export class SimPlcAdapter implements PlcAdapter {
  readonly kind = 'sim' as const;
  private state: PlcStatus = 'disconnected';
  private points = new Map<string, PlcPoint>();
  private values: ValueMap = {};
  private initialValues: ValueMap = {};
  private forced = new Set<string>();
  private rules: CompiledRule[] = [];
  private timers = new Map<string, TimerState>();
  private listeners = new Set<(values: ValueMap) => void>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  async connect(config: PlcConfig): Promise<void> {
    if (config.kind !== 'sim') throw new Error(`仿真适配器不接受 ${config.kind} 配置`);
    if (!Array.isArray(config.points) || config.points.length === 0) throw new Error('PLC 点位表不能为空');
    this.state = 'connecting';
    try {
      this.points.clear();
      this.values = {};
      this.initialValues = {};
      this.forced.clear();
      this.timers.clear();
      for (const point of config.points) {
        if (!point.id.trim()) throw new Error('点位 id 不能为空');
        if (this.points.has(point.id)) throw new Error(`点位 id 重复：${point.id}`);
        this.points.set(point.id, { ...point });
        this.values[point.id] = point.dataType === 'bool' ? false : 0;
      }
      if (config.initialValues) {
        for (const [id, value] of Object.entries(config.initialValues)) {
          const point = this.points.get(id);
          if (!point) throw new Error(`初始值引用了不存在的点位：${id}`);
          this.initialValues[id] = validatePlcValue(point, value);
        }
      }
      this.values = { ...this.values, ...this.initialValues };
      this.compileRules(config.rules ?? []);
      await Promise.resolve();
      this.state = 'connected';
      this.startTicker();
    } catch (error) {
      this.state = 'error';
      this.stopTicker();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stopTicker();
    this.listeners.clear();
    this.forced.clear();
    this.timers.clear();
    this.state = 'disconnected';
  }

  async read(id: string): Promise<PlcValue> {
    this.assertConnected();
    const value = this.values[id];
    if (value === undefined) throw new Error(`点位不存在：${id}`);
    return value;
  }

  async write(id: string, value: PlcValue): Promise<void> {
    this.assertConnected();
    const point = this.point(id);
    const normalized = validatePlcValue(point, value);
    this.forced.delete(id);
    this.setValue(id, normalized);
    this.evaluateRules();
  }

  /** 强制写入后保持该值，逻辑规则不会覆盖，直到 write/force 解除。 */
  async force(id: string, value: PlcValue): Promise<void> {
    this.assertConnected();
    const point = this.point(id);
    const normalized = validatePlcValue(point, value);
    this.forced.add(id);
    this.setValue(id, normalized);
    this.evaluateRules();
  }

  releaseForce(id: string): void {
    this.forced.delete(id);
  }

  async readAll(): Promise<ValueMap> {
    this.assertConnected();
    return { ...this.values };
  }

  subscribe(callback: (values: ValueMap) => void): () => void {
    this.assertConnected();
    this.listeners.add(callback);
    callback({ ...this.values });
    return () => {
      this.listeners.delete(callback);
    };
  }

  status(): PlcStatus {
    return this.state;
  }

  private compileRules(rules: SimRule[]): void {
    if (!Array.isArray(rules)) throw new Error('仿真逻辑规则必须是数组');
    const knownIds = new Set(this.points.keys());
    const compiled: CompiledRule[] = [];
    for (const [index, rule] of rules.entries()) {
      if (!rule || typeof rule !== 'object') throw new Error(`第 ${index + 1} 条逻辑规则格式错误`);
      if (!knownIds.has(rule.target)) throw new Error(`第 ${index + 1} 条逻辑规则的目标点位不存在：${rule.target}`);
      const type = rule.type ?? 'expr';
      if (type === 'expr') {
        const expr = (rule as { expr?: unknown }).expr;
        if (typeof expr !== 'string') throw new Error(`缺少必填参数：rules[${index}].expr`);
        const predicate = compileExpr(expr, knownIds);
        compiled.push({ target: rule.target, apply: (values, sim) => sim.setRuleValue(rule.target, predicate(values)) });
      } else if (type === 'latch') {
        const set = (rule as { set?: unknown }).set;
        const reset = (rule as { reset?: unknown }).reset;
        if (typeof set !== 'string' || typeof reset !== 'string' || !knownIds.has(set) || !knownIds.has(reset)) {
          throw new Error(`第 ${index + 1} 条自锁规则引用了不存在的点位`);
        }
        compiled.push({
          target: rule.target,
          apply: (values, sim) => {
            if (values[reset] === true) sim.setRuleValue(rule.target, false);
            else if (values[set] === true) sim.setRuleValue(rule.target, true);
          }
        });
      } else if (type === 'timer') {
        const when = (rule as { when?: unknown }).when;
        const delayMs = (rule as { delayMs?: unknown }).delayMs;
        if (typeof when !== 'string' || !knownIds.has(when)) throw new Error(`第 ${index + 1} 条定时器规则引用了不存在的点位：${String(when)}`);
        if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
          throw new Error(`第 ${index + 1} 条定时器规则的 delayMs 必须是非负数字`);
        }
        const timer: TimerState = { since: null };
        this.timers.set(rule.target, timer);
        compiled.push({
          target: rule.target,
          apply: (values, sim) => {
            if (values[when] === true) {
              if (timer.since === null) timer.since = Date.now();
              if (Date.now() - timer.since >= delayMs) sim.setRuleValue(rule.target, true);
            } else {
              timer.since = null;
              sim.setRuleValue(rule.target, false);
            }
          }
        });
      } else {
        throw new Error(`第 ${index + 1} 条逻辑规则类型不支持：${String(type)}`);
      }
    }
    this.rules = compiled;
  }

  /** @internal 规则求值入口，由 CompiledRule 调用。 */
  setRuleValue(id: string, value: PlcValue): void {
    if (this.forced.has(id)) return;
    const point = this.points.get(id);
    if (!point) return;
    if (point.dataType === 'bool') {
      if (typeof value !== 'boolean') return;
    } else if (typeof value !== 'number') {
      return;
    }
    this.setValue(id, value);
  }

  private startTicker(): void {
    this.stopTicker();
    const ticker = trackedSetInterval(() => {
      this.evaluateRules();
    }, 100);
    if (typeof ticker === 'object' && ticker && 'unref' in ticker) ticker.unref();
    this.ticker = ticker;
  }

  private stopTicker(): void {
    trackedClearInterval(this.ticker);
    this.ticker = null;
  }

  private evaluateRules(): void {
    for (const rule of this.rules) {
      if (this.forced.has(rule.target)) continue;
      rule.apply(this.values, this);
    }
  }

  private setValue(id: string, value: PlcValue, notify = true): void {
    const previous = this.values[id];
    if (previous === value) return;
    this.values[id] = value;
    if (!notify) return;
    for (const listener of this.listeners) listener({ [id]: value });
  }

  private point(id: string): PlcPoint {
    const point = this.points.get(id);
    if (!point) throw new Error(`点位不存在：${id}`);
    return point;
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new Error('PLC 仿真器尚未连接');
  }
}
