/**
 * Shared password policy — must match ResetPassword.jsx and POST /reset-password.
 */

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const PASSWORD_RULE_CHECKS = [
  (password) => password.length >= 8,
  (password) => /[A-Z]/.test(password),
  (password) => /[a-z]/.test(password),
  (password) => /\d/.test(password),
  (password) => /[@$!%*?&]/.test(password)
];

function isPasswordStrong(password) {
  return typeof password === "string" && PASSWORD_REGEX.test(password);
}

function getPasswordStrengthLabel(password) {
  if (!password) {
    return "Weak";
  }

  const score = PASSWORD_RULE_CHECKS.reduce(
    (total, check) => total + (check(password) ? 1 : 0),
    0
  );

  if (score <= 2) {
    return "Weak";
  }

  if (score <= 4) {
    return "Medium";
  }

  return "Strong";
}

module.exports = {
  PASSWORD_REGEX,
  PASSWORD_RULE_CHECKS,
  isPasswordStrong,
  getPasswordStrengthLabel
};
