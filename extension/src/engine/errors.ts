/** Structured error compatible with the legacy daemon protocol error codes. */
export class LensError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LensError';
  }
}

export const badRequest = (message: string) => new LensError('badRequest', message);
export const notFound = (message: string) => new LensError('notFound', message);
export const conflict = (message: string) => new LensError('conflict', message);
export const internalError = (message: string) => new LensError('internal', message);
