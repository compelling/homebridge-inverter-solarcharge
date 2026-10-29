<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Inverter SolarCharge Plugin

A dynamic platform plugin for Homebridge that integrates solar inverters / home batteries via Modbus (RTU/TCP), EV chargers via ModBus (RTU(TCP) or HTTP, and the SolarCharge service. Supports multiple solar inverter and EV charger brands through a JSON-based, zero-code extensible profile system.

## Features

- **🔄 Solar Inverter Multi-Brand Support**: Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar, Huawei
- **🔄 EV Charger Multi-Brand Support**: Wallbox, Alfen, ABB, go-e, Keba (X-Series), and Tesla (only Gen 2 via direct RS-485)

**📱 HomeKit Integration**: Real-time telemetry displayed on Home screen (see separate section)

- 💡 Solar Inverter tile using a light sensor to display Solar Production (tap to display switch to toggle on purchase of power from grid) 
- 🌡️ Solar Battery tile using a temperature sensor to display Battery Level (tap to display switch to toggle on sale of power to grid)

- **🚗 EV Charging**: Schedule chargers from SolarCharge, with auto-detection

- **☁️ Solar Cloud Sync**: Fetch solar inverter and battery buy/sell times + upload aggregated metrics via SolarCharge API, use SolarCharge app to view your metrics and generate production forecasts. 
- **☁️ Charging Cloud Sync**: Fetch EV charger start/stop times and charge rate via SolarCharge API, let SolarCharge app control your charging to optimize charging.

- **⚡ Zero-Recompilation Extensibility**: Add new inverter brands via JSON profiles
- **🌐 Modbus Support**: Both RTU (serial) and TCP (network) inverter and charger connections
- **🌐 HTTP Support**: For non-Modbus charger devices, HTTP connections can be configured

## Getting Started

### Installation

```bash
npm install -g homebridge-inverter-solarcharge
```

### Configuration

Either fill in the plugin settings UI to configure the plugin or add this to your Homebridge `config.json`:

```json
{
   "name": "Solar Inverter",
   "serialPort": "/dev/ttyUSB0",
   "inverterProfile": "auto",
   "logLevel": "debug",
   "plantId": "see-your-plantId-in-SC-app",
   "serialNum": "see-your-serial-in-SC-app",
   "platform": "InverterSolarCharge"
}
```

**Configuration Options:**

- `name`, `platform`: Dont change this
- `serialPort`: Serial device (RTU) or network address (TCP)
- `inverterProfile`: `"auto"` (detect from config brand) or profile name (e.g., `"Growatt_SPH"`)
- `plantId`, `serialNum`: SolarCharge API credentials for syncing buy/sell times and uploading metrics
- `chargerProfile` (optional): `"auto"` (default, detects the charger at `chargerIpAddress`) or a charger profile name (e.g., `"Alfen_Eve"`)
- `chargerId`: SolarCharge Charger ID, used instead of `plantId` for the charger API. EV charging is disabled when empty.
- `chargerIpAddress`: IP of the EV charger. EV charging is disabled when empty (Tesla RS-485 uses `chargerSerialPath` instead)
- `chargerSerialPath`: Serial device of the RS-485 adapter wired to a Tesla Wall Connector (e.g. `/dev/ttyUSB1`). EV charging is enabled by this or by `chargerIpAddress`; with only this set, profile `Tesla_TWC_RS485` is used automatically
- `chargerPort`: Overrides the profile's default port

## HomeKit Integration

The plugin creates two sophisticated accessories (plus a third one when an EV charger is configured) with hierarchical HomeKit UI:

### Accessory 1: Solar Inverter

- **Primary Service**: LightSensor ("Inverter Production")
  - Displays current solar production as Lux value (1W = 1 Lux)
  - Real-time updates every 5 seconds
  - Tap to open control switch
- **Control Switch**: Switch "Inverter Connected"
  - Toggle ON to enable grid charging (buy mode)
  - When ON, fetches user-defined buy times from SolarCharge app
  - Auto-toggles OFF if app has buy times disabled (00:00-00:00)
  - Updates inverter settings via Modbus register write

### Accessory 2: Solar Battery

- **Primary Service**: LightSensor ("Battery Level")
  - Displays battery percentage as Lux value (1 Lux = 1 % SoC)
  - Real-time updates every 5 seconds
  - Tap to open control switch
- **Control Switch**: Switch ("Battery Status")
  - Toggle ON to enable grid discharging (sell mode)
  - When ON, fetches user-defined sell times from SolarCharge app
  - Auto-toggles OFF if app has sell times disabled (00:00-00:00)
  - Updates inverter settings via Modbus register write

### Accessory 3: EV Charger (optional)

Created only when `chargerIpAddress` and `chargerId` are configured.

- **Primary Service**: LightSensor ("Charger Current")
  - Displays the current charging power as Lux value (1 W = 1 Lux, amps × voltage from the SolarCharge API, 0 = not charging)
  - Updated every time the charger is refreshed (every 5 minutes, or immediately when the switch is toggled)
- **Control Switch**: Switch ("EV Charging")
  - Shows ON while the charger is allowed to charge according to the SolarCharge schedule
  - Toggle ON to force charging at the charger's max current (`maxAmps` from the SolarCharge app, 16 A if unavailable) regardless of the schedule
  - Toggle OFF to return to the SolarCharge schedule (the switch then reflects the schedule again)
  - The accessory model shows the detected or selected charger profile

## Tesla Wall Connector Gen 2 (direct RS-485)

The plugin can act as the load-share **master** for a Tesla Wall Connector Gen 2, with no TWCManager or other external software. It needs its own RS-485 adapter, **separate from the inverter's** Modbus port.

- Set the Wall Connector's rotary switch to **Slave** and wire its A/B terminals to the adapter's A/B.
- Set `chargerSerialPath` (e.g. `/dev/ttyUSB1`) and `chargerId`; the baud rate is 9600 (8N1).
- On start the plugin announces itself (`linkready1`/`linkready2`), adopts the first Wall Connector that answers and then sends heartbeats offering the allowed current. Below 6 A the offer becomes 0 A (stop). If the plugin stops updating, the offer drops to 0 A after 10 minutes.
- Only one Wall Connector is supported. Test with no car connected first and look for `TWC slave ... linked` in the log.

**Protocol source:** the Tesla TWC Gen 2 RS-485 protocol is not officially documented. The message formats (`FC E1`/`FB E2` link-ready, `FB E0` heartbeat, command codes `05`/`09`, amps in 1/100 A, checksum, SLIP-style `C0`/`DB` escaping) were reverse-engineered by the community and follow the implementation in [TWCManager](https://github.com/ngardiner/TWCManager) (`TWCMaster.py`, `TWCSlave.py`, `Interface/RS485.py`), which in turn builds on the original TWCManager by cdragon/jkittenberg. Use at your own risk: wrong commands can put the charger or car in an error state.

## Architecture: JSON-Based Profile System

The plugin uses **JSON profiles** as the master source of truth.

### Inverter Profile Structure

Each inverter profile is defined in `/profiles/*.json` with complete register mappings and encoding rules.

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

### Charger Profile Structure

Each EV charger profile is defined in `/chargerProfiles/*.json`. Chargers have no schedule register, so a profile only describes how to **set the current limit** (and how to detect the charger). The schedule itself comes from SolarCharge.

**Modbus TCP example** (`alfen-eve.json`):

```json
{
  "name": "Alfen_Eve",
  "manufacturer": "Alfen",
  "model": "Eve Single S-line / Pro",
  "connectionType": "TCP",
  "connection": { "defaultTcpPort": 502, "modbusSlaveId": 1 },
  "control": {
    "currentLimitRegister": 1210,
    "dataType": "float32",
    "registerCount": 2,
    "scalingFactor": 1.0,
    "writeFunction": "writeMultipleRegisters"
  },
  "encoding": { "endianness": "BigEndian" },
  "detection": { "type": "modbus", "probeRegister": 1210, "registerCount": 2 }
}
```

**HTTP example**: see `go-e-gemini.json`. **Serial example**: see `tesla-twc-rs485.json`.

| Field | Description |
|-------|-------------|
| `connectionType` | `TCP` (Modbus TCP), `HTTP` or `SERIAL` |
| `connection.defaultTcpPort` / `defaultHttpPort` | Port used when `chargerPort` is not set |
| `connection.modbusSlaveId` | Modbus unit ID (Modbus chargers) |
| `control.currentLimitRegister` | Modbus register holding the current limit in amps (decimal; ABB `0x4100` = `16640`) |
| `control.dataType` | `uint16`, `float32` (occupies two registers) or `int` (HTTP) |
| `control.scalingFactor` | `rawValue = amps / scalingFactor` (e.g. `0.1` sends 16 A as `160`) |
| `control.writeFunction` | `writeSingleRegister` (default) or `writeMultipleRegisters` |
| `control.setEndpoint`, `setMethod`, `setBody` | HTTP request that sets the current. `{value}` is replaced by the raw value; method defaults to `GET` |
| `control.pauseEndpoint`, `pauseMethod` | HTTP request used for 0 A (for chargers that cannot be set to 0 A). Modbus chargers simply get 0 |
| `encoding.endianness` | Byte order, `BigEndian` for all supported Modbus chargers |
| `detection` | Read-only probe used by `chargerProfile: "auto"`, see below |

### Charger Auto-Detection

With `chargerProfile` set to `"auto"` (default) the plugin probes `chargerIpAddress` (optionally `host:port`) at startup, using each profile's `detection` block:

- `"type": "modbus"`: reads `probeRegister` (`registerCount` registers) over Modbus TCP. A successful read counts as a match.
- `"type": "http"`: GETs `probePath` and matches when the JSON response contains one of `probeKey` / `probeKeys` (or any valid JSON if none is given).

Exactly one match selects the profile. If the host is unreachable or nothing matches, detection is retried every 5 minutes. If several profiles match (Modbus register probes can overlap between vendors), the plugin logs a warning and you should select the profile manually with `chargerProfile`.

### How Charging Is Controlled

Every 5 minutes the plugin fetches `GET /chargersettings` (`chargerId`, `serialNum`) and gets `from`, `to`, `amps` and `voltage`:

- Inside the `from`-`to` hour window (wrapping past midnight is supported) it sends `min(amps, maxAmps)` amps (`maxAmps` comes from the SolarCharge app, 16 A if not provided).
- Outside the window, with `from`/`to` both `0`, or `amps` of `0`, it sends 0 A (or the profile's pause request).
- If the SolarCharge API is unreachable the charger keeps its last state.
- The active `profileName` is reported back with `POST /chargersettings` whenever it differs from what the backend has stored.
- The HomeKit "EV Charging" switch can override the schedule (see Accessory 3).

### Modbus Registers Explained

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

### Inverter Clock Sync

Charge/sell windows are compared against the inverter's own clock, which has no DST awareness. If a profile has an optional `clock` block, the plugin checks the inverter clock at startup and every 15 minutes and sets it to the host's local time when it drifts by more than 60 seconds (e.g. after a daylight-saving change).

```json
"clock": { "register": 62, "layout": "PackedBytes" }
```

`layout` is `SixRegisters` (year, month, day, hour, minute, second in consecutive registers) or `PackedBytes` (year|month, day|hour, minute|second in 3 registers). Currently configured for Growatt SPH, Deye/Sunsynk and GoodWe ET; profiles without a `clock` block are skipped.

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

See Development section

Plugin will auto-detect the new profile by matching `manufacturer` field. Check logs for confirmation.

## Adding a New EV Charger

1. Create `/chargerProfiles/manufacturer-model.json` using one of the examples in Charger Profile Structure. Give it a unique `name`.
2. **Modbus chargers:** find the writable current-limit (max current / charging current) register in the vendor's Modbus document. Note the data type, scaling, whether the value spans two registers, and whether the vendor lists addresses in hex (convert to decimal).
3. **HTTP chargers:** identify the request that sets the current and, if the charger cannot be set to 0 A, the request that pauses charging.
4. Add a `detection` block (a read-only register or URL that only this charger answers) so `auto` can find it.
5. Add the `name` to the `chargerProfile` enum in `config.schema.json`, rebuild and restart Homebridge.

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

EV chargers use their own settings: `chargerIpAddress` (optionally `host:port`) and `chargerPort`, with the default port taken from the charger profile (`defaultTcpPort` / `defaultHttpPort`). Each Modbus write opens a short-lived TCP connection that is closed again afterwards.

## Troubleshooting

**Profile Not Detected:**

- Check `manufacturer` in config matches JSON profile exactly (case-sensitive)
- Verify `/profiles/*.json` or `/chargerProfiles/*.json` files exist and parse correctly

**Modbus Connection Failed:**
- Verify `port` (serial device or IP:port) is correct
- Check baud rate matches inverter (usually 9600)
- Test with `modbus-serial` CLI tool

**EV Charger Not Detected / Not Charging:**
- `chargerId` and `chargerIpAddress` must both be set; otherwise EV charging is not started
- If auto-detection reports no match or an ambiguous match, select `chargerProfile` manually
- Check the charger is reachable on the port from its profile (Modbus TCP 502, go-e 80) and that Modbus TCP / the HTTP API is enabled on the charger
- Set `logLevel` to `debug` and look for `EV charger` log lines; `⚡ EV charger current limit set to N A` confirms writes
- ABB Terra AC: if the current is 10x too high or low, adjust `scalingFactor` (0.1 vs 0.01 depends on firmware)

**Registers Reading Zero:**
- Confirm register addresses from inverter documentation
- Check Modbus slave ID (usually 1)
- Try reading with a Modbus scanner app

## Development

```bash
# On your computer, install dependencies for this plugin
npm install

# On your computer, compile TypeScript
npm run build

# On your Raspberry pi, setup a symlink from HB to your home folder
ssh USERID@192.168.x.y
sudo ln -s ~/homebridge-inverter-solarcharge /var/lib/homebridge/node_modules/homebridge-inverter-solarcharge
chmod -R 755 ~/homebridge-growatt-solarcharge

# Check the HB process has permission to home directory
sudo -u homebridge cat /var/lib/homebridge/node_modules/homebridge-growatt-solarcharge/package.json

# On your computer, initate copying of changes 
rsync -avz --delete /Users/USERID/work/homebridge-inverter-solarcharge/ USERID@192.168.x.y:~/homebridge-inverter-solarcharge/

# Restart HB
sudo systemctl restart homebridge
```

## File Structure

```
src/
  platform.ts              # Main Homebridge platform plugin
  inverter-profile.ts      # Abstract profile interface
  profile-loader.ts        # JSON profile loader & factory
  charger-profile.ts       # EV charger profile types & loader
  charger-controller.ts    # EV charger scheduler/writer (Modbus TCP, HTTP, serial)
  twc-master.ts            # Tesla Wall Connector Gen 2 RS-485 load-share master
  charger-detect.ts        # EV charger auto-detection
  solarcharge.ts           # SolarCharge cloud API client
  settings.ts              # Constants

chargerProfiles/           # JSON EV charger profiles
  wallbox-pulsar.json
  alfen-eve.json
  abb-terra-ac.json
  go-e-gemini.json
  tesla-twc-rs485.json

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
  <tr><td>Huawei<br>(SUN2000-3K to SUN2000-20K, residential &amp; commercial)</td><td>huawei_sun2000.json</td><td>RTU &amp; TCP</td><td>1 - 3</td><td>Yes</td><td>9600 baud / Port 502</td><td>Official Huawei SUN2000 Modbus documentation at <a href="https://support.huawei.com/enterprise/it/doc/EDOC1100480297">Huawei Support Portal</a>. Supports residential (3K-10K) and commercial (10K-20K) models with optional battery storage.</td></tr>
</table>

Add more by creating new JSON profiles.

## Supported EV Chargers and Documentation Links

EV chargers have no schedule register, so the plugin acts as the scheduler. Every 5 minutes it fetches the charger settings (`from`, `to`, `amps`, `voltage`) from the SolarCharge API (`GET /chargersettings`) and sends the charger either `amps` (capped by `maxAmps` from the SolarCharge app, default 16 A) inside the `from`-`to` hour window (wrap past midnight supported), or 0 A / pause outside it. If the SolarCharge API is unreachable the charger keeps its last state.

<table class="NRefec">
  <tr><th>Supports</th><th>JSON Profile File</th><th>Connection</th><th>Current Control</th><th>Default Port</th><th>Primary Source Documentation</th></tr>
  <tr><td>Wallbox<br>(Pulsar Plus / Max)</td><td>wallbox-pulsar.json</td><td>Modbus TCP</td><td>Register 512, <code>uint16</code>, whole amps</td><td>502</td><td><a href="https://support.wallbox.com/wp-content/uploads/ht_kb/2024/09/EN_EMS_Installation-Guide.pdf">Wallbox EMS Installation Guide (PDF)</a></td></tr>
  <tr><td>Alfen<br>(Eve Single S-line / Pro)</td><td>alfen-eve.json</td><td>Modbus TCP</td><td>Register 1210-1211, <code>float32</code>, written with writeMultipleRegisters</td><td>502</td><td><a href="https://github.com/tabnul/alfen-eve-modbus-ha">alfen-eve-modbus-ha (Modbus register map)</a></td></tr>
  <tr><td>ABB<br>(Terra AC)</td><td>abb-terra-ac.json</td><td>Modbus TCP (RTU optional)</td><td>Register 16640 (<code>0x4100</code>), <code>uint16</code>, scale 0.1 (0.01 on some firmware)</td><td>502</td><td><a href="https://library.e.abb.com/public/982c2befa2734d259e66d76fa4a7ba77/ABB_Terra_AC_Charger_ModbusCommunication_v1.11.pdf">ABB Terra AC Modbus Communication (PDF)</a></td></tr>
  <tr><td>Keba<br>(KEcontact X-Series, P30, P30 c-series)</td><td>keba-xseries.json</td><td>Modbus TCP (RTU optional)</td><td>Register 100 (<code>0x64</code>), <code>uint16</code>, scale 0.1</td><td>502</td><td><a href="https://modbusconnect.com/configurations/keba-kecontact-p30">Keba KEcontact Modbus Configuration</a></td></tr>
  <tr><td>go-e<br>(Gemini / HOME)</td><td>go-e-gemini.json</td><td>HTTP API v2</td><td><code>GET /api/set?frc=0&amp;amp=N</code>, pause with <code>frc=1</code></td><td>80</td><td><a href="https://github.com/goecharger/go-eCharger-API-v2">go-eCharger API v2 (GitHub)</a></td></tr>
  <tr><td>Tesla<br>(Wall Connector Gen 2, direct RS-485)</td><td>tesla-twc-rs485.json</td><td>Serial (TWC load-share master)</td><td>Heartbeat with offered amps; 0 A to stop</td><td>9600 baud (<code>chargerSerialPath</code>)</td><td><a href="https://github.com/ngardiner/TWCManager">TWCManager (protocol reference)</a></td></tr>
</table>

All Modbus chargers use big-endian encoding. Verify register numbers and scaling against your charger's firmware documentation. Add more by creating a JSON profile in `chargerProfiles/`; HTTP chargers can set `setMethod`, `setBody` and `pauseEndpoint`, and a `detection` block enables auto-detection.

If you find something not correct in a JSON file make a pull request and / or report an issue.

## License

This project is licensed under the ISC License.
