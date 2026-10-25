export interface CoreModuleCatalogEntry {
  id: string;
  name: string;
  version: string;
  coreApiVersion: 1;
  dependencies: string[];
  requiredCapabilities: string[];
  packageSize: number;
  packageSha256: string;
  authenticity: 'unsigned';
  activation: 'blocked-until-trust-policy';
}
export interface CoreModuleCatalogResult {
  configured: boolean;
  state: 'unconfigured' | 'ready';
  modules: CoreModuleCatalogEntry[];
}
export interface CoreStagedModuleSummary {
  id: string;
  version: string;
  dependencies: string[];
  requiredCapabilities: string[];
  packageSize: number;
  packageSha256: string;
  authenticity: 'unsigned';
  activation: 'blocked-until-trust-policy';
}
export interface CoreModuleDownloadResult extends CoreStagedModuleSummary {
  name: string;
  staged: true;
}
export interface CoreModuleRemovalResult {
  id: string;
  version: string;
  packageSize: number;
  removed: true;
}
export class ModuleStagingService {
  constructor(options: { sourceUrl?: string | null; stagingDirectory: string; stagingEnabled?: boolean; allowLoopbackForTests?: boolean });
  getCatalog(): Promise<CoreModuleCatalogResult>;
  downloadModule(id: unknown, version: unknown): Promise<CoreModuleDownloadResult>;
  listStagedModules(): Promise<CoreStagedModuleSummary[]>;
  removeStagedModule(id: unknown, version: unknown): Promise<CoreModuleRemovalResult>;
}
