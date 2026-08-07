const placeholderRegistry = require("./placeholderRegistry");

const PLACEHOLDER_PATTERN =
  /\{\{(?:TABLE:([A-Za-z][A-Za-z0-9]*)|([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*))\}\}/g;

const SCALAR_TOKEN_PATTERN =
  /^\{\{([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)\}\}$/;

const TABLE_TOKEN_PATTERN = /^\{\{TABLE:([A-Za-z][A-Za-z0-9]*)\}\}$/;

function normalizePlaceholderPart(value) {
  return String(value || "").trim().toLowerCase();
}

function parsePlaceholderToken(token) {
  const value = String(token || "").trim();

  const scalarMatch = value.match(SCALAR_TOKEN_PATTERN);

  if (scalarMatch) {
    return {
      type: "scalar",
      namespace: scalarMatch[1],
      key: scalarMatch[2],
      token: value
    };
  }

  const tableMatch = value.match(TABLE_TOKEN_PATTERN);

  if (tableMatch) {
    return {
      type: "table",
      collection: tableMatch[1],
      token: value
    };
  }

  return null;
}

function isValidPlaceholderToken(token) {
  return Boolean(parsePlaceholderToken(token));
}

function recognizePlaceholdersInText(text) {
  const input = String(text || "");
  const pattern =
    /\{\{(?:TABLE:([A-Za-z][A-Za-z0-9]*)|([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*))\}\}/g;
  const matches = [];
  let match = pattern.exec(input);

  while (match) {
    if (match[1]) {
      matches.push({
        type: "table",
        collection: match[1],
        token: buildTableToken(match[1]),
        index: match.index
      });
    } else {
      matches.push({
        type: "scalar",
        namespace: match[2],
        key: match[3],
        token: buildScalarToken(match[2], match[3]),
        index: match.index
      });
    }

    match = pattern.exec(input);
  }

  return matches;
}

function buildScalarToken(namespace, key) {
  return `{{${namespace}.${key}}}`;
}

function buildTableToken(collection) {
  return `{{TABLE:${collection}}}`;
}

function resolvePlaceholder(token, registry) {
  const parsed = parsePlaceholderToken(token);

  if (!parsed) {
    return {
      recognized: false,
      token,
      parsed: null
    };
  }

  if (parsed.type === "table") {
    const definition = registry.findTablePlaceholder(parsed.collection);

    return {
      recognized: Boolean(definition),
      token: parsed.token,
      parsed: definition
        ? {
            ...parsed,
            collection: definition.collection
          }
        : parsed,
      definition: definition || null
    };
  }

  const definition = registry.findScalarPlaceholder(parsed.namespace, parsed.key);

  return {
    recognized: Boolean(definition),
    token: parsed.token,
    parsed: definition
      ? {
          ...parsed,
          namespace: definition.namespace,
          key: definition.key
        }
      : parsed,
    definition: definition || null
  };
}

module.exports = {
  PLACEHOLDER_PATTERN,
  normalizePlaceholderPart,
  parsePlaceholderToken,
  isValidPlaceholderToken,
  recognizePlaceholdersInText,
  resolvePlaceholder
};
