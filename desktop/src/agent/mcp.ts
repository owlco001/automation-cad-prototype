import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentTools } from './tools.ts';
import { authorizeAgentToolCall, type ConfirmAgentToolWrite } from './policy.ts';
import { requiresWriteConfirmation, WRITE_TOOLS } from './router.ts';
import { isWriteOperationId } from './write-operations.ts';
import { AGENT_TOOL_MODULES } from '../modules/tool-gates.ts';
import {
  DesktopRpcError,
  DesktopRpcUnavailableError,
  DesktopWriteOutcomeUnknownError,
  type DesktopRpcProxy
} from './mcp-proxy.ts';

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpServerOptions {
  proxy?: DesktopRpcProxy;
  confirmWrite?: ConfirmAgentToolWrite;
}

const LOCAL_READ_TOOLS = new Set(['list_components', 'search_components', 'search_docs']);
const DESKTOP_REQUIRED_TOOLS = new Set([
  ...WRITE_TOOLS,
  'get_bom',
  'get_render_stats',
  'get_project_context',
  'run_interference_check',
  'suggest_kinematics',
  'run_cost_report',
  'run_electrical_check',
  'verify_plc_program'
]);

const DESKTOP_NOT_RUNNING = {
  ok: false,
  code: 'DESKTOP_NOT_RUNNING',
  message: '请先启动 AutomationCAD 桌面应用，再调用该工具'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(result: unknown, isError = false): CallToolResult {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: isRecord(result) ? result : { value: result },
    isError: isError || (isRecord(result) && result.ok === false)
  };
}

/**
 * 基于 AgentTools 注册表构建 MCP server。
 * JSON-RPC 入口与 MCP 入口共用 tools.ts 的同一份定义，避免两套 schema 漂移。
 */
export function buildMcpServer(
  tools: AgentTools,
  info: McpServerInfo = { name: 'automation-cad', version: '0.1.0' },
  options: McpServerOptions = {}
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let summaries = tools.summaries();
    if (options.proxy) {
      try {
        summaries = await options.proxy.listTools();
      } catch {
        // 桌面状态不可读时隐藏有模块归属的工具，不能用本地默认状态猜测开关值。
        summaries = summaries.filter((tool) => !AGENT_TOOL_MODULES[tool.name]);
      }
    }
    return {
      tools: [...summaries.map((tool) => {
        const inputSchema = tool.inputSchema as Tool['inputSchema'];
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: options.proxy && requiresWriteConfirmation(tool.name) ? {
            ...inputSchema,
            required: [...new Set([...(inputSchema.required ?? []), 'operationId'])],
            properties: { ...inputSchema.properties, operationId: {
              type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$',
              description: '调用前生成并保存写操作 ID（建议 UUID）；取消或超时后用同一 ID 查询，不要自动重试。'
            } }
          } : inputSchema
        };
      }), ...(options.proxy ? [{
        name: 'get_write_operation', description: '查询原写操作回执。记录只在桌面进程内短期保留。找不到时不要自动重试。',
        inputSchema: { type: 'object' as const, properties: { operationId: { type: 'string' } }, required: ['operationId'] }
      }] : [])]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, { signal }): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const argsObject = isRecord(args) ? { ...args } : {};
    if (name === 'get_write_operation' && options.proxy) {
      try {
        if (!isWriteOperationId(argsObject.operationId)) return toolResult({ ok: false, code: 'INVALID_WRITE_OPERATION_ID' });
        return toolResult(await options.proxy.operationStatus(argsObject.operationId, signal));
      } catch {
        return toolResult({ ok: false, code: 'WRITE_STATUS_UNAVAILABLE', message: '无法查询写操作状态，不要自动重试写入。' });
      }
    }
    if (!tools.has(name)) {
      return {
        content: [{ type: 'text', text: `未知工具：${name}` }],
        isError: true
      };
    }

    if (options.proxy) {
      let operationId: string | undefined;
      if (requiresWriteConfirmation(name)) {
        if (!Object.hasOwn(argsObject, 'operationId')) {
          return toolResult({
            ok: false,
            code: 'WRITE_OPERATION_ID_REQUIRED',
            operationId: randomUUID(),
            message: '未执行。请保存此操作 ID，并在明确发起写入时将其放入 arguments.operationId。'
          });
        }
        if (!isWriteOperationId(argsObject.operationId)) {
          return toolResult({ ok: false, code: 'INVALID_WRITE_OPERATION_ID', message: '操作 ID 格式无效，未执行。' });
        }
        operationId = argsObject.operationId;
        delete argsObject.operationId;
      }
      try {
        const forwarded = await options.proxy.callTool(name, argsObject, { signal, ...(operationId ? { operationId } : {}) });
        const structured = forwarded.structuredContent;
        const text = structured === undefined ? '{"ok":true}' : JSON.stringify(structured);
        return {
          content: [{ type: 'text', text }],
          structuredContent: isRecord(structured) ? structured : { value: structured },
          isError: forwarded.isError
        };
      } catch (error) {
        if (error instanceof DesktopWriteOutcomeUnknownError) {
          return toolResult({ ok: false, code: error.code, operationId: error.operationId, message: error.message }, true);
        }
        if (signal.aborted) return toolResult({ ok: false, code: 'REQUEST_CANCELLED' }, true);
        if (error instanceof DesktopRpcUnavailableError) {
          if (!LOCAL_READ_TOOLS.has(name) && DESKTOP_REQUIRED_TOOLS.has(name)) {
            return toolResult(DESKTOP_NOT_RUNNING, true);
          }
        } else {
          const message = error instanceof DesktopRpcError
            ? error.message
            : '桌面 RPC 调用失败';
          return toolResult({ ok: false, code: 'DESKTOP_RPC_ERROR', message }, true);
        }
      }
    }

    try {
      if (!LOCAL_READ_TOOLS.has(name) && DESKTOP_REQUIRED_TOOLS.has(name) && !options.proxy) {
        return toolResult(DESKTOP_NOT_RUNNING, true);
      }
      const authorization = await authorizeAgentToolCall(name, argsObject, options.confirmWrite);
      if (!authorization.ok) return toolResult(authorization, true);
      const result = await tools.call(name, argsObject);
      return toolResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `工具执行失败：${message}` }],
        isError: true
      };
    }
  });

  return server;
}
