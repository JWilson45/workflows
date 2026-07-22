const fs = require("fs");
const {
  createPrStateLookup,
  evaluateStaticEligibility,
  isProtectedByOpenPr,
  parseRepository,
} = require("./common");

async function getCurrentVersion(github, imagePlan, versionId) {
  const scopes = imagePlan.scope ? [imagePlan.scope] : ["org", "user"];
  for (const scope of scopes) {
    try {
      const response =
        scope === "org"
          ? await github.rest.packages.getPackageVersionForOrganization({
              org: imagePlan.owner,
              package_type: "container",
              package_name: imagePlan.packageName,
              package_version_id: versionId,
            })
          : await github.rest.packages.getPackageVersionForUser({
              username: imagePlan.owner,
              package_type: "container",
              package_name: imagePlan.packageName,
              package_version_id: versionId,
            });
      return { version: response.data, scope };
    } catch (error) {
      if (error.status === 404 || error.status === 422) continue;
      throw error;
    }
  }
  return null;
}

async function deleteCurrentVersion(github, imagePlan, versionId, scope) {
  if (scope === "org") {
    await github.rest.packages.deletePackageVersionForOrg({
      org: imagePlan.owner,
      package_type: "container",
      package_name: imagePlan.packageName,
      package_version_id: versionId,
    });
  } else {
    await github.rest.packages.deletePackageVersionForUser({
      username: imagePlan.owner,
      package_type: "container",
      package_name: imagePlan.packageName,
      package_version_id: versionId,
    });
  }
}

module.exports = async function runDelete({ github, context, core, process }) {
  const plan = JSON.parse(fs.readFileSync("delete-plan.json", "utf8"));
  const images = Array.isArray(plan.images) ? plan.images : [];
  const mode = String(process.env.DELETE_MODE || "stage 2");
  const cutoffMs = Date.parse(plan.cutoffIso || "");
  if (Number.isNaN(cutoffMs)) throw new Error("Delete plan has an invalid cutoffIso.");

  const selectedPrs = new Set(Array.isArray(plan.selectedPrs) ? plan.selectedPrs.map(String) : []);
  const prRepository = parseRepository(plan.prRepository, `${context.repo.owner}/${context.repo.repo}`);
  const protectOpenPrs = plan.protectOpenPrs !== false;
  const getPrState = createPrStateLookup({
    github,
    context,
    prRepository,
    token: String(process.env.PR_READ_TOKEN || "").trim(),
  });

  const revalidated = [];
  const revalidationSkipped = [];
  const revalidationErrors = [];

  // Preflight every candidate before deleting anything. This prevents an
  // approval delay or concurrent registry change from turning a safe plan
  // into an unsafe delete.
  for (const imagePlan of images) {
    for (const plannedVersion of imagePlan.versions || []) {
      try {
        const current = await getCurrentVersion(github, imagePlan, plannedVersion.id);
        if (!current) {
          revalidationSkipped.push({ imagePlan, version: plannedVersion, reason: "already-gone" });
          continue;
        }
        const eligibility = evaluateStaticEligibility(current.version, { selectedPrs, cutoffMs });
        if (!eligibility.eligible) {
          revalidationSkipped.push({ imagePlan, version: plannedVersion, reason: eligibility.skip });
          continue;
        }
        if (await isProtectedByOpenPr(eligibility, { protectOpenPrs, getPrState })) {
          revalidationSkipped.push({ imagePlan, version: plannedVersion, reason: "open-pr" });
          continue;
        }
        revalidated.push({ imagePlan, version: current.version, scope: current.scope, eligibility });
      } catch (error) {
        revalidationErrors.push({ imagePlan, version: plannedVersion, error: error.message });
      }
    }
  }

  const results = new Map();
  const resultFor = (imagePlan) => {
    const key = `${imagePlan.owner}/${imagePlan.packageName}`;
    if (!results.has(key)) {
      results.set(key, {
        image: key,
        planned: (imagePlan.versions || []).length,
        revalidated: 0,
        skipped: 0,
        deleted: 0,
        deletedByReason: {},
        failed: 0,
      });
    }
    return results.get(key);
  };

  for (const item of revalidated) resultFor(item.imagePlan).revalidated += 1;
  for (const item of revalidationSkipped) resultFor(item.imagePlan).skipped += 1;
  for (const item of revalidationErrors) resultFor(item.imagePlan).failed += 1;

  if (revalidationErrors.length === 0) {
    for (const item of revalidated) {
      const result = resultFor(item.imagePlan);
      try {
        await deleteCurrentVersion(github, item.imagePlan, item.version.id, item.scope);
        result.deleted += 1;
        result.deletedByReason[item.eligibility.reason] = (result.deletedByReason[item.eligibility.reason] || 0) + 1;
        const tagsText = item.eligibility.tags.length > 0 ? item.eligibility.tags.join(", ") : "untagged";
        core.info(`[${result.image}] Deleted version ${item.version.id} (${tagsText}) reason=${item.eligibility.reason}`);
      } catch (error) {
        result.failed += 1;
        core.warning(`[${result.image}] Failed to delete version ${item.version.id}: ${error.message}`);
      }
    }
  }

  await core.summary
    .addHeading(`GHCR image cleanup delete (${mode})`)
    .addRaw(`Planned at: \`${plan.generatedAt || "unknown"}\`\n`)
    .addRaw(`Cutoff (UTC): \`${plan.cutoffIso || "unknown"}\`\n`)
    .addRaw(`Preflight errors: \`${revalidationErrors.length}\`\n\n`);

  for (const result of results.values()) {
    core.summary
      .addRaw(`### ${result.image}\n`)
      .addRaw(`Planned: \`${result.planned}\`\n`)
      .addRaw(`Revalidated: \`${result.revalidated}\`\n`)
      .addRaw(`Skipped during revalidation: \`${result.skipped}\`\n`)
      .addRaw(`Deleted: \`${result.deleted}\`\n`)
      .addRaw(`Deleted PR/cache-tagged versions: \`${result.deletedByReason["pr-tagged"] || 0}\`\n`)
      .addRaw(`Deleted untagged versions: \`${result.deletedByReason.untagged || 0}\`\n`)
      .addRaw(`Failed: \`${result.failed}\`\n\n`);
  }

  if (revalidationSkipped.length > 0) {
    core.summary.addRaw("### Revalidation skips\n");
    for (const item of revalidationSkipped.slice(0, 50)) {
      core.summary.addRaw(`- \`${item.imagePlan.owner}/${item.imagePlan.packageName}\` version \`${item.version.id}\`: ${item.reason}\n`);
    }
    if (revalidationSkipped.length > 50) core.summary.addRaw(`- …and ${revalidationSkipped.length - 50} more\n`);
  }
  if (revalidationErrors.length > 0) {
    core.summary.addRaw("### Revalidation errors\n");
    for (const item of revalidationErrors) {
      core.summary.addRaw(`- \`${item.imagePlan.owner}/${item.imagePlan.packageName}\` version \`${item.version.id}\`: ${item.error}\n`);
    }
  }
  await core.summary.write();

  const deleteFailures = [...results.values()].reduce((sum, result) => sum + result.failed, 0);
  if (revalidationErrors.length > 0) {
    core.setFailed("Revalidation failed; no package versions were deleted. Check logs/summary.");
  } else if (deleteFailures > 0) {
    core.setFailed(`Failed to delete ${deleteFailures} package version(s). Check logs/summary.`);
  }
};

module.exports.getCurrentVersion = getCurrentVersion;
