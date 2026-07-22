const PR_IMAGE_TAG = /-pr(\d+)-[0-9a-f]{7,}$/i;
const PR_BUILD_CACHE_TAG = /^buildcache-.+-pr(\d+)$/i;
const PR_SHARED_CACHE_TAG = /^deps-pr(\d+)$/i;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Expected true or false. Received: ${value}`);
}

function parseRepository(value, fallback) {
  const repository = String(value || fallback || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`pr_repository must be owner/repository. Received: ${repository || "(empty)"}`);
  }
  const [owner, repo] = repository.split("/", 2);
  return { owner, repo, name: `${owner}/${repo}` };
}

function extractPrFromTag(tag) {
  const value = String(tag || "");
  const match = value.match(PR_IMAGE_TAG) || value.match(PR_BUILD_CACHE_TAG) || value.match(PR_SHARED_CACHE_TAG);
  return match ? match[1] : null;
}

function evaluateStaticEligibility(version, { selectedPrs, cutoffMs }) {
  const tags = Array.isArray(version?.metadata?.container?.tags) ? version.metadata.container.tags : [];
  const hasTags = tags.length > 0;
  const isUntagged = !hasTags;
  const prs = [...new Set(tags.map(extractPrFromTag).filter(Boolean))];
  const hasPrTag = prs.length > 0;
  const allTagsArePrCleanupTags = hasTags && tags.every((tag) => Boolean(extractPrFromTag(tag)));

  if (!isUntagged && !hasPrTag) {
    return { eligible: false, skip: "non-cleanup-tags", tags, prs };
  }
  if (hasPrTag && !allTagsArePrCleanupTags) {
    return { eligible: false, skip: "mixed-tags", tags, prs };
  }
  if (hasPrTag && selectedPrs.size > 0 && !prs.every((pr) => selectedPrs.has(pr))) {
    return { eligible: false, skip: "selection", tags, prs };
  }

  const timestamp = version?.updated_at || version?.created_at;
  const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (Number.isNaN(timestampMs)) {
    return { eligible: false, skip: "missing-timestamp", tags, prs };
  }
  if (timestampMs >= cutoffMs) {
    return { eligible: false, skip: "newer-than-cutoff", tags, prs, updatedAt: timestamp };
  }

  return {
    eligible: true,
    reason: isUntagged ? "untagged" : "pr-tagged",
    tags,
    prs,
    updatedAt: timestamp,
  };
}

function createPrStateLookup({ github, context, prRepository, token, fetchImpl = global.fetch }) {
  const cache = new Map();
  const currentRepository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();

  return async (pr) => {
    if (cache.has(pr)) return cache.get(pr);

    let state;
    if (!token && prRepository.name.toLowerCase() === currentRepository) {
      const response = await github.rest.pulls.get({
        owner: prRepository.owner,
        repo: prRepository.repo,
        pull_number: Number(pr),
      });
      state = response.data?.state;
    } else {
      if (!token) {
        throw new Error(
          `PR lookup for ${prRepository.name} requires PR_READ_TOKEN because it is not ${currentRepository}.`
        );
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(prRepository.owner)}/${encodeURIComponent(prRepository.repo)}/pulls/${encodeURIComponent(pr)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to look up ${prRepository.name} PR #${pr}: HTTP ${response.status}`);
      }
      const body = await response.json();
      state = body?.state;
    }

    if (state !== "open" && state !== "closed") {
      throw new Error(`Unexpected state for ${prRepository.name} PR #${pr}: ${state || "missing"}`);
    }
    cache.set(pr, state);
    return state;
  };
}

async function isProtectedByOpenPr(eligibility, { protectOpenPrs, getPrState }) {
  if (!protectOpenPrs || eligibility.reason !== "pr-tagged") return false;
  const states = await Promise.all(eligibility.prs.map(async (pr) => [pr, await getPrState(pr)]));
  return states.some(([, state]) => state === "open");
}

module.exports = {
  createPrStateLookup,
  evaluateStaticEligibility,
  extractPrFromTag,
  isProtectedByOpenPr,
  parseBoolean,
  parseRepository,
};
