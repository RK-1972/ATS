/**
 * Normalizes provider-specific hits into OTI external candidate representation.
 * Does not invent missing fields.
 */

function normalizeProfileUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.toLowerCase();
  }
}

function computeProfileCompleteness(profile) {
  const fields = [
    profile.display_name,
    profile.headline,
    profile.current_role,
    profile.organization,
    profile.location,
    profile.profile_url
  ];

  const filled = fields.filter((value) => String(value || "").trim()).length;
  const skillBonus = Array.isArray(profile.skills) && profile.skills.length > 0 ? 1 : 0;

  return Number(((filled + skillBonus) / (fields.length + 1)).toFixed(2));
}

function normalizeExternalProfile(rawProfile) {
  const providerKey = String(rawProfile?.provider_key || "").trim();
  const sourceRecordId = String(rawProfile?.source_record_id || "").trim();

  if (!providerKey || !sourceRecordId) {
    return null;
  }

  const skills = Array.isArray(rawProfile.skills)
    ? rawProfile.skills.map((skill) => String(skill || "").trim()).filter(Boolean)
    : [];

  const experienceIndicators = Array.isArray(rawProfile.experience_indicators)
    ? rawProfile.experience_indicators
    : [];

  const profile = {
    provider_key: providerKey,
    source_record_id: sourceRecordId,
    display_name: rawProfile.display_name ? String(rawProfile.display_name).trim() : null,
    headline: rawProfile.headline ? String(rawProfile.headline).trim() : null,
    current_role: rawProfile.current_role ? String(rawProfile.current_role).trim() : null,
    organization: rawProfile.organization ? String(rawProfile.organization).trim() : null,
    location: rawProfile.location ? String(rawProfile.location).trim() : null,
    skills,
    experience_indicators: experienceIndicators,
    profile_url: normalizeProfileUrl(rawProfile.profile_url),
    verified_email: rawProfile.verified_email ? String(rawProfile.verified_email).trim().toLowerCase() : null,
    data_access_permissions: rawProfile.data_access_permissions || {},
    resume_retrieval_permitted: Boolean(rawProfile.resume_retrieval_permitted),
    source_attribution: rawProfile.source_attribution || { provider: providerKey },
    licensing_notes: rawProfile.licensing_notes || null,
    source_surface_type: rawProfile.source_surface_type || null,
    resume_availability: rawProfile.resume_availability || null,
    candidate_evidence: Array.isArray(rawProfile.candidate_evidence) ? rawProfile.candidate_evidence : [],
    discovered_on: rawProfile.discovered_on || new Date().toISOString(),
    retrieved_on: new Date().toISOString(),
    raw_source_reference: {
      provider_key: providerKey,
      source_record_id: sourceRecordId,
      raw: rawProfile.raw || null
    }
  };

  profile.profile_completeness = computeProfileCompleteness(profile);

  return profile;
}

function normalizeExternalProfiles(rawProfiles) {
  const normalized = [];
  const seen = new Set();

  for (const raw of rawProfiles || []) {
    const profile = normalizeExternalProfile(raw);
    if (!profile) {
      continue;
    }

    const dedupeKey = `${profile.provider_key}:${profile.source_record_id}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push(profile);
  }

  return normalized;
}

module.exports = {
  normalizeExternalProfile,
  normalizeExternalProfiles,
  normalizeProfileUrl,
  computeProfileCompleteness
};
