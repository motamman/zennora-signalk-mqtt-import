const fs = require('fs-extra');
const path = require('path');
const mqtt = require('mqtt');

module.exports = function(app) {
  let plugin = {};
  let mqttClient = null;
  let importRules = []; // Store import rules
  let lastReceivedMessages = new Map(); // Track received messages for deduplication
  let selfVesselUrn = null; // Store the self vessel's URN

  plugin.id = 'zennora-signalk-mqtt-import';
  plugin.name = 'Zennora MQTT Import Manager';
  plugin.description = 'Selectively import SignalK data from MQTT with webapp management interface';

  plugin.start = function(options) {
    app.debug('Starting Zennora MQTT Import Manager plugin');
    
    const config = {
      mqttBroker: options?.mqttBroker || 'mqtt://localhost:1883',
      mqttClientId: options?.mqttClientId || 'signalk-mqtt-import',
      mqttUsername: options?.mqttUsername || '',
      mqttPassword: options?.mqttPassword || '',
      topicPrefix: options?.topicPrefix || '',
      enabled: options?.enabled || true,
      importRules: options?.importRules || getDefaultImportRules()
    };

    plugin.config = config;
    importRules = config.importRules;

    // Get self vessel URN for proper context mapping
    try {
      selfVesselUrn = app.selfId || app.getSelfPath('uuid');
      app.debug(`Self vessel URN: ${selfVesselUrn}`);
    } catch (error) {
      app.debug(`Warning: Could not get self vessel URN: ${error.message}`);
    }

    if (!config.enabled) {
      app.debug('MQTT Import plugin disabled');
      return;
    }

    // Initialize MQTT client
    initializeMQTTClient(config);

    app.debug('Zennora MQTT Import Manager plugin started');
  };

  plugin.stop = function() {
    app.debug('Stopping Zennora MQTT Import Manager plugin');
    
    // Disconnect MQTT client
    if (mqttClient) {
      mqttClient.end();
      mqttClient = null;
    }

    lastReceivedMessages.clear();
    app.debug('Zennora MQTT Import Manager plugin stopped');
  };

  // Initialize MQTT client
  function initializeMQTTClient(config) {
    try {
      const mqttOptions = {
        clientId: config.mqttClientId,
        clean: true,
        reconnectPeriod: 5000,
        keepalive: 60
      };

      if (config.mqttUsername && config.mqttPassword) {
        mqttOptions.username = config.mqttUsername;
        mqttOptions.password = config.mqttPassword;
      }

      mqttClient = mqtt.connect(config.mqttBroker, mqttOptions);

      mqttClient.on('connect', () => {
        app.debug(`✅ Connected to MQTT broker: ${config.mqttBroker}`);
        subscribeToMQTTTopics();
      });

      mqttClient.on('error', (error) => {
        app.debug(`❌ MQTT client error: ${error.message}`);
      });

      mqttClient.on('close', () => {
        app.debug('🔌 MQTT client disconnected');
      });

      mqttClient.on('reconnect', () => {
        app.debug('🔄 MQTT client reconnecting...');
      });

      mqttClient.on('message', (topic, message) => {
        handleMQTTMessage(topic, message);
      });

    } catch (error) {
      app.debug(`Failed to initialize MQTT client: ${error.message}`);
    }
  }

  // Subscribe to MQTT topics based on import rules
  function subscribeToMQTTTopics() {
    if (!mqttClient || !mqttClient.connected) {
      return;
    }

    // Get all unique topics from enabled import rules
    const topics = new Set();
    importRules.filter(rule => rule.enabled).forEach(rule => {
      let topic = rule.mqttTopic;
      
      // Add topic prefix if configured
      if (plugin.config.topicPrefix) {
        topic = `${plugin.config.topicPrefix}/${topic}`;
      }
      
      topics.add(topic);
    });

    // Subscribe to all topics
    topics.forEach(topic => {
      mqttClient.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          app.debug(`❌ Failed to subscribe to ${topic}: ${err.message}`);
        } else {
          app.debug(`✅ Subscribed to MQTT topic: ${topic}`);
        }
      });
    });

    app.debug(`Subscribed to ${topics.size} MQTT topics`);
  }

  // Handle incoming MQTT messages
  function handleMQTTMessage(topic, message) {
    try {
      const messageStr = message.toString();
      
      // Find matching import rule
      const rule = importRules.find(r => {
        if (!r.enabled) return false;
        
        let expectedTopic = r.mqttTopic;
        if (plugin.config.topicPrefix) {
          expectedTopic = `${plugin.config.topicPrefix}/${expectedTopic}`;
        }
        
        // Support wildcard matching
        if (expectedTopic.includes('#')) {
          const prefix = expectedTopic.replace('#', '');
          return topic.startsWith(prefix);
        } else if (expectedTopic.includes('+')) {
          const regex = new RegExp(expectedTopic.replace(/\+/g, '[^/]+'));
          return regex.test(topic);
        } else {
          return topic === expectedTopic;
        }
      });

      if (!rule) {
        app.debug(`No import rule found for topic: ${topic}`);
        return;
      }

      // Check for duplicate messages if enabled
      if (rule.ignoreDuplicates) {
        const messageKey = `${topic}:${messageStr}`;
        if (lastReceivedMessages.has(messageKey)) {
          return; // Skip duplicate message
        }
        lastReceivedMessages.set(messageKey, Date.now());
        
        // Clean up old messages (keep last 1000 messages)
        if (lastReceivedMessages.size > 1000) {
          const entries = Array.from(lastReceivedMessages.entries());
          const oldest = entries.slice(0, 500);
          oldest.forEach(([key]) => lastReceivedMessages.delete(key));
        }
      }

      // Parse the message based on expected format
      let signalKData;
      if (rule.payloadFormat === 'value-only') {
        signalKData = parseValueOnlyMessage(messageStr, rule, topic);
      } else {
        signalKData = parseFullSignalKMessage(messageStr, rule, topic);
      }

      if (signalKData) {
        sendToSignalK(signalKData, rule);
      }

    } catch (error) {
      app.debug(`Error handling MQTT message from ${topic}: ${error.message}`);
    }
  }

  // Parse value-only message format
  function parseValueOnlyMessage(messageStr, rule, topic) {
    try {
      let value;
      
      // Try to parse as JSON first
      try {
        value = JSON.parse(messageStr);
      } catch {
        // If not JSON, treat as string/number
        value = isNaN(messageStr) ? messageStr : Number(messageStr);
      }

      // Extract context and path from topic or rule configuration
      const context = rule.signalKContext || extractContextFromTopic(topic, rule);
      const path = rule.signalKPath || extractPathFromTopic(topic, rule);

      return {
        context: context,
        updates: [{
          source: {
            label: rule.sourceLabel || 'mqtt-import',
            type: 'mqtt'
          },
          timestamp: new Date().toISOString(),
          values: [{
            path: path,
            value: value
          }]
        }]
      };
    } catch (error) {
      app.debug(`Error parsing value-only message: ${error.message}`);
      return null;
    }
  }

  // Parse full SignalK message format
  function parseFullSignalKMessage(messageStr, rule, topic) {
    try {
      const parsed = JSON.parse(messageStr);
      
      // If it's already a proper SignalK delta, use it directly
      if (parsed.context && parsed.updates) {
        return parsed;
      }
      
      // Otherwise, try to construct a SignalK delta
      const context = rule.signalKContext || parsed.context || extractContextFromTopic(topic, rule);
      const path = rule.signalKPath || extractPathFromTopic(topic, rule);
      
      return {
        context: context,
        updates: [{
          source: {
            label: rule.sourceLabel || 'mqtt-import',
            type: 'mqtt'
          },
          timestamp: new Date().toISOString(),
          values: [{
            path: path,
            value: parsed
          }]
        }]
      };
    } catch (error) {
      app.debug(`Error parsing full SignalK message: ${error.message}`);
      return null;
    }
  }

  // Helper function to convert URN format for MQTT topics
  function urnToMqttFormat(urn) {
    if (!urn) return null;
    // Convert urn:mrn:imo:mmsi:368396230 to urn_mrn_imo_mmsi_368396230
    return urn.replace(/:/g, '_');
  }

  // Helper function to convert MQTT format back to URN
  function mqttFormatToUrn(mqttFormat) {
    if (!mqttFormat) return null;
    // Convert urn_mrn_imo_mmsi_368396230 to urn:mrn:imo:mmsi:368396230
    return mqttFormat.replace(/_/g, ':');
  }

  // Extract SignalK context from MQTT topic
  function extractContextFromTopic(topic, rule) {
    // Remove prefix if present
    let cleanTopic = topic;
    if (plugin.config.topicPrefix) {
      cleanTopic = cleanTopic.replace(`${plugin.config.topicPrefix}/`, '');
    }

    const parts = cleanTopic.split('/');
    
    if (parts[0] === 'vessels' && parts.length > 2) {
      const vesselId = parts[1];
      
      // Check if this is the self vessel's URN in MQTT format
      if (selfVesselUrn && urnToMqttFormat(selfVesselUrn) === vesselId) {
        return 'vessels.self';
      }
      
      // Convert MQTT format back to proper URN format
      if (vesselId.startsWith('urn_')) {
        return `vessels.${mqttFormatToUrn(vesselId)}`;
      }
      
      // Handle other formats
      return `vessels.${vesselId}`;
    }
    
    // Fallback to vessels.self
    return 'vessels.self';
  }

  // Extract SignalK path from MQTT topic
  function extractPathFromTopic(topic, rule) {
    // Remove prefix if present
    let cleanTopic = topic;
    if (plugin.config.topicPrefix) {
      cleanTopic = cleanTopic.replace(`${plugin.config.topicPrefix}/`, '');
    }

    // Default path extraction: convert topic to SignalK path
    // e.g., "vessels/self/navigation/position" -> "navigation.position"
    const parts = cleanTopic.split('/');
    
    // Remove context parts (vessels/self or vessels/urn_...)
    if (parts[0] === 'vessels' && parts.length > 2) {
      return parts.slice(2).join('.');
    }
    
    // Fallback: use the entire topic as path
    return cleanTopic.replace(/\//g, '.');
  }

  // Send data to SignalK
  function sendToSignalK(signalKData, rule) {
    try {
      // Validate the data structure
      if (!signalKData.context || !signalKData.updates || !Array.isArray(signalKData.updates)) {
        app.debug('Invalid SignalK data structure');
        return;
      }

      // Apply any transformations if configured
      if (rule.transformValue && typeof rule.transformValue === 'function') {
        signalKData.updates.forEach(update => {
          if (update.values) {
            update.values.forEach(valueUpdate => {
              valueUpdate.value = rule.transformValue(valueUpdate.value);
            });
          }
        });
      }

      // Send to SignalK
      app.handleMessage(plugin.id, signalKData);
      
      app.debug(`✅ Imported to SignalK: ${signalKData.context} - ${signalKData.updates.length} updates`);
    } catch (error) {
      app.debug(`Error sending to SignalK: ${error.message}`);
    }
  }

  // Get default import rules
  function getDefaultImportRules() {
    return [
      {
        id: 'self-navigation',
        name: 'Self Navigation Data',
        mqttTopic: 'vessels/urn_mrn_imo_mmsi_+/navigation/+',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: 'mqtt-import',
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true
      },
      {
        id: 'self-electrical',
        name: 'Self Electrical Data',
        mqttTopic: 'vessels/urn_mrn_imo_mmsi_+/electrical/+',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: 'mqtt-import',
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true
      },
      {
        id: 'self-propulsion',
        name: 'Self Propulsion Data',
        mqttTopic: 'vessels/urn_mrn_imo_mmsi_+/propulsion/+',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: 'mqtt-import',
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true
      },
      {
        id: 'self-environment',
        name: 'Self Environment Data',
        mqttTopic: 'vessels/urn_mrn_imo_mmsi_+/environment/+',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: 'mqtt-import',
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true
      },
      {
        id: 'all-vessels-ais',
        name: 'AIS Vessels (All)',
        mqttTopic: 'vessels/urn_mrn_imo_mmsi_+/+',
        signalKContext: '', // Will be extracted from topic
        signalKPath: '', // Will be extracted from topic
        sourceLabel: 'ais-import',
        enabled: false, // Disabled by default to avoid too much AIS data
        payloadFormat: 'full',
        ignoreDuplicates: true
      }
    ];
  }

  // Update MQTT subscriptions when rules change
  function updateMQTTSubscriptions() {
    if (mqttClient && mqttClient.connected) {
      // Unsubscribe from all topics first
      mqttClient.unsubscribe('#');
      
      // Re-subscribe based on current rules
      subscribeToMQTTTopics();
    }
  }

  // Plugin webapp routes
  plugin.registerWithRouter = function(router) {
    const express = require('express');
    
    app.debug('registerWithRouter called for MQTT import manager');
    
    // API Routes
    
    // Get current import rules
    router.get('/api/rules', (req, res) => {
      res.json({
        success: true,
        rules: importRules,
        mqttConnected: mqttClient ? mqttClient.connected : false
      });
    });

    // Update import rules
    router.post('/api/rules', (req, res) => {
      try {
        const newRules = req.body.rules;
        if (!Array.isArray(newRules)) {
          return res.status(400).json({ success: false, error: 'Rules must be an array' });
        }

        importRules = newRules;
        plugin.config.importRules = newRules;
        
        // Save configuration to persistent storage
        app.savePluginOptions(plugin.config, (err) => {
          if (err) {
            app.debug('Error saving plugin configuration:', err);
            return res.status(500).json({ success: false, error: 'Failed to save configuration' });
          }
          
          // Update MQTT subscriptions with new rules
          updateMQTTSubscriptions();
          
          res.json({ success: true, message: 'Import rules updated and saved' });
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get MQTT connection status
    router.get('/api/mqtt-status', (req, res) => {
      res.json({
        success: true,
        connected: mqttClient ? mqttClient.connected : false,
        broker: plugin.config.mqttBroker,
        clientId: plugin.config.mqttClientId
      });
    });

    // Test MQTT connection
    router.post('/api/test-mqtt', (req, res) => {
      try {
        if (!mqttClient || !mqttClient.connected) {
          return res.status(503).json({ success: false, error: 'MQTT not connected' });
        }

        res.json({ success: true, message: 'MQTT connection is active and receiving messages' });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get import statistics
    router.get('/api/stats', (req, res) => {
      try {
        const stats = {
          totalRules: importRules.length,
          enabledRules: importRules.filter(r => r.enabled).length,
          messagesReceived: lastReceivedMessages.size,
          mqttConnected: mqttClient ? mqttClient.connected : false
        };
        
        res.json({ success: true, stats: stats });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Serve static files
    const publicPath = path.join(__dirname, 'public');
    if (fs.existsSync(publicPath)) {
      router.use(express.static(publicPath));
      app.debug('Static files served from:', publicPath);
    }

    app.debug('MQTT Import Manager web routes registered');
  };

  // Configuration schema
  plugin.schema = {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable MQTT Import',
        description: 'Enable/disable the MQTT import functionality',
        default: true
      },
      mqttBroker: {
        type: 'string',
        title: 'MQTT Broker URL',
        description: 'MQTT broker connection string (e.g., mqtt://localhost:1883)',
        default: 'mqtt://localhost:1883'
      },
      mqttClientId: {
        type: 'string',
        title: 'MQTT Client ID',
        description: 'Unique client identifier for MQTT connection',
        default: 'signalk-mqtt-import'
      },
      mqttUsername: {
        type: 'string',
        title: 'MQTT Username',
        description: 'Username for MQTT authentication (optional)',
        default: ''
      },
      mqttPassword: {
        type: 'string',
        title: 'MQTT Password',
        description: 'Password for MQTT authentication (optional)',
        default: ''
      },
      topicPrefix: {
        type: 'string',
        title: 'Topic Prefix',
        description: 'Optional prefix for all MQTT topics',
        default: ''
      },
      importRules: {
        type: 'array',
        title: 'Import Rules',
        description: 'Rules defining which MQTT data to import into SignalK',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              title: 'Rule ID'
            },
            name: {
              type: 'string',
              title: 'Rule Name'
            },
            mqttTopic: {
              type: 'string',
              title: 'MQTT Topic',
              description: 'MQTT topic to subscribe to (supports + and # wildcards)'
            },
            signalKContext: {
              type: 'string',
              title: 'SignalK Context',
              description: 'vessels.self, vessels.urn:mrn:imo:mmsi:123456, etc. (leave empty to auto-detect from topic)',
              default: ''
            },
            signalKPath: {
              type: 'string',
              title: 'SignalK Path',
              description: 'navigation.position, electrical.batteries.house.voltage, etc. (leave empty to extract from topic)',
              default: ''
            },
            sourceLabel: {
              type: 'string',
              title: 'Source Label',
              description: 'Label to use for the data source in SignalK',
              default: 'mqtt-import'
            },
            enabled: {
              type: 'boolean',
              title: 'Enabled',
              default: true
            },
            payloadFormat: {
              type: 'string',
              title: 'Payload Format',
              description: 'Expected format of the MQTT payload',
              enum: ['full', 'value-only'],
              enumNames: ['Full SignalK Structure', 'Value Only'],
              default: 'full'
            },
            ignoreDuplicates: {
              type: 'boolean',
              title: 'Ignore Duplicates',
              description: 'Skip duplicate messages (reduces SignalK updates)',
              default: true
            }
          }
        }
      }
    }
  };

  return plugin;
};