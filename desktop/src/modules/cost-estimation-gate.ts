import { moduleDisabledResult } from './tool-gates.ts';

export const COST_ESTIMATION_MODULE_ID = 'cost.estimation';

export function costEstimationDisabledResult(): {
  ok: false;
  code: 'MODULE_DISABLED';
  message: string;
} {
  return moduleDisabledResult(COST_ESTIMATION_MODULE_ID);
}

export class CostEstimationModuleDisabledError extends Error {
  readonly code = 'MODULE_DISABLED' as const;

  constructor() {
    super(costEstimationDisabledResult().message);
    this.name = 'CostEstimationModuleDisabledError';
  }
}
