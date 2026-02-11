export class WebexError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'WebexError';
  }
}

export class AuthError extends WebexError {
  constructor(message = 'Authentication failed — check your token') {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class DeviceRegistrationError extends WebexError {
  constructor(message: string, public readonly statusCode?: number) {
    super(message, 'DEVICE_REGISTRATION_ERROR');
    this.name = 'DeviceRegistrationError';
  }
}

export class MercuryConnectionError extends WebexError {
  constructor(message: string, public readonly closeCode?: number) {
    super(message, 'MERCURY_CONNECTION_ERROR');
    this.name = 'MercuryConnectionError';
  }
}

export class KmsError extends WebexError {
  constructor(message: string) {
    super(message, 'KMS_ERROR');
    this.name = 'KmsError';
  }
}

export class DecryptionError extends WebexError {
  constructor(message: string) {
    super(message, 'DECRYPTION_ERROR');
    this.name = 'DecryptionError';
  }
}
