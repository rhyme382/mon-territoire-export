export class GpkgSvgError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GpkgSvgError';
    this.code = code;
  }
}
