import { Socket, createSocket } from 'dgram';
import { EventEmitter } from 'events';
import util from 'util';

import type log from 'loglevel';
import { encrypt, decrypt } from 'tplink-smarthome-crypto';
// eslint-disable-next-line import/no-extraneous-dependencies
import type { DeepRequired, MarkOptional } from 'ts-essentials';

import Device, { isBulbSysinfo, isPlugSysinfo } from './device';
import type { Sysinfo } from './device';
import Bulb from './bulb';
import Plug, { hasSysinfoChildren } from './plug';
import createLogger from './logger';
import type { Logger } from './logger';
import TcpConnection from './network/tcp-connection';
import UdpConnection from './network/udp-connection';
import { compareMac, isDefinedAndNotNull, isObjectLike } from './utils';

const discoveryMsgBuf = encrypt(
  '{"system":{"get_sysinfo":{}},"emeter":{"get_realtime":{}},"smartlife.iot.common.emeter":{"get_realtime":{}}}'
);

export type AnyDevice = Bulb | Plug;

type DeviceDiscovery = { status: string; seenOnDiscovery: number };
type AnyDeviceDiscovery = (Bulb | Plug) & Partial<DeviceDiscovery>;

type SysinfoResponse = { system: { get_sysinfo: Sysinfo } };
type EmeterResponse = PlugEmeterResponse | BulbEmeterResponse;
type PlugEmeterResponse = {
  emeter?: { get_realtime?: { err_code: number } & EmeterRealtime };
};
type BulbEmeterResponse = {
  'smartlife.iot.common.emeter'?: {
    get_realtime?: { err_code: number } & EmeterRealtime;
  };
};
type DiscoveryResponse = SysinfoResponse & EmeterResponse;

type EmeterRealtime = EmeterRealtimeV1 | EmeterRealtimeV2;
type EmeterRealtimeV1 = {
  voltage: number;
  current: number;
  power: number;
  total: number;
};
type EmeterRealtimeV2 = {
  voltage_mv: number;
  current_ma: number;
  power_mw: number;
  total_wh: number;
};

type AnyDeviceOptions =
  | ConstructorParameters<typeof Bulb>[0]
  | ConstructorParameters<typeof Plug>[0];

type AnyDeviceOptionsCon =
  | MarkOptional<ConstructorParameters<typeof Plug>[0], 'client' | 'sysInfo'>
  | MarkOptional<ConstructorParameters<typeof Bulb>[0], 'client' | 'sysInfo'>;

type DiscoveryDevice = { host: string; port?: number };

function isSysinfoResponse(candidate: unknown): candidate is SysinfoResponse {
  return (
    isObjectLike(candidate) &&
    'system' in candidate &&
    isObjectLike(candidate.system) &&
    'get_sysinfo' in candidate.system
  );
}

function hasPlugEmeterResponse(
  candidate: unknown
): candidate is DeepRequired<PlugEmeterResponse> {
  return (
    isObjectLike(candidate) &&
    'emeter' in candidate &&
    isObjectLike(candidate.emeter) &&
    'get_realtime' in candidate.emeter &&
    isObjectLike(candidate.emeter.get_realtime) &&
    'err_code' in candidate.emeter.get_realtime &&
    typeof candidate.emeter.get_realtime.err_code === 'number'
  );
}

function hasBulbEmeterResponse(
  candidate: unknown
): candidate is DeepRequired<BulbEmeterResponse> {
  return (
    isObjectLike(candidate) &&
    'smartlife.iot.common.emeter' in candidate &&
    isObjectLike(candidate['smartlife.iot.common.emeter']) &&
    'get_realtime' in candidate['smartlife.iot.common.emeter'] &&
    isObjectLike(candidate['smartlife.iot.common.emeter'].get_realtime) &&
    'err_code' in candidate['smartlife.iot.common.emeter'].get_realtime &&
    typeof candidate['smartlife.iot.common.emeter'].get_realtime.err_code ===
      'number'
  );
}

function parseEmeter(response: DiscoveryResponse): EmeterRealtime | null {
  if (hasPlugEmeterResponse(response)) {
    if (response.emeter.get_realtime.err_code === 0) {
      return response.emeter.get_realtime;
    }
  }
  if (hasBulbEmeterResponse(response)) {
    if (response['smartlife.iot.common.emeter'].get_realtime.err_code === 0) {
      return response['smartlife.iot.common.emeter'].get_realtime;
    }
  }

  return null;
}

/**
 * Send Options.
 *
 * @typeParam timeout - (ms)
 * @typeParam transport - 'tcp','udp'
 * @typeParam useSharedSocket - attempt to reuse a shared socket if available, UDP only
 * @typeParam sharedSocketTimeout - (ms) how long to wait for another send before closing a shared socket. 0 = never automatically close socket
 */
export type SendOptions = {
  timeout?: number;
  transport?: 'tcp' | 'udp';
  useSharedSocket?: boolean;
  sharedSocketTimeout?: number;
};

/**
 * Client that sends commands to specified devices or discover devices on the local subnet.
 * - Contains factory methods to create devices.
 * - Events are emitted after {@link #startDiscovery} is called.
 */
export default class Client extends EventEmitter {
  defaultSendOptions: Required<SendOptions> = {
    timeout: 10000,
    transport: 'tcp',
    useSharedSocket: false,
    sharedSocketTimeout: 20000,
  };

  log: log.RootLogger;

  devices: Map<string, AnyDeviceDiscovery> = new Map();

  discoveryTimer: NodeJS.Timeout | null = null;

  discoveryPacketSequence = 0;

  maxSocketId = 0;

  socket?: Socket;

  isSocketBound = false;

  /**
   * @param  options
   * @param  options.defaultSendOptions
   * @param  options.defaultSendOptions.timeout - default: 10000
   * @param  options.defaultSendOptions.transport - default: 'tcp'
   * @param  options.defaultSendOptions.useSharedSocket - default: false
   * @param  options.defaultSendOptions.sharedSocketTimeout - default: 20000
   * @param  options.logLevel - default: warn - level for built in logger ['error','warn','info','debug','trace']
   */
  constructor({
    defaultSendOptions,
    logLevel = 'warn',
    logger,
  }: {
    defaultSendOptions?: SendOptions;
    logLevel?: log.LogLevelDesc;
    logger?: Logger;
  } = {}) {
    super();
    this.defaultSendOptions = {
      ...this.defaultSendOptions,
      ...defaultSendOptions,
    };

    this.log = createLogger({ logger });
    if (isDefinedAndNotNull(logLevel)) {
      this.log.setLevel(logLevel);
    }
  }

  /**
   * Used by `tplink-connection`
   * @internal
   */
  getNextSocketId(): number {
    this.maxSocketId += 1;
    return this.maxSocketId;
  }

  /**
   * {@link https://github.com/plasticrake/tplink-smarthome-crypto Encrypts} `payload` and sends to device.
   * - If `payload` is not a string, it is `JSON.stringify`'d.
   * - Promise fulfills with string response.
   *
   * Devices use JSON to communicate.\
   * For Example:
   * - If a device receives:
   *   - `{"system":{"get_sysinfo":{}}}`
   * - It responds with:
   *   - `{"system":{"get_sysinfo":{
   *       err_code: 0,
   *       sw_ver: "1.0.8 Build 151113 Rel.24658",
   *       hw_ver: "1.0",
   *       ...
   *     }}}`
   *
   * All responses from device contain an `err_code` (`0` is success).
   *
   * @param   port - default:9999
   * @returns response
   */
  async send(
    payload: object | string,
    host: string,
    port = 9999,
    sendOptions?: SendOptions
  ): Promise<string> {
    const thisSendOptions = {
      ...this.defaultSendOptions,
      ...sendOptions,
      useSharedSocket: false,
    };

    const payloadString = !(typeof payload === 'string')
      ? JSON.stringify(payload)
      : payload;

    let connection: UdpConnection | TcpConnection;

    if (thisSendOptions.transport === 'udp') {
      connection = new UdpConnection(host, port, this.log, this);
    } else {
      connection = new TcpConnection(host, port, this.log, this);
    }
    const response = await connection.send(
      payloadString,
      port,
      host,
      thisSendOptions
    );
    connection.close();
    return response;
  }

  /**
   * Requests `{system:{get_sysinfo:{}}}` from device.
   *
   * @param  {string}       host
   * @param  {number}      [port=9999]
   * @param  {SendOptions} [sendOptions]
   * @returns {Promise<Object, Error>} parsed JSON response
   */
  async getSysInfo(
    host: string,
    port = 9999,
    sendOptions?: SendOptions
  ): Promise<Sysinfo> {
    this.log.debug('client.getSysInfo(%j)', { host, port, sendOptions });
    const response = await this.send(
      '{"system":{"get_sysinfo":{}}}',
      host,
      port,
      sendOptions
    );

    const responseObj = JSON.parse(response);
    if (isSysinfoResponse(responseObj)) {
      return responseObj.system.get_sysinfo;
    }

    throw new Error(`Unexpected Response: ${response}`);
  }

  /**
   * @internal
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(eventName: string, ...args: any[]): boolean {
    // Add device- / plug- / bulb- to eventName
    let ret = false;
    if (args[0] instanceof Device) {
      if (super.emit(`device-${eventName}`, ...args)) {
        ret = true;
      }
      if (args[0].deviceType !== 'device') {
        if (super.emit(`${args[0].deviceType}-${eventName}`, ...args)) {
          ret = true;
        }
      }
    } else if (super.emit(eventName, ...args)) {
      ret = true;
    }
    return ret;
  }

  /**
   * Creates Bulb object.
   *
   * See [Device constructor]{@link Device} and [Bulb constructor]{@link Bulb} for valid options.
   * @param  {Object} deviceOptions passed to [Bulb constructor]{@link Bulb}
   * @returns {Bulb}
   */
  getBulb(
    deviceOptions: MarkOptional<ConstructorParameters<typeof Bulb>[0], 'client'>
  ): Bulb {
    return new Bulb({
      defaultSendOptions: this.defaultSendOptions,
      ...deviceOptions,
      client: this,
    });
  }

  /**
   * Creates {@link Plug} object.
   *
   * See [Device constructor]{@link Device} and [Plug constructor]{@link Plug} for valid options.
   * @param  {Object} deviceOptions passed to [Plug constructor]{@link Plug}
   * @returns {Plug}
   */
  getPlug(
    deviceOptions: MarkOptional<ConstructorParameters<typeof Plug>[0], 'client'>
  ): Plug {
    return new Plug({
      defaultSendOptions: this.defaultSendOptions,
      ...deviceOptions,
      client: this,
    });
  }

  /**
   * Creates a {@link Plug} or {@link Bulb} from passed in sysInfo or after querying device to determine type.
   *
   * See [Device constructor]{@link Device}, [Bulb constructor]{@link Bulb}, [Plug constructor]{@link Plug} for valid options.
   * @param  {Object}      deviceOptions passed to [Device constructor]{@link Device}
   * @param  {SendOptions} [sendOptions]
   * @returns {Promise<AnyDevice, Error>}
   */
  async getDevice(
    deviceOptions: AnyDeviceOptionsCon,
    sendOptions?: SendOptions
  ): Promise<AnyDevice> {
    this.log.debug('client.getDevice(%j)', { deviceOptions, sendOptions });
    let sysInfo: Sysinfo;
    if ('sysInfo' in deviceOptions && deviceOptions.sysInfo !== undefined) {
      sysInfo = deviceOptions.sysInfo;
    } else {
      sysInfo = await this.getSysInfo(
        deviceOptions.host,
        deviceOptions.port,
        sendOptions
      );
    }

    const combinedDeviceOptions = {
      ...deviceOptions,
      client: this,
    } as AnyDeviceOptions;
    return this.getDeviceFromSysInfo(sysInfo, combinedDeviceOptions);
  }

  /**
   * Creates device corresponding to the provided `sysInfo`.
   *
   * See [Device constructor]{@link Device}, [Bulb constructor]{@link Bulb}, [Plug constructor]{@link Plug} for valid options
   * @param  {Object} sysInfo
   * @param  {Object} deviceOptions passed to device constructor
   * @returns {Plug|Bulb}
   * @throws
   */
  getDeviceFromSysInfo(
    sysInfo: Sysinfo,
    deviceOptions: AnyDeviceOptionsCon
  ): AnyDevice {
    if (isPlugSysinfo(sysInfo)) {
      return this.getPlug({ ...deviceOptions, sysInfo });
    }
    if (isBulbSysinfo(sysInfo)) {
      return this.getBulb({ ...deviceOptions, sysInfo });
    }
    throw new Error('Could not determine device from sysinfo');
  }

  /**
   * Guess the device type from provided `sysInfo`.
   *
   * Based on sysinfo.[type|mic_type]
   * @param  {Object} sysInfo
   * @returns {string}         'plug','bulb','device'
   */
  // eslint-disable-next-line class-methods-use-this
  getTypeFromSysInfo(
    sysInfo: { type: string } | { mic_type: string }
  ): 'plug' | 'bulb' | 'device' {
    const type = 'type' in sysInfo ? sysInfo.type : sysInfo.mic_type;
    switch (true) {
      case /plug/i.test(type):
        return 'plug';
      case /bulb/i.test(type):
        return 'bulb';
      default:
        return 'device';
    }
  }

  /**
   * First response from device.
   * @event Client#device-new
   * @property {Device|Bulb|Plug}
   */
  /**
   * Follow up response from device.
   * @event Client#device-online
   * @property {Device|Bulb|Plug}
   */
  /**
   * No response from device.
   * @event Client#device-offline
   * @property {Device|Bulb|Plug}
   */
  /**
   * First response from Bulb.
   * @event Client#bulb-new
   * @property {Bulb}
   */
  /**
   * Follow up response from Bulb.
   * @event Client#bulb-online
   * @property {Bulb}
   */
  /**
   * No response from Bulb.
   * @event Client#bulb-offline
   * @property {Bulb}
   */
  /**
   * First response from Plug.
   * @event Client#plug-new
   * @property {Plug}
   */
  /**
   * Follow up response from Plug.
   * @event Client#plug-online
   * @property {Plug}
   */
  /**
   * No response from Plug.
   * @event Client#plug-offline
   * @property {Plug}
   */
  /**
   * Invalid/Unknown response from device.
   * @event Client#discovery-invalid
   * @property {Object} rinfo
   * @property {Buffer} response
   * @property {Buffer} decryptedResponse
   */
  /**
   * Error during discovery.
   * @event Client#error
   * @type {Object}
   * @property {Error}
   */
  /**
   * Discover TP-Link Smarthome devices on the network.
   *
   * - Sends a discovery packet (via UDP) to the `broadcast` address every `discoveryInterval`(ms).
   * - Stops discovery after `discoveryTimeout`(ms) (if `0`, runs until {@link #stopDiscovery} is called).
   *   - If a device does not respond after `offlineTolerance` number of attempts, {@link event:Client#device-offline} is emitted.
   * - If `deviceTypes` are specified only matching devices are found.
   * - If `macAddresses` are specified only devices with matching MAC addresses are found.
   * - If `excludeMacAddresses` are specified devices with matching MAC addresses are excluded.
   * - if `filterCallback` is specified only devices where the callback returns a truthy value are found.
   * - If `devices` are specified it will attempt to contact them directly in addition to sending to the broadcast address.
   *   - `devices` are specified as an array of `[{host, [port: 9999]}]`.
   * @param  {Object}    options
   * @param  {string}   [options.address]                     address to bind udp socket
   * @param  {number}   [options.port]                        port to bind udp socket
   * @param  {string}   [options.broadcast=255.255.255.255]   broadcast address
   * @param  {number}   [options.discoveryInterval=10000]     (ms)
   * @param  {number}   [options.discoveryTimeout=0]          (ms)
   * @param  {number}   [options.offlineTolerance=3]          # of consecutive missed replies to consider offline
   * @param  {string[]} [options.deviceTypes]                 'plug','bulb'
   * @param  {string[]} [options.macAddresses]                MAC will be normalized, comparison will be done after removing special characters (`:`,`-`, etc.) and case insensitive, glob style *, and ? in pattern are supported
   * @param  {string[]} [options.excludeMacAddresses]         MAC will be normalized, comparison will be done after removing special characters (`:`,`-`, etc.) and case insensitive, glob style *, and ? in pattern are supported
   * @param  {function} [options.filterCallback]              called with fn(sysInfo), return truthy value to include device
   * @param  {boolean}  [options.breakoutChildren=true]       if device has multiple outlets, create a separate plug for each outlet, otherwise create a plug for the main device
   * @param  {Object}   [options.deviceOptions]               passed to device constructors
   * @param  {Object[]} [options.devices]                     known devices to query instead of relying on broadcast
   * @returns {Client}                                        this
   * @emits  Client#error
   * @emits  Client#device-new
   * @emits  Client#device-online
   * @emits  Client#device-offline
   * @emits  Client#bulb-new
   * @emits  Client#bulb-online
   * @emits  Client#bulb-offline
   * @emits  Client#plug-new
   * @emits  Client#plug-online
   * @emits  Client#plug-offline
   * @emits  Client#discovery-invalid
   */
  startDiscovery({
    address,
    port,
    broadcast = '255.255.255.255',
    discoveryInterval = 10000,
    discoveryTimeout = 0,
    offlineTolerance = 3,
    deviceTypes,
    macAddresses = [],
    excludeMacAddresses = [],
    filterCallback,
    breakoutChildren = true,
    deviceOptions,
    devices,
  }: {
    address?: string;
    port?: number;
    broadcast?: string;
    discoveryInterval?: number;
    discoveryTimeout?: number;
    offlineTolerance?: number;
    deviceTypes?: string[];
    macAddresses?: string[];
    excludeMacAddresses?: string[];
    filterCallback?: Function;
    breakoutChildren?: boolean;
    deviceOptions?: AnyDeviceOptions;
    devices?: DiscoveryDevice[];
  } = {}): this {
    // eslint-disable-next-line prefer-rest-params
    this.log.debug('client.startDiscovery(%j)', arguments[0]);

    try {
      const socket = createSocket('udp4');
      this.socket = socket;

      socket.on('message', (msg, rinfo) => {
        const decryptedMsg = decrypt(msg).toString('utf8');

        this.log.debug(
          `client.startDiscovery(): socket:message From: ${rinfo.address} ${rinfo.port} Message: ${decryptedMsg}`
        );

        let response: DiscoveryResponse;
        let sysInfo: Sysinfo;
        let emeterRealtime: EmeterRealtime | null;
        try {
          response = JSON.parse(decryptedMsg);
          sysInfo = response.system.get_sysinfo;
          emeterRealtime = parseEmeter(response);
        } catch (err) {
          this.log.debug(
            `client.startDiscovery(): Error parsing JSON: %s\nFrom: ${rinfo.address} ${rinfo.port} Original: [%s] Decrypted: [${decryptedMsg}]`,
            err,
            msg
          );
          this.emit('discovery-invalid', {
            rinfo,
            response: msg,
            decryptedResponse: decrypt(msg),
          });
          return;
        }

        if (deviceTypes && deviceTypes.length > 0) {
          const deviceType = this.getTypeFromSysInfo(sysInfo);
          if (deviceTypes.indexOf(deviceType) === -1) {
            this.log.debug(
              `client.startDiscovery(): Filtered out: ${sysInfo.alias} [${sysInfo.deviceId}] (${deviceType}), allowed device types: (%j)`,
              deviceTypes
            );
            return;
          }
        }

        let mac: string;
        if ('mac' in sysInfo) mac = sysInfo.mac;
        else if ('mic_mac' in sysInfo) mac = sysInfo.mic_mac;
        else if ('ethernet_mac' in sysInfo) mac = sysInfo.ethernet_mac;
        else mac = '';

        if (macAddresses && macAddresses.length > 0) {
          if (!compareMac(mac, macAddresses)) {
            this.log.debug(
              `client.startDiscovery(): Filtered out: ${sysInfo.alias} [${sysInfo.deviceId}] (${mac}), allowed macs: (%j)`,
              macAddresses
            );
            return;
          }
        }

        if (excludeMacAddresses && excludeMacAddresses.length > 0) {
          if (compareMac(mac, excludeMacAddresses)) {
            this.log.debug(
              `client.startDiscovery(): Filtered out: ${sysInfo.alias} [${sysInfo.deviceId}] (${mac}), excluded mac`
            );
            return;
          }
        }

        if (typeof filterCallback === 'function') {
          if (!filterCallback(sysInfo)) {
            this.log.debug(
              `client.startDiscovery(): Filtered out: ${sysInfo.alias} [${sysInfo.deviceId}], callback`
            );
            return;
          }
        }

        this.createOrUpdateDeviceFromSysInfo({
          sysInfo,
          emeterRealtime,
          host: rinfo.address,
          port: rinfo.port,
          breakoutChildren,
          options: deviceOptions,
        });
      });

      socket.on('error', (err) => {
        this.log.error('client.startDiscovery: UDP Error: %s', err);
        this.stopDiscovery();
        this.emit('error', err);
        // TODO
      });

      socket.bind(port, address, () => {
        this.isSocketBound = true;
        const sockAddress = socket.address();
        this.log.debug(
          `client.socket: UDP ${sockAddress.family} listening on ${sockAddress.address}:${sockAddress.port}`
        );
        socket.setBroadcast(true);

        this.discoveryTimer = setInterval(() => {
          this.sendDiscovery(socket, broadcast, devices, offlineTolerance);
        }, discoveryInterval);

        this.sendDiscovery(socket, broadcast, devices, offlineTolerance);
        if (discoveryTimeout > 0) {
          setTimeout(() => {
            this.log.debug(
              'client.startDiscovery: discoveryTimeout reached, stopping discovery'
            );
            this.stopDiscovery();
          }, discoveryTimeout);
        }
      });
    } catch (err) {
      this.log.error('client.startDiscovery: %s', err);
      this.emit('error', err);
    }

    return this;
  }

  private static setSysInfoForDevice(
    device: AnyDeviceDiscovery,
    sysInfo: Sysinfo
  ): void {
    if (device instanceof Plug) {
      if (!isPlugSysinfo(sysInfo)) {
        throw new TypeError(
          util.format('Expected PlugSysinfo but received: %O', sysInfo)
        );
      }
      device.setSysInfo(sysInfo);
    } else if (device instanceof Bulb) {
      if (!isBulbSysinfo(sysInfo)) {
        throw new TypeError(
          util.format('Expected BulbSysinfo but received: %O', sysInfo)
        );
      }
      device.setSysInfo(sysInfo);
    }
  }

  private createOrUpdateDeviceFromSysInfo({
    sysInfo,
    emeterRealtime,
    host,
    port,
    options,
    breakoutChildren,
  }: {
    sysInfo: Sysinfo;
    emeterRealtime: EmeterRealtime | null;
    host: string;
    port: number;
    options?: AnyDeviceOptions;
    breakoutChildren: boolean;
  }): void {
    const process = (id: string, childId?: string): void => {
      let device: AnyDeviceDiscovery & Partial<DeviceDiscovery>;
      if (this.devices.has(id) && this.devices.get(id) !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        device = this.devices.get(id)!;
        device.host = host;
        device.port = port;
        Client.setSysInfoForDevice(device, sysInfo);
        device.status = 'online';
        device.seenOnDiscovery = this.discoveryPacketSequence;
        if (emeterRealtime !== null && device.emeter) {
          device.emeter.realtime = emeterRealtime;
        }
        this.emit('online', device);
      } else {
        // const deviceOptions: AnyDeviceOptions = ;
        device = this.getDeviceFromSysInfo(sysInfo, {
          ...options,
          client: this,
          host,
          port,
          childId,
        });
        device.status = 'online';
        device.seenOnDiscovery = this.discoveryPacketSequence;
        if (emeterRealtime !== null && device.emeter) {
          device.emeter.realtime = emeterRealtime;
        }
        this.devices.set(id, device);
        this.emit('new', device);
      }
    };

    if (breakoutChildren && hasSysinfoChildren(sysInfo)) {
      sysInfo.children.forEach((child) => {
        const childId =
          child.id.length === 2 ? sysInfo.deviceId + child.id : child.id;
        process(childId, childId);
      });
    } else {
      process(sysInfo.deviceId);
    }
  }

  /**
   * Stops discovery and closes UDP socket.
   */
  stopDiscovery(): void {
    this.log.debug('client.stopDiscovery()');
    if (this.discoveryTimer !== null) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    if (this.isSocketBound) {
      this.isSocketBound = false;
      if (this.socket != null) this.socket.close();
    }
  }

  private sendDiscovery(
    socket: Socket,
    address: string,
    devices: DiscoveryDevice[] = [],
    offlineTolerance: number
  ): void {
    this.log.debug(
      'client.sendDiscovery(%s, %j, %s)',
      address,
      devices,
      offlineTolerance
    );
    try {
      this.devices.forEach((device) => {
        if (device.status !== 'offline') {
          const diff =
            this.discoveryPacketSequence - (device.seenOnDiscovery || 0);

          if (diff >= offlineTolerance) {
            // eslint-disable-next-line no-param-reassign
            device.status = 'offline';
            this.emit('offline', device);
          }
        }
      });

      // sometimes there is a race condition with setInterval where this is called after it was cleared
      // check and exit
      if (!this.isSocketBound) {
        return;
      }
      socket.send(discoveryMsgBuf, 0, discoveryMsgBuf.length, 9999, address);

      devices.forEach((d) => {
        this.log.debug('client.sendDiscovery() direct device:', d);
        socket.send(
          discoveryMsgBuf,
          0,
          discoveryMsgBuf.length,
          d.port || 9999,
          d.host
        );
      });

      if (this.discoveryPacketSequence >= Number.MAX_VALUE) {
        this.discoveryPacketSequence = 0;
      } else {
        this.discoveryPacketSequence += 1;
      }
    } catch (err) {
      this.log.error('client.sendDiscovery: %s', err);
      this.emit('error', err);
    }
  }
}
