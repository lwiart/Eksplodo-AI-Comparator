export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    /** Champs ajoutés au corps d'erreur, à côté de `code` et `message` (ex. `existingId`). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') {
    super('not_found', 404, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Accès interdit') {
    super('forbidden', 403, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentification requise') {
    super('unauthorized', 401, message);
  }
}

export class ValidationError extends AppError {
  constructor(code: string, message: string) {
    super(code, 400, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>) {
    super(code, 409, message, extra);
  }
}

export class RateLimitedError extends AppError {
  constructor() {
    super('rate_limited', 429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  }
}
