export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(entity: string): HttpError {
  return new HttpError(404, 'NOT_FOUND', `${entity} was not found`);
}
