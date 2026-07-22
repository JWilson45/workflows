const fs = require("fs");
const {
  createPrStateLookup,
  evaluateStaticEligibility,
  isProtectedByOpenPr,
  parseBoolean,
  parseRepository,
} = require("./common");

function parseSelectedPrs(value) {
  const selectedPrs = new Set();
  const raw = String(value || "").trim();
  if (!raw) return selectedPrs;

  for (const item of raw.split(",")) {
    const pr = item.trim();
    if (!pr) continue;
    if (!/^\d+$/.test(pr)) {
      throw new Error(`Invalid PR number "${pr}". Use comma-separated integers, e.g. 123,456`);
    }
    selectedPrs.add(pr);
  }
  if (selectedPrs.size === 0) {
    throw new Error("pr_numbers was provided but no valid PR numbers were parsed.");
  }
  return selectedPrs;
}

function parseImageNames(value, context) {
  const raw = String(value || "").trim();
  const imageNames = raw
    ? raw.split(",").map((item) => item.trim()).filter(Boolean)
    : [`ghcr.io/JWilson45/${context.repo.repo}`];
  if (imageNames.length === 0) {
    throw new Error("image_name was provided but no valid values were parsed.");
  }
  return [...new Set(imageNames)];
}

function parseImageName(imageName) {
  if (!imageName.startsWith("ghcr.io/")) {
    throw new Error(`image_name must start with ghcr.io/. Received: ${imageName}`);
  }
  const imagePath = imageName.replace(/^ghcr\.io\//, "");
  const firstSlash = imagePath.indexOf("/");
  if (firstSlash <= 0 || firstSlash === imagePath.length - 1) {
    throw new Error(`image_name must look like ghcr.io/<owner>/<package>. Received: ${imageName}`);
  }
  const owner = imagePath.slice(0, firstSlash);
  let packageName = imagePath.slice(firstSlash + 1);
  packageName = packageName.split("@", 1)[0].split(":", 1)[0];
  return { owner, packageName };
}

async function listPackageVersions(github, owner, packageName) {
  try {
    const versions = await github.paginate(github.rest.packages.getAllPackageVersionsForPackageOwnedByOrg, {
      org: owner,
      package_type: "container",
      package_name: packageName,
      per_page: 100,
    });
    return { versions, scope: "org" };
  } catch (error) {
    if (error.status !== 404 && error.status !== 422) throw error;
  }

  const versions = await github.paginate(github.rest.packages.getAllPackageVersionsForPackageOwnedByUser, {
    username: owner,
    package_type: "container",
    package_name: packageName,
    per_page: 100,
  });
  return { versions, scope: "user" };
}

module.exports = async function runPlan({ github, context, core, process }) {
  const olderThanDaysInput = String(process.env.OLDER_THAN_DAYS || "7").trim();
  if (!/^\d+$/.test(olderThanDaysInput)) {
    throw new Error(`older_than_days must be a non-negative integer. Received: ${olderThanDaysInput}`);
  }
  const olderThanDays = Number.parseInt(olderThanDaysInput, 10);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const selectedPrs = parseSelectedPrs(process.env.PR_NUMBERS);
  const imageNames = parseImageNames(process.env.IMAGE_NAME, context);
  const prRepository = parseRepository(
    process.env.PR_REPOSITORY,
    `${context.repo.owner}/${context.repo.repo}`
  );
  const protectOpenPrs = parseBoolean(process.env.PROTECT_OPEN_PRS, true);
  const getPrState = createPrStateLookup({
    github,
    context,
    prRepository,
    token: String(process.env.PR_READ_TOKEN || "").trim(),
  });

  const results = [];
  const deletePlan = {
    generatedAt: new Date().toISOString(),
    olderThanDays,
    cutoffIso,
    selectedPrs: [...selectedPrs],
    prRepository: prRepository.name,
    protectOpenPrs,
    images: [],
  };

  for (const imageName of imageNames) {
    let owner;
    let packageName;
    try {
      ({ owner, packageName } = parseImageName(imageName));
      const { versions, scope } = await listPackageVersions(github, owner, packageName);
      const candidates = [];
      const stats = {
        protectedMixed: 0,
        protectedOpenPr: 0,
        skippedBySelection: 0,
        skippedByAge: 0,
        skippedNoTimestamp: 0,
        skippedNonCleanupTags: 0,
      };

      for (const version of versions) {
        const eligibility = evaluateStaticEligibility(version, { selectedPrs, cutoffMs });
        if (!eligibility.eligible) {
          if (eligibility.skip === "mixed-tags") stats.protectedMixed += 1;
          if (eligibility.skip === "selection") stats.skippedBySelection += 1;
          if (eligibility.skip === "newer-than-cutoff") stats.skippedByAge += 1;
          if (eligibility.skip === "missing-timestamp") stats.skippedNoTimestamp += 1;
          if (eligibility.skip === "non-cleanup-tags") stats.skippedNonCleanupTags += 1;
          continue;
        }
        if (await isProtectedByOpenPr(eligibility, { protectOpenPrs, getPrState })) {
          stats.protectedOpenPr += 1;
          continue;
        }
        candidates.push({
          id: version.id,
          tags: eligibility.tags,
          prs: eligibility.prs,
          reason: eligibility.reason,
          updatedAt: eligibility.updatedAt,
        });
      }

      deletePlan.images.push({
        image: `${owner}/${packageName}`,
        owner,
        packageName,
        scope,
        versions: candidates,
      });
      results.push({
        image: `${owner}/${packageName}`,
        versionsScanned: versions.length,
        candidates: candidates.length,
        prTaggedCandidates: candidates.filter((candidate) => candidate.reason === "pr-tagged").length,
        untaggedCandidates: candidates.filter((candidate) => candidate.reason === "untagged").length,
        ...stats,
        error: null,
      });
    } catch (error) {
      results.push({
        image: imageName,
        versionsScanned: 0,
        candidates: 0,
        prTaggedCandidates: 0,
        untaggedCandidates: 0,
        protectedMixed: 0,
        protectedOpenPr: 0,
        skippedBySelection: 0,
        skippedByAge: 0,
        skippedNoTimestamp: 0,
        skippedNonCleanupTags: 0,
        error: error.message,
      });
      core.warning(`[${imageName}] ${error.message}`);
    }
  }

  const candidateCount = deletePlan.images.reduce((sum, image) => sum + image.versions.length, 0);
  fs.writeFileSync("delete-plan.json", JSON.stringify(deletePlan, null, 2));
  core.setOutput("candidate_count", String(candidateCount));

  await core.summary
    .addHeading("GHCR image cleanup plan (stage 1)")
    .addRaw(`Images: \`${imageNames.join(", ")}\`\n`)
    .addRaw(`PR repository: \`${prRepository.name}\`\n`)
    .addRaw(`Protect open PRs: \`${protectOpenPrs}\`\n`)
    .addRaw("Mode: `dry-run`\n")
    .addRaw(`Older than days: \`${olderThanDays}\`\n`)
    .addRaw(`Cutoff (UTC): \`${cutoffIso}\`\n`)
    .addRaw(`Total candidates: \`${candidateCount}\`\n\n`);

  for (const result of results) {
    core.summary
      .addRaw(`### ${result.image}\n`)
      .addRaw(`Versions scanned: \`${result.versionsScanned}\`\n`)
      .addRaw(`Candidates: \`${result.candidates}\`\n`)
      .addRaw(`Candidate PR/cache-tagged versions: \`${result.prTaggedCandidates}\`\n`)
      .addRaw(`Candidate untagged versions: \`${result.untaggedCandidates}\`\n`)
      .addRaw(`Protected (mixed PR/non-PR tags): \`${result.protectedMixed}\`\n`)
      .addRaw(`Protected (open PR): \`${result.protectedOpenPr}\`\n`)
      .addRaw(`Skipped (partial selection overlap): \`${result.skippedBySelection}\`\n`)
      .addRaw(`Skipped (newer than cutoff): \`${result.skippedByAge}\`\n`)
      .addRaw(`Skipped (missing/invalid timestamp): \`${result.skippedNoTimestamp}\`\n`);
    if (result.error) core.summary.addRaw(`Error: \`${result.error}\`\n`);
    core.summary.addRaw("\n");
  }
  await core.summary.write();

  const imageErrors = results.filter((result) => Boolean(result.error));
  if (imageErrors.length > 0) {
    core.setFailed(`Failed to process ${imageErrors.length} image(s). Check logs/summary.`);
  }
};

module.exports.parseImageName = parseImageName;
module.exports.parseSelectedPrs = parseSelectedPrs;
