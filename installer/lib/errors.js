export class InstallerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'InstallerError';
    this.code = code;
    this.safeDetails = options.safeDetails ?? null;
  }
}

export function asInstallerError(error, fallbackCode = 'INSTALLER_ERROR', fallbackMessage = 'The installer could not complete this step.') {
  if (error instanceof InstallerError) return error;
  return new InstallerError(fallbackCode, fallbackMessage, { cause: error });
}

export function publicErrorMessage(error) {
  if (error instanceof InstallerError) return error.message;
  return 'The installer could not complete this step. Check the connection and try again.';
}
