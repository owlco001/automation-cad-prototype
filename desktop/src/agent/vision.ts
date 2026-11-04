/**
 * 视觉自检：把 `capture_view` 的截图回灌给模型（OpenAI 兼容 `image_url`）。
 *
 * 三条纪律：
 * 1. **只读白名单目录**：只允许 `userData/agent-shots/**` 下的 png/jpg，先 `realpath`
 *    再比前缀，符号链接指到外面一样拒读。
 * 2. **先压缩再发**：长边 ≤1024、单图 ≤400 KB（`vision-image.ts`），超限/读不到就
 *    不发图并给出稳定原因码，绝不发原图。
 * 3. **没发图必须说清**：降级/失败时的提示词明确要求模型声明「未看到图像」，
 *    不允许凭尺寸和哈希编出「看起来没问题」。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { LlmError, type LlmContentPart } from './llm.ts';
import {
  DEFAULT_VISION_MODE,
  VISION_MODES,
  isVisionMode,
  parseVisionMode,
  type VisionMode
} from './llm-config.ts';
import {
  VISION_MAX_BYTES,
  VISION_MAX_EDGE,
  VisionImageError,
  isPng,
  fitPng
} from './vision-image.ts';

// 开关的本体定义在 llm-config.ts（agent-llm.json 的字段），这里转出去方便调用方只 import 一处。
export { DEFAULT_VISION_MODE, VISION_MODES, isVisionMode, parseVisionMode };
export type { VisionMode };

/** 截图落盘目录（与 `self-evidence.ts` 的 `userData/agent-shots` 同一处）。 */
export const VISION_SHOTS_DIR = 'agent-shots';

/** 模型必须在这句话出现时表明自己没看到图，避免伪造视觉结论。 */
export const VISION_NOT_SEEN_MARK = '未看到图像';

/** 服务端拒收图片后追加在回复末尾的说明（硬要求，措辞固定）。 */
export const VISION_DEGRADED_REPLY_NOTICE = '当前模型不支持图片，本次只能根据尺寸/哈希判断。';

export type VisionFailureCode =
  | 'VISION_PATH_DENIED'
  | 'VISION_UNREADABLE'
  | 'VISION_UNSUPPORTED_FORMAT'
  | 'VISION_TOO_LARGE';

export interface VisionShotMeta {
  path: string;
  view: string;
  width: number;
  height: number;
  sha256?: string;
}

export interface VisionAttachment {
  ok: true;
  path: string;
  view: string;
  mime: 'image/png';
  /** data:image/png;base64,… —— 只在内存里拼请求，不进审计/工具结果 */
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
  sourceBytes: number;
  scaled: boolean;
  sha256?: string;
}

export interface VisionFailure {
  ok: false;
  code: VisionFailureCode;
  message: string;
}

function fail(code: VisionFailureCode, message: string): VisionFailure {
  return { ok: false, code, message };
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 读一张截图并压到可发送体积。
 *
 * `shotPath` 来自工具回执（不可信输入），所以先 realpath 再判前缀：
 * `agent-shots` 之外的路径（含 `../` 与指向外部的符号链接）一律 `VISION_PATH_DENIED`。
 */
export function loadShotImage(
  userDataDir: string | undefined,
  shotPath: string,
  options: { maxEdge?: number; maxBytes?: number } = {}
): VisionAttachment | VisionFailure {
  if (!userDataDir) return fail('VISION_UNREADABLE', '未配置 userData 目录，读不到截图');
  if (typeof shotPath !== 'string' || !shotPath.trim()) {
    return fail('VISION_UNREADABLE', '截图路径为空');
  }
  const root = realpathOrNull(join(userDataDir, VISION_SHOTS_DIR));
  if (!root) return fail('VISION_UNREADABLE', `截图目录不存在：${VISION_SHOTS_DIR}`);
  const real = realpathOrNull(shotPath);
  if (!real) return fail('VISION_UNREADABLE', `截图文件不存在：${shotPath}`);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (real !== root && !real.startsWith(prefix)) {
    return fail('VISION_PATH_DENIED', `只允许读取 ${VISION_SHOTS_DIR} 下的截图：${shotPath}`);
  }
  if (!/\.(png|jpe?g)$/i.test(real)) {
    return fail('VISION_UNSUPPORTED_FORMAT', `只支持 png/jpg 截图：${shotPath}`);
  }
  let bytes: Buffer;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return fail('VISION_UNREADABLE', `截图不是普通文件：${shotPath}`);
    bytes = readFileSync(real);
  } catch (error) {
    return fail('VISION_UNREADABLE', `读取截图失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length === 0) return fail('VISION_UNREADABLE', '截图文件为空');
  const source = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isPng(source)) {
    // jpeg 需要 nativeImage 才能重采样；这里没有，就明说不支持，绝不把原图发出去。
    return fail('VISION_UNSUPPORTED_FORMAT', `只支持 PNG 截图（${real}），jpeg 需要先转成 PNG`);
  }
  let fitted;
  try {
    fitted = fitPng(source, {
      maxEdge: options.maxEdge ?? VISION_MAX_EDGE,
      maxBytes: options.maxBytes ?? VISION_MAX_BYTES
    });
  } catch (error) {
    if (error instanceof VisionImageError) return fail(error.code, error.message);
    return fail('VISION_UNSUPPORTED_FORMAT', `压缩截图失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ok: true,
    path: real,
    view: '',
    mime: 'image/png',
    dataUrl: `data:image/png;base64,${Buffer.from(fitted.data).toString('base64')}`,
    bytes: fitted.data.length,
    width: fitted.width,
    height: fitted.height,
    sourceBytes: bytes.length,
    scaled: fitted.scaled
  };
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/** 带图时给模型的第一段文字（OpenAI 兼容：与 image_url 同处一个 user content 数组）。 */
export function visionPromptText(shot: VisionShotMeta, image: VisionAttachment): string {
  const head = `这是刚才请求的视图截图（${shot.view}，${image.width}x${image.height}）。请描述你看到的内容并判断是否与目标一致；看不到就说看不到。`;
  const compact = image.scaled || image.bytes !== image.sourceBytes
    ? `（截图已压缩：原图 ${shot.width}x${shot.height} / ${kb(image.sourceBytes)} → ${image.width}x${image.height} / ${kb(image.bytes)}）`
    : '';
  const guard = `如果你实际没有收到图像（工具报错、模型不支持图片等），必须直接写「${VISION_NOT_SEEN_MARK}」，只根据尺寸与哈希说明，不要描述画面、不要下「看起来没问题」的结论。`;
  return [head, compact, guard].filter(Boolean).join('\n');
}

/** 没发图（配置关闭/降级/读图失败）时的文字：必须包含「未看到图像」。 */
export function visionSkippedText(shot: VisionShotMeta, reason: string): string {
  return [
    `这是刚才请求的视图截图（${shot.view}，${shot.width}x${shot.height}），但本次没有把图像发给你：${reason}。`,
    `你${VISION_NOT_SEEN_MARK}：不要猜测画面内容，不要给「看起来没问题」这类结论。`,
    `只能根据 path/bytes/sha256 与尺寸说明这张图存在且未被校验过画面，并在回复里明确写出「${VISION_NOT_SEEN_MARK}」。`
  ].join('\n');
}

export function buildVisionParts(shot: VisionShotMeta, image: VisionAttachment): LlmContentPart[] {
  return [
    { type: 'text', text: visionPromptText(shot, image) },
    { type: 'image_url', image_url: { url: image.dataUrl } }
  ];
}

export function buildVisionSkippedMessage(shot: VisionShotMeta, reason: string): LlmContentPart[] {
  return [{ type: 'text', text: visionSkippedText(shot, reason) }];
}

/**
 * 服务端拒收图片的判定：只看 400/404/413/415/422 且报文里明确提到 image/vision/多模态，
 * 或者 content 类型错误。普通 400（比如参数名写错）不算，避免误降级。
 */
export function isVisionRejection(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  if (error.code !== 'LLM_HTTP_ERROR') return false;
  const status = error.status;
  if (status !== 400 && status !== 404 && status !== 413 && status !== 415 && status !== 422) return false;
  const text = `${error.message} ${error.detail ?? ''}`;
  if (/image|vision|multimodal|multi-modal|图片|图像|多模态/i.test(text)) return true;
  return /(content|message)[\s\S]{0,40}(type|array|format)[\s\S]{0,40}(invalid|unsupported|not support)|(invalid|unsupported|not support)[\s\S]{0,40}(content|message)[\s\S]{0,40}(type|array)/i.test(text);
}

/** 文本里是否已经自己说过「没看到图」（降级提示不必重复第二次）。 */
export function mentionsBlindness(text: string): boolean {
  return /未看到图像|看不到图|没有收到图|未收到图|无法查看图|不支持图片/.test(text);
}
