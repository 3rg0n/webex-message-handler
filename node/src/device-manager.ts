import { DeviceRegistration, FetchRequest, FetchResponse } from './types.js';
import { AuthError, DeviceRegistrationError } from './errors.js';
import { Logger, noopLogger } from './logger.js';

type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;

interface DeviceManagerOptions {
  logger?: Logger;
  httpDo: HttpDoFn;
}

interface WDMDeviceResponse {
  webSocketUrl: string;
  url: string;
  userId: string;
  services: Record<string, string>;
}

const WDM_API_BASE = 'https://wdm-a.wbx2.com/wdm/api/v1/devices';

export class DeviceManager {
  private logger: Logger;
  private httpDo: HttpDoFn;
  private deviceUrl: string | undefined;

  constructor(options: DeviceManagerOptions) {
    this.logger = options.logger ?? noopLogger;
    this.httpDo = options.httpDo;
  }

  async register(token: string): Promise<DeviceRegistration> {
    this.logger.debug('Registering device with WDM');

    const body = {
      deviceName: 'webex-message-handler',
      deviceType: 'DESKTOP',
      localizedModel: 'nodejs',
      model: 'nodejs',
      name: 'webex-message-handler',
      systemName: 'webex-message-handler',
      systemVersion: '1.0.0',
    };

    try {
      const response = await this.httpDo({
        url: WDM_API_BASE,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        this.logger.error('Device registration failed: Unauthorized');
        throw new AuthError('Unauthorized to register device');
      }

      if (!response.ok) {
        this.logger.error(
          `Device registration failed with status ${response.status}`
        );
        throw new DeviceRegistrationError(
          'Failed to register device',
          response.status
        );
      }

      const data = (await response.json()) as WDMDeviceResponse;
      this.deviceUrl = data.url;

      const deviceRegistration = this.parseDeviceResponse(data);
      this.logger.info('Device registered successfully');
      return deviceRegistration;
    } catch (error) {
      if (error instanceof AuthError || error instanceof DeviceRegistrationError) {
        throw error;
      }
      this.logger.error(`Device registration error: ${error}`);
      throw new DeviceRegistrationError('Failed to register device');
    }
  }

  async refresh(token: string): Promise<DeviceRegistration> {
    if (!this.deviceUrl) {
      throw new DeviceRegistrationError(
        'Device not registered. Call register() first.'
      );
    }

    this.logger.debug('Refreshing device registration');

    const body = {
      deviceName: 'webex-message-handler',
      deviceType: 'DESKTOP',
      localizedModel: 'nodejs',
      model: 'nodejs',
      name: 'webex-message-handler',
      systemName: 'webex-message-handler',
      systemVersion: '1.0.0',
    };

    try {
      const response = await this.httpDo({
        url: this.deviceUrl,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        this.logger.error('Device refresh failed: Unauthorized');
        throw new AuthError('Unauthorized to refresh device');
      }

      if (!response.ok) {
        this.logger.error(`Device refresh failed with status ${response.status}`);
        throw new DeviceRegistrationError(
          'Failed to refresh device',
          response.status
        );
      }

      const data = (await response.json()) as WDMDeviceResponse;
      const deviceRegistration = this.parseDeviceResponse(data);

      this.logger.info('Device refreshed successfully');
      return deviceRegistration;
    } catch (error) {
      if (error instanceof AuthError || error instanceof DeviceRegistrationError) {
        throw error;
      }
      this.logger.error(`Device refresh error: ${error}`);
      throw new DeviceRegistrationError('Failed to refresh device');
    }
  }

  async unregister(token: string): Promise<void> {
    if (!this.deviceUrl) {
      throw new DeviceRegistrationError(
        'Device not registered. Call register() first.'
      );
    }

    this.logger.debug('Unregistering device');

    try {
      const response = await this.httpDo({
        url: this.deviceUrl,
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 401) {
        this.logger.error('Device unregistration failed: Unauthorized');
        throw new AuthError('Unauthorized to unregister device');
      }

      if (!response.ok) {
        this.logger.error(
          `Device unregistration failed with status ${response.status}`
        );
        throw new DeviceRegistrationError(
          'Failed to unregister device',
          response.status
        );
      }

      this.deviceUrl = undefined;

      this.logger.info('Device unregistered successfully');
    } catch (error) {
      if (error instanceof AuthError || error instanceof DeviceRegistrationError) {
        throw error;
      }
      this.logger.error(`Device unregistration error: ${error}`);
      throw new DeviceRegistrationError('Failed to unregister device');
    }
  }

  private parseDeviceResponse(data: WDMDeviceResponse): DeviceRegistration {
    const services: Record<string, string> = data.services && typeof data.services === 'object'
      ? data.services
      : {};

    const encryptionServiceUrl = services['encryptionServiceUrl'] || '';

    return {
      webSocketUrl: data.webSocketUrl,
      deviceUrl: data.url,
      userId: data.userId,
      services,
      encryptionServiceUrl,
    };
  }
}
