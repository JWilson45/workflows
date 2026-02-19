module.exports = async function runDelete({ github, core, process }) {
  const fs = require("fs");

  const raw = fs.readFileSync("delete-plan.json", "utf8");
  const plan = JSON.parse(raw);
  const images = Array.isArray(plan.images) ? plan.images : [];
  const mode = String(process.env.DELETE_MODE || "stage 2");

  const results = [];
  for (const imagePlan of images) {
    const owner = imagePlan.owner;
    const packageName = imagePlan.packageName;
    const versions = Array.isArray(imagePlan.versions) ? imagePlan.versions : [];

    let deleted = 0;
    const failed = [];

    for (const version of versions) {
      const scopes = ["org", "user"];
      let success = false;
      let lastError = null;

      for (const scope of scopes) {
        try {
          if (scope === "org") {
            await github.rest.packages.deletePackageVersionForOrg({
              org: owner,
              package_type: "container",
              package_name: packageName,
              package_version_id: version.id,
            });
          } else {
            await github.rest.packages.deletePackageVersionForUser({
              username: owner,
              package_type: "container",
              package_name: packageName,
              package_version_id: version.id,
            });
          }
          success = true;
          break;
        } catch (error) {
          lastError = error;
          if (error.status !== 404 && error.status !== 422) {
            break;
          }
        }
      }

      if (success) {
        deleted += 1;
        core.info(`[${owner}/${packageName}] Deleted version ${version.id} (${(version.tags || []).join(", ")})`);
      } else {
        const message =
          "Delete failed in both owner scopes (org/user). " +
          `Last status=${lastError?.status || "unknown"} message=${lastError?.message || "unknown"}`;
        failed.push({ id: version.id, error: message });
        core.warning(`[${owner}/${packageName}] Failed to delete version ${version.id}: ${message}`);
      }
    }

    results.push({
      image: `${owner}/${packageName}`,
      planned: versions.length,
      deleted,
      failed: failed.length,
    });
  }

  await core.summary
    .addHeading(`GHCR PR image cleanup delete (${mode})`)
    .addRaw(`Planned at: \`${plan.generatedAt || "unknown"}\`\n`)
    .addRaw(`Cutoff (UTC): \`${plan.cutoffIso || "unknown"}\`\n\n`);

  for (const result of results) {
    core.summary
      .addRaw(`### ${result.image}\n`)
      .addRaw(`Planned: \`${result.planned}\`\n`)
      .addRaw(`Deleted: \`${result.deleted}\`\n`)
      .addRaw(`Failed: \`${result.failed}\`\n\n`);
  }

  await core.summary.write();

  const failedTotal = results.reduce((sum, row) => sum + row.failed, 0);
  if (failedTotal > 0) {
    core.setFailed(`Failed to delete ${failedTotal} package version(s). Check logs/summary.`);
  }
};
