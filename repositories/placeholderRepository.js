const placeholderRegistry = require("../services/placeholderRegistry");

async function findGroupedPlaceholders() {
  const namespaces = placeholderRegistry.getGroupedByNamespace();
  const tableGroup = placeholderRegistry.getTableGroup();

  return {
    namespaces,
    tables: tableGroup
  };
}

async function findAllPlaceholders() {
  const grouped = await findGroupedPlaceholders();

  return {
    groups: [
      ...grouped.namespaces,
      grouped.tables
    ],
    scalars: placeholderRegistry.getScalarPlaceholders(),
    tables: placeholderRegistry.getTablePlaceholders()
  };
}

module.exports = {
  findGroupedPlaceholders,
  findAllPlaceholders
};
