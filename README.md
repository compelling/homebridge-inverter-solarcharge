<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Inverter SolarCharge Plugin

A dynamic platform plugin for Homebridge that integrates solar inverters / home batteries via Modbus (RTU/TCP) and the SolarCharge service. Supports multiple inverter brands (Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar) through a JSON-based, zero-code extensible profile system.

## Features

- **🔄 Multi-Brand Support**: Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar
- **📱 HomeKit Integration**: Real-time telemetry displayed on Home screen 
  - Solar Inverter (solar power, battery %, grid flow)
- **🔌 Dual Accessories**: Separate controls for charging (buy) and discharging (sell)
- **☁️ Cloud Sync**: Fetch buy/sell times from SolarCharge API
- **⚡ Zero-Recompilation Extensibility**: Add new inverter brands via JSON profiles
- **🌐 Modbus Support**: Both RTU (serial) and TCP (network) connections

## Getting Started

### Installation

```bash
npm install -g homebridge-inverter-solarcharge
```

### Configuration

Add to your Homebridge `config.json`:

```json
{
  "platform": "SolarInverterCharge",
  "name": "Solar Inverter",
  "port": "/dev/ttyUSB0",
  "inverterProfile": "auto",
  "plantId": "your-plant-id",
  "serialNum": "your-serial",
  "baseUrl": "https://groshapp.com/test"
}
```

**Configuration Options:**
- `port`: Serial device (RTU) or network address (TCP)
- `inverterProfile`: `"auto"` (detect from config brand) or profile name (e.g., `"Growatt_SPH"`)
- `plantId`, `serialNum`: SolarCharge API credentials for syncing buy/sell times and uploading metrics
- `brand`: Inverter manufacturer name (used for auto-detection)
- `baseUrl`: SolarCharge API endpoint (default: `https://groshapp.com/test`)

## Architecture: JSON-Based Profile System

The plugin uses **JSON profiles** as the master source of truth. Each inverter brand is defined in `/profiles/*.json` with complete register mappings and encoding rules.

### Profile Structure

```json
{
  "name": "Growatt_SPH",
  "manufacturer": "Growatt",
  "model": "SPH 3000-6000 / SPH TL3",
  "phases": 3,
  "hasBattery": true,
  "connectionType": "RTU",
  "connection": {
    "baudRate": 9600,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none",
    "modbusSlaveId": 1
  },
  "telemetry": {
    "solarPowerRegister": 1009,
    "loadPowerRegister": 1012,
    "exportPowerRegister": 1010,
    "importPowerRegister": 1011,
    "batteryChargePowerRegister": 1013,
    "batteryDischargePowerRegister": 1014,
    "batterySocRegister": 1019,
    "scalingFactor": 0.1
  },
  "control": {
    "chargeStartTimeRegister": 1075,
    "chargeStopTimeRegister": 1076,
    "chargeEnableRegister": 1077,
    "dischargeStartTimeRegister": 1080,
    "dischargeStopTimeRegister": 1081,
    "dischargeEnableRegister": 1082
  },
  "encoding": {
    "timeFormat": "PackedBytes",
    "endianness": "BigEndian"
  }
}
```

### Registers Explained

Modbus operates on **16-bit registers** accessed by address. The plugin reads two types:

**1. Telemetry Registers (Input Registers - Function 04)**
- Read-only live metrics
- Example: Register 1009 = Solar PV Power (watts)
- Some manufacturers use u32 (two consecutive registers for values >65535)
- Scaling factor applied: `displayValue = registerValue × scalingFactor`

**2. Control Registers (Holding Registers - Functions 03, 06, 16)**
- Writable setpoints and schedules
- Example: Registers 1075-1076 = Charge start/stop times
- Some enable via single-bit flags, others use 0/1 values

### Time Encoding Formats

Different manufacturers encode time differently:

| Format | Example | Usage |
|--------|---------|-------|
| `PackedBytes` | `0x0202` = 02:02 | Growatt: `(hour << 8) \| minute` |
| `MinutesFromMidnight` | `120` = 02:00 | GoodWe: `hour * 60 + minute` |
| `RawInteger` | `2` = 02:00 | SolaX: Direct hour value |

### Byte Order (Endianness)

- **BigEndian** (standard Modbus): MSB first
- **LittleEndian**: Some devices swap bytes

Configured in `encoding.endianness`; the plugin applies corrections automatically.

## Adding a New Inverter Brand

### Step 1: Create JSON Profile

Create `/profiles/manufacturer-model.json` with register mappings:

```json
{
  "name": "YourBrand_Model",
  "manufacturer": "YourBrand",
  "model": "Model XYZ",
  "phases": 1,
  "hasBattery": true,
  "connectionType": "RTU",
  "connection": {
    "baudRate": 9600,
    "modbusSlaveId": 1
  },
  "telemetry": {
    "solarPowerRegister": 1000,
    "loadPowerRegister": 1001,
    "exportPowerRegister": 1002,
    "importPowerRegister": 1003,
    "batteryChargePowerRegister": 1004,
    "batteryDischargePowerRegister": 1005,
    "batterySocRegister": 1006,
    "scalingFactor": 0.1
  },
  "control": {
    "chargeStartTimeRegister": 2000,
    "chargeStopTimeRegister": 2001,
    "chargeEnableRegister": 2002,
    "dischargeStartTimeRegister": 2003,
    "dischargeStopTimeRegister": 2004,
    "dischargeEnableRegister": 2005
  },
  "encoding": {
    "timeFormat": "MinutesFromMidnight",
    "endianness": "BigEndian"
  }
}
```

### Step 2: Find Register Addresses

Consult your inverter's **Modbus Protocol Document**:
- Search for "Register Map" or "Holding Registers"
- Identify telemetry register ranges (usually 1000+)
- Identify control register ranges (usually 2000+)
- Note scaling factors (e.g., 0.1 means divide by 10)

### Step 3: Determine Time Encoding

Check protocol for time representation:
- Look for "Start Time" or "Charge Start" register examples
- Test by reading a known time (e.g., current device time)
- Map to one of the three formats above

### Step 4: Test and Restart

```bash
npm run build
homebridge -D
```

Plugin will auto-detect the new profile by matching `manufacturer` field. Check logs for confirmation.

## Modbus Connection Types

### RTU (Serial)

```json
"connectionType": "RTU",
"connection": {
  "baudRate": 9600,
  "dataBits": 8,
  "stopBits": 1,
  "parity": "none",
  "modbusSlaveId": 1
}
```

Requires serial device: `/dev/ttyUSB0` (Linux), `COM3` (Windows), `/dev/ttyUSB0` (Mac)

### TCP (Network)

```json
"connectionType": "TCP",
"connection": {
  "defaultTcpPort": 502,
  "modbusSlaveId": 1
}
```

Uses network address from `config.json` `port` field (e.g., `192.168.1.100:502`)

## HomeKit Accessories

The plugin creates two accessories:

1. **Inverter** (Accessory 1)
   - Switch: Toggle battery charging (buy-from-grid mode)
   - Light Sensor: Real-time solar power (as Lux)
   - Battery Service: Battery % level

2. **Battery** (Accessory 2)
   - Switch: Toggle battery discharging (sell-to-grid mode)
   - Temperature Sensor: Battery % as temperature display

## Troubleshooting

**Profile Not Detected:**
- Check `manufacturer` in config matches JSON profile exactly (case-sensitive)
- Verify `/profiles/*.json` files exist and parse correctly

**Modbus Connection Failed:**
- Verify `port` (serial device or IP:port) is correct
- Check baud rate matches inverter (usually 9600)
- Test with `modbus-serial` CLI tool

**Registers Reading Zero:**
- Confirm register addresses from inverter documentation
- Check Modbus slave ID (usually 1)
- Try reading with a Modbus scanner app

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Watch & auto-rebuild
npm run watch

# Run in debug mode
homebridge -D
```

## File Structure

```
src/
  platform.ts              # Main Homebridge platform plugin
  inverter-profile.ts      # Abstract profile interface
  profile-loader.ts        # JSON profile loader & factory
  solarcharge.ts           # SolarCharge cloud API client
  settings.ts              # Constants

profiles/                  # JSON inverter profiles (master source)
  growatt-sph.json
  goodwe-et.json
  solax-hybrid.json
  solaredge-se.json
  fronius-primo.json
  deye-sunsynk.json
  sofar-hyd.json
```

## Supported Inverters

| Brand | Model | Phases | Battery | Connection |
|-------|-------|--------|---------|------------|
| Growatt | SPH 5000-6000 / TL3 | 1-3 | Yes | RTU |
| GoodWe | ET | 1-3 | Yes | TCP |
| SolaX | Hybrid | 1-3 | Yes | RTU |
| SolarEdge | SE5000 | 1 | No | TCP |
| Fronius | Primo 6.0 | 1 | No | TCP |
| Deye/Sunsynk | SUN-10K-G3 | 1 | Yes | RTU |
| Sofar | HYD-EP | 1-3 | Yes | RTU |

Add more by creating new JSON profiles.

## License

This project is licensed under the ISC License.
