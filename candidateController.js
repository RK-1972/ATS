let candidateRepository = null;

try {
  // Repository layer may be introduced in a future sprint.
  // Keep this optional so the controller is ready now.
  // eslint-disable-next-line global-require
  candidateRepository = require("./repositories/candidateRepository");
} catch {
  candidateRepository = null;
}

async function checkDuplicateCandidate(req, res) {
  try {
    const { email = null, mobile = null } = req.body || {};

    let matches = [];

    if (candidateRepository?.checkDuplicateCandidate) {
      matches = await candidateRepository.checkDuplicateCandidate({
        email,
        mobile
      });
    } else if (candidateRepository?.findDuplicateCandidates) {
      matches = await candidateRepository.findDuplicateCandidates({
        email,
        mobile
      });
    }

    if (!Array.isArray(matches)) {
      matches = [];
    }

    return res.status(200).json({
      duplicateFound: matches.length > 0,
      matches
    });
  } catch (error) {
    return res.status(500).json({
      duplicateFound: false,
      matches: [],
      message: error.message || "Error checking duplicate candidates"
    });
  }
}

module.exports = {
  checkDuplicateCandidate
};

