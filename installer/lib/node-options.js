const DEFAULT_MAX_TRIES = 3;
const DEFAULT_RETRY_WAIT_MS = 5_000;

export function normalizedExecutionOptions(node = {}) {
  const retryOnFail = node.retryOnFail === true;
  return {
    retryOnFail,
    maxTries: retryOnFail ? node.maxTries ?? DEFAULT_MAX_TRIES : null,
    waitBetweenTries: retryOnFail
      ? node.waitBetweenTries ?? DEFAULT_RETRY_WAIT_MS
      : null,
    alwaysOutputData: node.alwaysOutputData === true,
    continueOnFail: node.continueOnFail === true,
    onError: node.onError ?? 'stopWorkflow',
    executeOnce: node.executeOnce === true,
    disabled: node.disabled === true,
  };
}
