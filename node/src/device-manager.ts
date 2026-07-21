import { DeviceRegistration, FetchRequest, FetchResponse } from './types.js';
import { AuthError, DeviceRegistrationError } from './errors.js';
import { Logger, noopLogger } from './logger.js';
import { validateWebexUrl } from './url-validation.js';

type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;

interface DeviceManagerOptions {
  logger?: Logger;
  httpDo: HttpDoFn;
}

interface WDMDeviceResponse {
  webSocketUrl: string;
  url: string;
  userId: string;
  name?: string;
  deviceType?: string;
  services: Record<string, string>;
}

interface WDMDeviceListResponse {
  devices: WDMDeviceResponse[];
}

const WDM_API_BASE = 'https://wdm-a.wbx2.com/wdm/api/v1/devices';
const U2C_CATALOG_URL = 'https://u2c.wbx2.com/u2c/api/v1/catalog?format=hostmap';

const DEVICE_BODY = {
  deviceName: 'webex-message-handler',
  deviceType: 'DESKTOP',
  localizedModel: 'nodejs',
  model: 'nodejs',
  name: 'webex-message-handler',
  systemName: 'webex-message-handler',
  systemVersion: '1.0.0',
};

export class DeviceManager {
  private logger: Logger;
  private httpDo: HttpDoFn;
  private deviceUrl: string | undefined;
  private wdmDevicesUrl: string | undefined;

  constructor(options: DeviceManagerOptions) {
    this.logger = options.logger ?? noopLogger;
    this.httpDo = options.httpDo;
  }

  private async discoverWdmBase(token: string): Promise<string> {
    if (this.wdmDevicesUrl) {
      return this.wdmDevicesUrl;
    }

    try {
      const response = await this.httpDo({
        url: U2C_CATALOG_URL,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        this.logger.warn(
          `U2C discovery returned ${response.status}; falling back to ${WDM_API_BASE}`
        );
        this.wdmDevicesUrl = WDM_API_BASE;
        return this.wdmDevicesUrl;
      }

      const catalog = (await response.json()) as { serviceLinks?: Record<string, string> };
      const wdm = catalog.serviceLinks?.['wdm'];

      if (!wdm) {
        this.logger.warn(
          `U2C catalog has no wdm service link; falling back to ${WDM_API_BASE}`
        );
        this.wdmDevicesUrl = WDM_API_BASE;
        return this.wdmDevicesUrl;
      }

      try {
        validateWebexUrl(wdm, 'https:');
      } catch (error) {
        this.logger.error(
          `U2C-discovered wdm URL "${wdm}" untrusted (${error instanceof Error ? error.message : String(error)}); falling back to ${WDM_API_BASE}`
        );
        this.wdmDevicesUrl = WDM_API_BASE;
        return this.wdmDevicesUrl;
      }

      this.wdmDevicesUrl = wdm.replace(/\/$/, '') + '/devices';
      this.logger.info(
        `Discovered region-correct WDM endpoint: ${this.wdmDevicesUrl}`
      );
      return this.wdmDevicesUrl;
    } catch (error) {
      this.logger.warn(
        `U2C discovery failed (${error instanceof Error ? error.message : String(error)}); falling back to ${WDM_API_BASE}`
      );
      this.wdmDevicesUrl = WDM_API_BASE;
      return this.wdmDevicesUrl;
    }
  }

  setWdmDevicesUrl(url: string): void {
    this.wdmDevicesUrl = url;
  }

  async register(token: string): Promise<DeviceRegistration> {
    this.logger.debug('Registering device with WDM');

    // Reuse-before-register: if a device of ours already exists, refresh it.
    const existingDeviceUrl = await this.findReusableDevice(token);
    if (existingDeviceUrl) {
      this.deviceUrl = existingDeviceUrl;
      try {
        const reg = await this.refresh(token);
        this.logger.info('Reused existing WDM device registration');
        return reg;
      } catch {
        // Refresh failed (device stale/deleted server-side) — fall through to
        // create a fresh one.
        this.deviceUrl = undefined;
      }
    }

    let reg: DeviceRegistration;
    try {
      reg = await this.createDevice(token);
    } catch (error) {
      if (this.isExcessiveRegistrationsError(error)) {
        this.logger.warn('Excessive device registrations detected — reaping this client\'s devices and retrying');
        await this.reapOwnDevices(token);
        return this.createDevice(token);
      }
      throw error;
    }
    return reg;
  }

  private async createDevice(token: string): Promise<DeviceRegistration> {
    try {
      const base = await this.discoverWdmBase(token);
      const createUrl = `${base}?includeUpstreamServices=all`;
      const response = await this.httpDo({
        url: createUrl,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(DEVICE_BODY),
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

  private async findReusableDevice(token: string): Promise<string | undefined> {
    try {
      const devices = await this.listDevices(token);
      for (const device of devices) {
        if (
          device.name === DEVICE_BODY.name &&
          device.deviceType === DEVICE_BODY.deviceType &&
          device.url
        ) {
          return device.url;
        }
      }
    } catch (error) {
      this.logger.debug(`Could not list existing devices (will create new): ${error}`);
    }
    return undefined;
  }

  private async reapOwnDevices(token: string): Promise<void> {
    try {
      const devices = await this.listDevices(token);
      let reaped = 0;
      for (const device of devices) {
        if (
          device.name !== DEVICE_BODY.name ||
          device.deviceType !== DEVICE_BODY.deviceType ||
          !device.url
        ) {
          continue;
        }
        try {
          const response = await this.httpDo({
            url: device.url,
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (response.ok || response.status === 404) {
            reaped++;
          }
        } catch (error) {
          this.logger.debug(`Failed to reap device ${device.url}: ${error}`);
        }
      }
      this.logger.info(`Reaped ${reaped} stale WDM device(s)`);
    } catch (error) {
      this.logger.warn(`Could not list devices to reap: ${error}`);
    }
  }

  private async listDevices(token: string): Promise<WDMDeviceResponse[]> {
    const base = await this.discoverWdmBase(token);
    const response = await this.httpDo({
      url: base,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      throw new AuthError('Unauthorized to list devices');
    }

    if (!response.ok) {
      throw new DeviceRegistrationError(
        `Failed to list devices: ${response.status}`,
        response.status
      );
    }

    const list = (await response.json()) as WDMDeviceListResponse;
    return list.devices || [];
  }

  private isExcessiveRegistrationsError(error: unknown): boolean {
    return error instanceof DeviceRegistrationError && error.statusCode === 403;
  }

  async refresh(token: string): Promise<DeviceRegistration> {
    if (!this.deviceUrl) {
      throw new DeviceRegistrationError(
        'Device not registered. Call register() first.'
      );
    }

    this.logger.debug('Refreshing device registration');

    try {
      const response = await this.httpDo({
        url: this.deviceUrl,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(DEVICE_BODY),
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

    // Validate external API URLs
    try {
      validateWebexUrl(data.webSocketUrl, 'wss:');
      if (encryptionServiceUrl) {
        validateWebexUrl(encryptionServiceUrl, 'https:');
      }
    } catch (error) {
      throw new DeviceRegistrationError(
        `Invalid URL in WDM response: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return {
      webSocketUrl: data.webSocketUrl,
      deviceUrl: data.url,
      userId: data.userId,
      services,
      encryptionServiceUrl,
    };
  }
}
