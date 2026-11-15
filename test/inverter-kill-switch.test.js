import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { InverterProfileFactory } from '../dist/profile-loader.js';
import { InverterSolarChargePlatform } from '../dist/platform.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };
const api = { on() {} };

function modbus() {
  const writes = [];
  const values = new Map();
  return {
    writes,
    async readInputRegisters() {
      return { data: [50, 0] };
    },
    async readHoldingRegisters(address, count) {
      if (address === 45) {
        return { data: [2000, 1, 1, 0, 0, 0] };
      }
      return { data: Array.from({ length: count }, (_, i) => values.get(address + i) ?? 1) };
    },
    async writeRegister(address, value) {
      writes.push([address, value]);
      values.set(address, value);
    },
    async writeRegisters(address, registers) {
      writes.push([address, registers]);
    },
  };
}

test('Homebridge schema exposes a disabled-by-default boolean kill switch', () => {
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.schema.properties.killSwitch.type, 'boolean');
  assert.equal(schema.schema.properties.killSwitch.default, false);
});

for (const selection of ['auto', 'Growatt_SPH']) {
  test(`kill switch blocks all inverter writes with ${selection} profile selection`, async () => {
    const platform = new InverterSolarChargePlatform(log, {
      plantId: 'plant', serialNum: 'serial', inverterProfile: selection, killSwitch: true,
    }, api);
    await platform.initializeInverterProfile();
    const profile = platform.activeProfile;
    const client = modbus();

    assert.ok(profile);
    assert.equal(profile.killSwitch, true);
    assert.equal(await profile.setChargeSettings(client, true, 2, 6), false);
    assert.equal(await profile.setChargeSettings(client, false), false);
    assert.equal(await profile.setDischargeSettings(client, true, 17, 21), false);
    assert.equal(await profile.setDischargeSettings(client, false), false);
    assert.notEqual(await profile.syncClock(client), null);
    assert.equal((await profile.readMetrics(client)).batterySoC, 50);
    assert.deepEqual(client.writes, []);
  });
}

test('default configuration preserves inverter writes and factory behavior', async () => {
  const platform = new InverterSolarChargePlatform(log, {
    plantId: 'plant', serialNum: 'serial', inverterProfile: 'Growatt_SPH',
  }, api);
  await platform.initializeInverterProfile();
  const profile = platform.activeProfile;
  const client = modbus();

  assert.equal(profile.killSwitch, false);
  assert.equal(await profile.setChargeSettings(client, false), true);
  assert.equal(await profile.setDischargeSettings(client, true, 17, 21), true);
  await profile.syncClock(client);
  assert.ok(client.writes.some(([address]) => address === 1102));
  assert.ok(client.writes.some(([address]) => address === 1082));
  assert.ok(client.writes.some(([address]) => address === 45));

  const fromConfig = InverterProfileFactory.createFromConfig(profile.config, log, true);
  assert.equal(await fromConfig.setChargeSettings(client, true), false);
  assert.equal(InverterProfileFactory.createFromConfig(profile.config, log).killSwitch, false);
});

test('blocked SolarCharge schedule changes do not change HomeKit state', async () => {
  const platform = new InverterSolarChargePlatform(log, {
    plantId: 'plant', serialNum: 'serial', inverterProfile: 'Growatt_SPH', killSwitch: true,
  }, api);
  await platform.initializeInverterProfile();
  const updates = [];
  platform.modbusClient = modbus();
  platform.api.hap = { Characteristic: { On: 'On' } };
  platform.solarSwitchService = { updateCharacteristic: (...args) => updates.push(args) };
  platform.batterySwitchService = { updateCharacteristic: (...args) => updates.push(args) };
  platform.solarChargeUploader = {
    async getInverterSettings() {
      return { profileName: 'Growatt_SPH', buyFrom: 2, buyTo: 6, sellFrom: 17, sellTo: 21 };
    },
  };
  await platform.pollInverterSettings();
  assert.deepEqual(platform.modbusClient.writes, []);
  assert.deepEqual(updates, []);
  assert.equal(platform.lastBuying, false);
  assert.equal(platform.lastSending, false);
});
