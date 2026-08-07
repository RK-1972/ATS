const placeholderRegistry = require("./placeholderRegistry");
const { parsePlaceholderToken } = require("./placeholderResolver");

function validateToken(token) {
  const parsed = parsePlaceholderToken(token);

  if (!parsed) {
    return {
      token,
      isValid: false,
      placeholderType: "unknown",
      namespace: null,
      placeholderKey: null,
      reason: "Unknown placeholder format. Use {{Namespace.Key}} or {{TABLE:Collection}}."
    };
  }

  if (parsed.type === "table") {
    const definition = placeholderRegistry.findTablePlaceholder(parsed.collection);

    if (!definition) {
      return {
        token,
        isValid: false,
        placeholderType: "table",
        namespace: "TABLE",
        placeholderKey: parsed.collection,
        reason: `Missing registry entry for table collection: ${parsed.collection}`
      };
    }

    if (definition.status === "Future") {
      return {
        token,
        isValid: false,
        placeholderType: "table",
        namespace: "TABLE",
        placeholderKey: parsed.collection,
        reason: `Table collection ${parsed.collection} is registered for future use only.`
      };
    }

    return {
      token,
      isValid: true,
      placeholderType: "table",
      namespace: "TABLE",
      placeholderKey: definition.collection,
      reason: null
    };
  }

  const definition = placeholderRegistry.findScalarPlaceholder(
    parsed.namespace,
    parsed.key
  );

  if (!definition) {
    return {
      token,
      isValid: false,
      placeholderType: "scalar",
      namespace: parsed.namespace,
      placeholderKey: parsed.key,
      reason: `Missing registry entry for ${parsed.namespace}.${parsed.key}`
    };
  }

  return {
    token,
    isValid: true,
    placeholderType: "scalar",
    namespace: definition.namespace,
    placeholderKey: definition.key,
    reason: null
  };
}

function validateScanResults(scanResults) {
  const messages = [];
  const detected = [];
  const unknownPlaceholders = [];
  const missingRegistryEntries = [];

  scanResults.recognized.forEach((item) => {
    const validation = validateToken(item.token);
    detected.push({
      ...item,
      ...validation
    });

    if (!validation.isValid && validation.placeholderType !== "unknown") {
      missingRegistryEntries.push({
        token: item.token,
        namespace: validation.namespace,
        placeholderKey: validation.placeholderKey,
        reason: validation.reason
      });
      messages.push(validation.reason);
    }
  });

  scanResults.unknownTokens.forEach((token) => {
    const validation = validateToken(token);
    unknownPlaceholders.push({
      token,
      reason: validation.reason
    });
    messages.push(`${token}: ${validation.reason}`);
  });

  const validCount = detected.filter((item) => item.isValid).length;
  const invalidCount =
    detected.filter((item) => !item.isValid).length + unknownPlaceholders.length;

  return {
    totalPlaceholders: detected.length + unknownPlaceholders.length,
    valid: validCount,
    invalid: invalidCount,
    validationStatus: invalidCount === 0 ? "Valid" : "Invalid",
    validationMessages: messages,
    detectedPlaceholders: detected,
    unknownPlaceholders,
    missingRegistryEntries,
    scannedSections: scanResults.scannedSections
  };
}

module.exports = {
  validateToken,
  validateScanResults
};
