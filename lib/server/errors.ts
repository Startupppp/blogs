/** Errors a service raises for the caller to show; status maps to the HTTP answer of a route. */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ServiceError(404, "not_found", `${what} not found`);
