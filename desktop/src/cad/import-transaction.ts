import {
  commitCadProjectIdentity,
  prepareCadProjectIdentity,
  type CadProjectIdentity,
  type IdentityStorageLike
} from '../project-archive/identity.ts';

export interface CadImportTransactionResult<T> {
  result: T;
  identity: CadProjectIdentity | null;
}

/**
 * Hash and stage the source identity before a parser can transfer/detach its buffer,
 * but persist the identity only after parsing and viewer application succeed.
 */
export async function parseCadImportTransaction<T>(options: {
  sourceName: string;
  sourceBytes: Uint8Array;
  storage: IdentityStorageLike;
  parse: () => Promise<T>;
  apply?: (result: T, candidate: CadProjectIdentity | null) => void | Promise<void>;
  onIdentityError?: (error: unknown) => void;
  identityOptions?: { now?: () => Date; createId?: () => string };
}): Promise<CadImportTransactionResult<T>> {
  let candidate: Awaited<ReturnType<typeof prepareCadProjectIdentity>> | null = null;
  try {
    candidate = await prepareCadProjectIdentity(options.sourceName, options.sourceBytes, options.storage, options.identityOptions);
  } catch (error) {
    options.onIdentityError?.(error);
  }

  const result = await options.parse();
  await options.apply?.(result, candidate);
  if (!candidate) return { result, identity: null };

  try {
    return {
      result,
      identity: commitCadProjectIdentity(candidate, options.storage)
    };
  } catch (error) {
    options.onIdentityError?.(error);
    return { result, identity: null };
  }
}

export interface CadImportFailureView {
  loadingErrorVisible: boolean;
  emptyStateVisible: boolean;
}

/** Keep an already-loaded document visible; show the error/empty state only on first-load failure. */
export function cadImportFailureView(hasActiveDocument: boolean): CadImportFailureView {
  return {
    loadingErrorVisible: !hasActiveDocument,
    emptyStateVisible: !hasActiveDocument
  };
}
