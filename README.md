# Zennora SignalK MQTT Import Manager

**Version 0.5.0-alpha.1**

A comprehensive SignalK plugin that provides a web-based interface for managing selective import of SignalK data from MQTT brokers. This plugin serves as the inverse of the MQTT Export plugin, allowing you to import data from MQTT topics back into SignalK.

## Features

- **🌐 Web Interface**: Easy-to-use webapp for managing import rules
- **📋 Rule Management**: Create, edit, enable/disable import rules
- **🎯 Selective Import**: Import only the data you need with flexible topic filtering
- **📊 Real-time Status**: Monitor MQTT connection and message statistics
- **🔄 Dynamic Updates**: Changes take effect immediately without restart
- **💾 Persistent Configuration**: Rules are saved to SignalK configuration and survive restarts
- **🏷️ Flexible Topic Mapping**: Support for MQTT topic wildcards and auto-extraction of SignalK paths
- **📦 Multiple Formats**: Support for full SignalK structure or value-only payloads
- **🔍 Duplicate Filtering**: Optionally ignore duplicate messages to reduce SignalK updates
- **🏷️ Source Labeling**: Customize source labels for imported data

## Installation

### Method: NPM Installation from GitHub repo
```bash
cd ~/.signalk/node_modules
npm install motamman/zennora-signalk-mqtt-import
sudo systemctl restart signalk
```

## Configuration

Navigate to **SignalK Admin → Server → Plugin Config → Zennora MQTT Import Manager**

### Basic Settings
- **Enable MQTT Import**: Master enable/disable switch
- **MQTT Broker URL**: Connection string (e.g., `mqtt://localhost:1883`)
- **Client ID**: Unique identifier for the MQTT connection
- **Username/Password**: Optional authentication credentials
- **Topic Prefix**: Optional prefix for all MQTT topics

## Web Interface

Access the management interface at:
- **https://your-signalk-server:3443/plugins/zennora-signalk-mqtt-import/**

### Interface Features

#### Status Dashboard
- **MQTT Connection**: Real-time connection status
- **Active Rules**: Number of enabled import rules
- **Messages Received**: Count of messages processed
- **Total Rules**: Total number of configured rules

#### Rule Management
- **Add Rule**: Create new import rules
- **Edit Rule**: Modify existing rules
- **Enable/Disable**: Toggle rules on/off
- **Delete Rule**: Remove unwanted rules
- **Save Changes**: Apply changes to active configuration

#### Rule Configuration Options
- **Name**: Descriptive name for the rule
- **MQTT Topic**: Topic to subscribe to (supports + and # wildcards)
- **SignalK Context**: Target SignalK context (optional - can be extracted from topic)
- **SignalK Path**: Target SignalK path (optional - can be extracted from topic)
- **Source Label**: Label to use for the data source in SignalK
- **Payload Format**: Expected format of MQTT messages (full SignalK or value-only)
- **Ignore Duplicates**: Skip duplicate messages to reduce SignalK updates

## MQTT Topic Mapping

### Topic Wildcards
- **+**: Single-level wildcard (e.g., `vessels/+/navigation/position`)
- **#**: Multi-level wildcard (e.g., `vessels/self/navigation/#`)

### Automatic Path Extraction
When SignalK Context or Path are left empty, they are automatically extracted from the MQTT topic:

Examples:
- Topic: `vessels/urn_mrn_imo_mmsi_368396230/navigation/position` → Context: `vessels.self` (if 368396230 is self vessel), Path: `navigation.position`
- Topic: `vessels/urn_mrn_imo_mmsi_123456789/electrical/batteries/house/voltage` → Context: `vessels.urn:mrn:imo:mmsi:123456789`, Path: `electrical.batteries.house.voltage`

### Smart Self Vessel Detection
The plugin automatically detects when MQTT topics reference the self vessel:

- **Self Vessel URN**: Plugin retrieves the self vessel's URN from SignalK server at startup
- **Auto-mapping**: Topics like `vessels/urn_mrn_imo_mmsi_368396230/...` are automatically mapped to `vessels.self` context if the MMSI matches the self vessel
- **External Vessels**: Other vessel URNs are properly converted to standard SignalK format (`vessels.urn:mrn:imo:mmsi:123456789`)

### Custom Topic Prefix
If you configure a topic prefix in the plugin settings, it will be automatically added to all subscribed topics and removed when processing messages.

## Self Vessel Detection

The plugin automatically handles the mapping between MQTT topics using actual vessel URNs and SignalK's internal `vessels.self` context.

### How It Works

1. **URN Detection**: At startup, the plugin retrieves the self vessel's URN from the SignalK server
2. **MQTT Format Conversion**: Converts between MQTT format (`urn_mrn_imo_mmsi_368396230`) and SignalK format (`urn:mrn:imo:mmsi:368396230`)
3. **Smart Context Mapping**: 
   - If topic URN matches self vessel → context becomes `vessels.self`
   - If topic URN is different → context becomes `vessels.urn:mrn:imo:mmsi:123456789`

### Example Scenarios

**Self Vessel Data:**
- MQTT Topic: `vessels/urn_mrn_imo_mmsi_368396230/navigation/position`
- Self Vessel MMSI: `368396230`
- Result: Context = `vessels.self`, Path = `navigation.position`

**External Vessel Data:**
- MQTT Topic: `vessels/urn_mrn_imo_mmsi_123456789/navigation/position`
- Self Vessel MMSI: `368396230`
- Result: Context = `vessels.urn:mrn:imo:mmsi:123456789`, Path = `navigation.position`

### Benefits

- **Automatic**: No manual configuration required
- **Flexible**: Handles both self and external vessel data
- **Standards Compliant**: Proper SignalK context mapping
- **AIS Integration**: Seamless handling of AIS data from multiple vessels

## Payload Formats

### Full SignalK Structure
Expected format matches the output of the MQTT Export plugin:
```json
{
  "context": "vessels.self",
  "updates": [{
    "source": {
      "label": "GPS",
      "type": "NMEA2000"
    },
    "timestamp": "2025-07-15T10:30:00.000Z",
    "values": [{
      "path": "navigation.position",
      "value": {
        "latitude": 37.7749,
        "longitude": -122.4194,
        "altitude": 0
      }
    }]
  }]
}
```

### Value Only
Simple value format:
```json
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "altitude": 0
}
```

Or simple values:
```
123.45
```

## Default Import Rules

The plugin comes with practical rules for common marine data import:

1. **Self Navigation Data** - `vessels/urn_mrn_imo_mmsi_+/navigation/+` (auto-detects self vessel)
2. **Self Electrical Data** - `vessels/urn_mrn_imo_mmsi_+/electrical/+` (auto-detects self vessel)
3. **Self Propulsion Data** - `vessels/urn_mrn_imo_mmsi_+/propulsion/+` (auto-detects self vessel)
4. **Self Environment Data** - `vessels/urn_mrn_imo_mmsi_+/environment/+` (auto-detects self vessel)
5. **AIS Vessels (All)** - `vessels/urn_mrn_imo_mmsi_+/+` (disabled by default)

## Integration with Export Plugin

This plugin is designed to work seamlessly with the Zennora MQTT Export plugin:

1. **Export Plugin**: Publishes SignalK data to MQTT topics
2. **Import Plugin**: Subscribes to MQTT topics and imports data back to SignalK

This allows you to:
- Bridge SignalK instances across networks
- Share data between different vessels
- Implement data processing pipelines
- Create backup/restore mechanisms

## Usage Examples

### Example 1: Import Self Vessel Navigation Data
```
Rule Name: Self Navigation Import
MQTT Topic: vessels/urn_mrn_imo_mmsi_+/navigation/+
SignalK Context: (auto-detected as vessels.self if MMSI matches)
SignalK Path: (auto-extracted)
Source Label: mqtt-import
Payload Format: full
```

### Example 2: Import AIS Data from Other Vessels
```
Rule Name: AIS Import
MQTT Topic: vessels/urn_mrn_imo_mmsi_+/+
SignalK Context: (auto-extracted as vessels.urn:mrn:imo:mmsi:123456789)
SignalK Path: (auto-extracted)
Source Label: ais-mqtt
Payload Format: full
```

### Example 3: Import Simple Values
```
Rule Name: Temperature Sensor
MQTT Topic: sensors/temperature/cabin
SignalK Context: vessels.self
SignalK Path: environment.inside.temperature
Source Label: mqtt-sensor
Payload Format: value-only
```

## Troubleshooting

### Common Issues

1. **MQTT Connection Failed**
   - Check MQTT broker URL and credentials
   - Ensure network connectivity
   - Verify firewall settings

2. **No Data Appearing in SignalK**
   - Check if import rules are enabled
   - Verify MQTT topic patterns match published topics
   - Ensure self vessel MMSI is correctly detected in plugin logs
   - Review SignalK debug logs

3. **Duplicate Data**
   - Enable "Ignore Duplicates" option
   - Check for overlapping import rules

## License

MIT License - See [LICENSE](../LICENSE) file for details.