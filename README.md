<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Inverter SolarCharge Plugin

A dynamic platform plugin for Homebridge that integrates solar inverters / home batteries via Modbus (RTU/TCP) and the SolarCharge service. Supports multiple inverter brands (Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar) through a JSON-based, zero-code extensible profile system.

## Features

- **🔄 Multi-Brand Support**: Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar
- **📱 HomeKit Integration**: Real-time telemetry displayed on Home screen (see separate section)
  - 💡 Solar Inverter tile using a light sensor to display Solar Production (tap to display switch to toggle on purchase of power from grid) 
  - 🌡️ Solar Battery tile using a temperature sensor to display Battery Level (tap to display switch to toggle on sale of power to grid) 
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

## HomeKit Integration

The plugin creates two sophisticated accessories with hierarchical HomeKit UI:

### Accessory 1: Solar Inverter

- **Primary Service**: LightSensor ("Inverter Production")
  - Displays current solar production as Lux value (1W = 1 Lux)
  - Real-time updates every 5 seconds

- **Control Switch**: "Inverter Connected"
  - Toggle ON to enable grid charging (buy mode)
  - When ON, fetches user-defined buy times from SolarCharge app
  - Auto-toggles OFF if app has buy times disabled (00:00-00:00)
  - Updates inverter settings via Modbus register write

### Accessory 2: Solar Battery

- **Primary Service**: Switch ("Battery Status")
  - Toggle ON to enable grid discharging (sell mode)
  - When ON, fetches user-defined sell times from SolarCharge app
  - Auto-toggles OFF if app has sell times disabled (00:00-00:00)
  - Updates inverter settings via Modbus register write
  - Creates large tile on Home app for easy access

- **Secondary Service**: TemperatureSensor ("Battery Level")
  - Displays battery percentage as temperature value (0°–100°C = 0%–100% SoC)

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

## Supported Inverters and Documentation Links

<table class="NRefec">
  <tr><th>Supports</th><th>JSON Profile File</th><th>Connection</th><th>Phases</th><th>Battery Support</th><th>Default Port / Baudrate</th><th>Primary Source Documentation / Register Maps</th></tr>
  <tr><td>Growatt<br>(SPH, SPA, MIN, MOD, MID, MAX)</td><td>growatt_sph.json</td><td>RTU &amp; TCP</td><td>1 - 3</td><td>Yes (Hybrid/Storage)</td><td>9600 baud / Port 502</td><td>Verified via the official <a href="https://github.com/johanmeijer/grott/blob/master/documentatie/Growatt-Inverter-Modbus-RTU-Protocol-II-V1-24-English-new.pdf">Growatt Modbus RTU Protocol II Manual (Direct PDF)</a> and mapped via the open-source <a href="https://github.com/Lu-Fi/ha-growatt-modbus">ha-growatt-modbus Repository</a>.</td></tr>
  <tr><td>GoodWe<br>(ET, EH, ES, EM)</td><td>goodwe_et.json</td><td>TCP</td><td>1 - 3</td><td>Yes</td><td>Port 8899</td><td>Core register definitions mapped directly from the official <a href="https://github.com/home-assistant/core/tree/dev/homeassistant/components/goodwe">Home Assistant GoodWe Inverter Component</a>.</td></tr>
  <tr><td>SolaX Power<br>(X1, X3, Hybrid Gen2-Gen5)</td><td>solax_hybrid.json</td><td>RTU &amp; TCP</td><td>1 - 3</td><td>Yes</td><td>9600 or 115200 / Port 502</td><td>Multi-generation maps (Gen 2-5) maintained in the master <a href="https://github.com/wills106/homeassistant-solax-modbus">homeassistant-solax-modbus Registry</a>.</td></tr>
  <tr><td>SolarEdge<br>(All Models)</td><td>solaredge_sunspec.json</td><td>TCP</td><td>1 - 3</td><td>Yes (with StoreEdge)</td><td>Port 1502 (or 502)</td><td>SunSpec protocol standard. Full register offsets (Inverter DID 101/103, Meter DID 201/203) are detailed in the official <a href="https://knowledge-center.solaredge.com/sites/kc/files/sunspec-implementation-technical-note.pdf">SolarEdge SunSpec Implementation Guide (PDF)</a> and <a href="https://sunspec.org/specifications/">SunSpec Specifications Library</a>.</td></tr>
  <tr><td>Fronius<br>(Primo, Symo, Gen24, Tauro)</td><td>fronius_sunspec.json</td><td>TCP</td><td>1 - 3</td><td>Yes (Gen24 series)</td><td>Port 502</td><td>SunSpec standard maps (Inverter blocks and Meter DID 201-203) are available in the <a href="https://praktis.sk/___files/produkty/dokumenty/Fronius_Datamanager_Modbus_TCP&RTU_20230209_233931.pdf">Fronius Datamanager Modbus Guide (PDF)</a>. Advanced blocks are linked via the <a href="https://sunspec.org/specifications/">SunSpec Specifications Library</a>.</td></tr>
  <tr><td>Deye / Sunsynk / Solark<br>(Hybrid Series)</td><td>deye_hybrid.json</td><td>RTU &amp; TCP</td><td>1 - 3</td><td>Yes</td><td>9600 baud / Port 502</td><td>Advanced EMS Time-of-Use control registers decoded in the <a href="https://github.com/Developer089/deye-modbus-ha">deye-modbus-ha Project</a>.</td></tr>
  <tr><td>Sofar Solar<br>(HYD Series &amp; Grid-tied)</td><td>sofar_hyd.json</td><td>RTU &amp; TCP</td><td>1 - 3</td><td>Yes (HYD series)</td><td>9600 baud / Port 502</td><td>Target register block frames extracted directly from the <a href="https://github.com/home-assistant/core/tree/dev/homeassistant/components/sofar">Home Assistant Sofar Inverter Component</a>.</td></tr>
</table>

Add more by creating new JSON profiles.

If you find something not correct in a JSON file make a pull request and / or report an issue.

## License

This project is licensed under the ISC License.
