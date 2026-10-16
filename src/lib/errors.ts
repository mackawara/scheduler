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

export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000;
}

export function duplicateKeyFields(error: unknown): string[] {
  if (!isDuplicateKeyError(error)) return [];
  const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  return pattern ? Object.keys(pattern) : [];
}

export function serviceConflict(error: unknown): HttpError | null {
  const fields = duplicateKeyFields(error);
  if (fields.includes('catalogRetailerId')) {
    return new HttpError(409, 'CATALOG_ID_IN_USE', 'Another service already uses this catalog retailer ID');
  }
  if (fields.includes('name')) return new HttpError(409, 'NAME_IN_USE', 'Another record already uses this name');
  return null;
}
