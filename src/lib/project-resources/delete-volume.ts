export interface DeleteManagedVolumeInput {
  /** Commits the already-computed lossless Volume removal to the editor. */
  detachYaml: () => void | Promise<void>;
  /** Applies the detached project YAML through the project lifecycle. */
  applyProject: () => void | Promise<void>;
  /** Removes the exact Volume resolved by the caller. */
  removeVolume: () => void | Promise<void>;
}

export type DeleteVolumeResult =
  | { status: 'removed' }
  | { status: 'detached_pending_cleanup'; error: string };

const REMOVE_FAILURE_FALLBACK = 'Failed to remove volume';
const OPERATION_FAILURE_FALLBACK = 'Volume deletion operation failed';

function normalizeOperationError(thrown: unknown): Error {
  if (isError(thrown)) return thrown;
  if (typeof thrown === 'string' && thrown.length > 0) return new Error(thrown);
  return new Error(OPERATION_FAILURE_FALLBACK, { cause: thrown });
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    // A revoked Proxy can throw from instanceof. It is not safe to inspect.
    return false;
  }
}

function removalErrorMessage(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown || REMOVE_FAILURE_FALLBACK;
  if (!isError(thrown)) return REMOVE_FAILURE_FALLBACK;

  try {
    const message: unknown = thrown.message;
    // Preserve meaningful daemon formatting, but reject empty/whitespace-only text.
    return typeof message === 'string' && message.trim().length > 0
      ? message
      : REMOVE_FAILURE_FALLBACK;
  } catch {
    return REMOVE_FAILURE_FALLBACK;
  }
}

/**
 * Irreversibly detaches, applies, then removes a managed Volume.
 *
 * This function is stateless and intentionally does not retry or roll back.
 * Callers must serialize deletion attempts for each Volume.
 * Cancellation before removal rejects like any detach/apply failure. Once
 * removal starts, cancellation means cleanup may still be required and is
 * returned as `detached_pending_cleanup`.
 */
export async function deleteManagedVolume(
  input: DeleteManagedVolumeInput,
): Promise<DeleteVolumeResult> {
  try {
    await input.detachYaml();
    await input.applyProject();
  } catch (error) {
    throw normalizeOperationError(error);
  }

  try {
    await input.removeVolume();
    return { status: 'removed' };
  } catch (error) {
    return {
      status: 'detached_pending_cleanup',
      error: removalErrorMessage(error),
    };
  }
}
