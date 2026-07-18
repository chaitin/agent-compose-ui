export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function invalidPath(message = '路径无效') {
  return new ServiceError(400, 'INVALID_PATH', message);
}
