export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options.status || 500;
    this.retryable = options.retryable !== false;
    this.details = options.details || null;
    this.cause = options.cause;
  }
}

export function safeError(error) {
  if (error instanceof AppError) return error;
  return new AppError("UNEXPECTED_ERROR", error?.message || String(error), {
    status: 500,
    retryable: true,
    cause: error,
  });
}
