const placeholderRepository = require("../repositories/placeholderRepository");

async function getDocumentPlaceholders() {
  return placeholderRepository.findAllPlaceholders();
}

module.exports = {
  getDocumentPlaceholders
};
