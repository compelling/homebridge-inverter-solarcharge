---
name: "add-device-support"
description: "Use when adding a new solar inverter or EV charger to the homebridge-inverter-solarcharge plugin. Includes profile creation, testing, and mandatory README updates."
tags: ["devices", "inverters", "chargers", "documentation"]
---

# Add Device Support Workflow

This skill guides you through adding a new solar inverter or EV charger to the plugin, ensuring comprehensive documentation and testing.

## 📋 Pre-Implementation Checklist

- [ ] Identify device manufacturer and model
- [ ] Locate official Modbus documentation or register maps
- [ ] Determine connection type (RTU serial, TCP, HTTP)
- [ ] Identify key telemetry registers
- [ ] Identify control registers (if applicable)
- [ ] Test register accuracy against device documentation

## 🔧 Implementation Steps

### 1. Choose Device Type

**For Solar Inverters:**
- Profile location: `profiles/`
- File naming: `{manufacturer-lowercase}-{model-code}.json`
- Example: `huawei-sun2000.json`, `growatt-sph.json`

**For EV Chargers:**
- Profile location: `chargerProfiles/`
- File naming: `{manufacturer-lowercase}-{model}.json`
- Example: `keba-xseries.json`, `wallbox-pulsar.json`

### 2. Create Profile JSON

#### Inverter Profile Template

```json
{
  "name": "Manufacturer_ModelCode",
  "manufacturer": "Manufacturer Name",
  "model": "Model Description (e.g., Series X-Y-Z)",
  "phases": 1,
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
    "solarPowerRegister": 0,
    "loadPowerRegister": 0,
    "exportPowerRegister": 0,
    "importPowerRegister": 0,
    "batteryChargePowerRegister": 0,
    "batteryDischargePowerRegister": 0,
    "batterySocRegister": 0,
    "u32Registers": [],
    "scalingFactor": 0.1
  },
  "control": {
    "dischargeRateRegister": 0,
    "dischargeStopSocRegister": 0,
    "dischargeStartTimeRegister": 0,
    "dischargeStopTimeRegister": 0,
    "dischargeEnableRegister": 0,
    "chargeRateRegister": 0,
    "chargeStopSocRegister": 0,
    "chargeStartTimeRegister": 0,
    "chargeStopTimeRegister": 0,
    "chargeGridEnableRegister": 0
  },
  "encoding": {
    "timeFormat": "PackedBytes",
    "endianness": "BigEndian"
  },
  "source": "https://official-documentation-url"
}
```

#### Charger Profile Template

```json
{
  "name": "Manufacturer_ModelCode",
  "manufacturer": "Manufacturer Name",
  "model": "Model Description",
  "connectionType": "TCP",
  "connection": {
    "defaultTcpPort": 502,
    "modbusSlaveId": 1,
    "supportsRtu": true
  },
  "control": {
    "currentLimitRegister": 100,
    "dataType": "uint16",
    "scalingFactor": 0.1,
    "writeFunction": "writeSingleRegister"
  },
  "encoding": {
    "endianness": "BigEndian"
  },
  "detection": {
    "type": "modbus",
    "probeRegister": 100
  },
  "source": "https://official-documentation-url"
}
```

### 3. Build and Test

```bash
npm run build
# Verify profile loads correctly with Node.js test script
npm run lint
```

### 4. **CRITICAL: Update README.md**

#### Step 4a: Update Feature List

**Location:** Line 13 (approximate)
**Section:** "EV Charger Multi-Brand Support" or "Solar Inverter Multi-Brand Support"

Add the new device to the comma-separated list:

```markdown
# BEFORE
- **🔄 Solar Inverter Multi-Brand Support**: Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar

# AFTER
- **🔄 Solar Inverter Multi-Brand Support**: Growatt, GoodWe, SolaX, SolarEdge, Fronius, Deye/Sunsynk, Sofar, Huawei
```

#### Step 4b: Update Charger Table (if charger)

**Location:** "## Supported EV Chargers and Documentation Links" section

Add new row to the HTML table with:
- Device name and model variants
- Profile file name
- Connection type(s)
- Current control specifications
- Default port
- Documentation link

Example:
```html
<tr><td>Keba<br>(KEcontact X-Series, P30, P30 c-series)</td><td>keba-xseries.json</td><td>Modbus TCP (RTU optional)</td><td>Register 100 (<code>0x64</code>), <code>uint16</code>, scale 0.1</td><td>502</td><td><a href="https://modbusconnect.com/configurations/keba-kecontact-p30">Keba KEcontact Modbus Configuration</a></td></tr>
```

#### Step 4c: Update Inverter Table (if inverter)

**Location:** "## Supported Inverters and Documentation Links" section

Add new row to the HTML table with:
- Device name and model range
- Profile file name
- Connection type(s)
- Phase count
- Battery support (Yes/No)
- Default port/baudrate
- Documentation reference

Example:
```html
<tr><td>Huawei<br>(SUN2000-3K to SUN2000-20K, residential &amp; commercial)</td><td>huawei_sun2000.json</td><td>RTU &amp; TCP</td><td>1 - 3</td><td>Yes</td><td>9600 baud / Port 502</td><td>Official Huawei SUN2000 Modbus documentation at <a href="https://support.huawei.com/enterprise/it/doc/EDOC1100480297">Huawei Support Portal</a>.</td></tr>
```

## ✅ Post-Implementation Checklist

- [ ] Profile JSON created in correct directory
- [ ] Profile name follows naming convention (CamelCase)
- [ ] All required fields populated with correct register addresses
- [ ] `source` field points to official documentation
- [ ] `npm run build` completes without errors
- [ ] Profile loads correctly (verify with test script)
- [ ] **README feature list updated** ⭐
- [ ] **README device table updated** ⭐
- [ ] Correct connection type documented (TCP/RTU/HTTP)
- [ ] Scaling factors verified against documentation
- [ ] Link to documentation works (test in browser)

## 🚨 Common Mistakes to Avoid

1. **Missing README updates** → Device won't be discoverable by users
2. **Wrong profile name format** → Profile won't load (must be CamelCase)
3. **Incorrect register addresses** → Device communication will fail
4. **Missing source documentation link** → Users can't verify specs
5. **Inconsistent table formatting** → README rendering breaks
6. **Wrong scaling factor** → Telemetry values will be off by 10-100x
7. **Forgetting to rebuild** → Changes won't be reflected in dist/

## 📝 Profile Field Reference

### Connection Types
- **RTU**: Serial Modbus (via `/dev/ttyUSB0` or similar)
- **TCP**: Modbus TCP over network (port 502 standard)
- **HTTP**: REST API (for chargers only)

### Data Types (Chargers)
- `uint16`: 16-bit unsigned integer
- `float32`: 32-bit floating point (requires 2 registers)
- `int`: Generic integer

### Time Formats (Inverters)
- `PackedBytes`: Time stored as byte-packed values (Growatt, Sofar style)
- `RawInteger`: Minutes from midnight as integer (Fronius style)
- `SixRegisters`: Separate registers for Y/M/D/H/M/S (common format)

### Endianness
- `BigEndian`: Most common (MSB first)
- `LittleEndian`: Some Chinese manufacturers

## 📚 Reference Examples

- **Inverter with Battery**: `profiles/huawei-sun2000.json` or `profiles/growatt-sph.json`
- **Inverter without Battery**: `profiles/fronius-primo.json`
- **Charger (Modbus)**: `chargerProfiles/keba-xseries.json` or `chargerProfiles/abb-terra-ac.json`
- **Charger (HTTP)**: `chargerProfiles/go-e-gemini.json`

## 🔗 Useful Commands

```bash
# Build and verify
npm run build

# Lint code
npm run lint

# Test specific profile loads
node --input-type=module -e "
import { ProfileLoader } from './dist/profile-loader.js';
const p = ProfileLoader.getProfile('YourProfileName');
console.log(p ? '✓ Loaded' : '✗ Not found');
"
```

---

**Remember:** README  updates are NOT optional. They ensure users can discover and properly configure the new device support. Always complete Step 4 before considering the task done.
