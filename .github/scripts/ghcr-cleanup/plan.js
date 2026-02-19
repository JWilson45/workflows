module.exports = async function runPlan({ github, context, core, process }) {
  const fs = require("fs");

  const imageNameInput = String(process.env.IMAGE_NAME || "").trim();
  const prNumbersInput = String(process.env.PR_NUMBERS || "").trim();
  const olderThanDaysInput = String(process.env.OLDER_THAN_DAYS || "7").trim();

  if (!/^\d+$/.test(olderThanDaysInput)) {
    throw new Error(`older_than_days must be a non-negative integer. Received: ${olderThanDaysInput}`);
  }
  const olderThanDays = Number.parseInt(olderThanDaysInput, 10);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const selectedPrs = new Set();
  if (prNumbersInput.length > 0) {
    for (const raw of prNumbersInput.split(",")) {
      const pr = raw.trim();
      if (!pr) {
        continue;
      }
      if (!/^\d+$/.test(pr)) {
        throw new Error(`Invalid PR number "${pr}". Use comma-separated integers, e.g. 123,456`);
      }
      selectedPrs.add(pr);
    }
    if (selectedPrs.size === 0) {
      throw new Error("pr_numbers was provided but no valid PR numbers were parsed.");
    }
  }

  const imageNames = [];
  if (!imageNameInput) {
    const repoName = String(context.repo.repo || "").trim();
    if (!repoName) {
      throw new Error("Could not resolve image_name. Provide image_name directly.");
    }
    imageNames.push(`ghcr.io/JWilson45/${repoName}`);
  } else {
    for (const raw of imageNameInput.split(",")) {
      const value = raw.trim();
      if (value) {
        imageNames.push(value);
      }
    }
    if (imageNames.length === 0) {
      throw new Error("image_name was provided but no valid values were parsed.");
    }
  }

  const uniqueImageNames = [...new Set(imageNames)];
  const prTagPattern = /-pr(\d+)-[0-9a-f]{7,}$/i;
  const extractPrFromTag = (tag) => {
    const match = String(tag || "").match(prTagPattern);
    return match ? match[1] : null;
  };

  const results = [];
  const deletePlan = {
    generatedAt: new Date().toISOString(),
    olderThanDays,
    cutoffIso,
    selectedPrs: [...selectedPrs],
    images: [],
  };

  for (const imageName of uniqueImageNames) {
    try {
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
      if (packageName.includes("@")) {
        packageName = packageName.split("@", 1)[0];
      }
      if (packageName.includes(":")) {
        packageName = packageName.split(":", 1)[0];
      }

      const listVersionsForOrg = () =>
        github.paginate(github.rest.packages.getAllPackageVersionsForPackageOwnedByOrg, {
          org: owner,
          package_type: "container",
          package_name: packageName,
          per_page: 100,
        });

      const listVersionsForUser = () =>
        github.paginate(github.rest.packages.getAllPackageVersionsForPackageOwnedByUser, {
          username: owner,
          package_type: "container",
          package_name: packageName,
          per_page: 100,
        });

      let versions = [];
      try {
        versions = await listVersionsForOrg();
      } catch (error) {
        if (error.status === 404 || error.status === 422) {
          versions = await listVersionsForUser();
        } else if (error.status === 403) {
          throw new Error(
            `Forbidden while listing GHCR package versions for ${owner}/${packageName}. ` +
              "Ensure this repository has package admin access and GITHUB_TOKEN can manage package versions."
          );
        } else {
          throw error;
        }
      }

      const candidates = [];
      const protectedMixedTags = [];
      const skippedBySelection = [];
      const skippedByAge = [];
      const skippedNoTimestamp = [];

      for (const version of versions) {
        const tags = version?.metadata?.container?.tags || [];
        if (!Array.isArray(tags) || tags.length === 0) {
          continue;
        }

        const extractedPrs = tags.map((tag) => extractPrFromTag(tag));
        const hasPrTag = extractedPrs.some(Boolean);
        const allPrTags = extractedPrs.every(Boolean);
        if (!hasPrTag) {
          continue;
        }

        if (!allPrTags) {
          protectedMixedTags.push({ id: version.id, tags });
          continue;
        }

        const versionPrs = [...new Set(extractedPrs)];
        const matchesSelection = selectedPrs.size === 0 ? true : versionPrs.every((pr) => selectedPrs.has(pr));

        if (!matchesSelection) {
          if (selectedPrs.size > 0 && versionPrs.some((pr) => selectedPrs.has(pr))) {
            skippedBySelection.push({ id: version.id, tags, prs: versionPrs });
          }
          continue;
        }

        const timestamp = version?.updated_at || version?.created_at;
        if (!timestamp) {
          skippedNoTimestamp.push({ id: version.id, tags, prs: versionPrs });
          continue;
        }

        const timestampMs = Date.parse(timestamp);
        if (Number.isNaN(timestampMs)) {
          skippedNoTimestamp.push({ id: version.id, tags, prs: versionPrs });
          continue;
        }

        if (timestampMs >= cutoffMs) {
          skippedByAge.push({ id: version.id, tags, prs: versionPrs, updatedAt: timestamp });
          continue;
        }

        candidates.push({ id: version.id, tags, prs: versionPrs, updatedAt: timestamp });
      }

      for (const candidate of candidates) {
        core.info(
          `[dry-run] [${owner}/${packageName}] Would delete version ${candidate.id} (${candidate.tags.join(", ")}) ` +
            `updated_at=${candidate.updatedAt}`
        );
      }

      deletePlan.images.push({
        image: `${owner}/${packageName}`,
        owner,
        packageName,
        versions: candidates.map((candidate) => ({
          id: candidate.id,
          tags: candidate.tags,
          updatedAt: candidate.updatedAt,
        })),
      });

      results.push({
        image: `${owner}/${packageName}`,
        versionsScanned: versions.length,
        candidates: candidates.length,
        protectedMixed: protectedMixedTags.length,
        skippedBySelection: skippedBySelection.length,
        skippedByAge: skippedByAge.length,
        skippedNoTimestamp: skippedNoTimestamp.length,
        error: null,
      });
    } catch (error) {
      results.push({
        image: imageName,
        versionsScanned: 0,
        candidates: 0,
        protectedMixed: 0,
        skippedBySelection: 0,
        skippedByAge: 0,
        skippedNoTimestamp: 0,
        error: error.message,
      });
      core.warning(`[${imageName}] ${error.message}`);
    }
  }

  const selectedText =
    selectedPrs.size > 0 ? [...selectedPrs].sort((a, b) => Number(a) - Number(b)).join(", ") : "ALL";

  const candidateCount = deletePlan.images.reduce((sum, image) => sum + image.versions.length, 0);
  fs.writeFileSync("delete-plan.json", JSON.stringify(deletePlan, null, 2));
  core.setOutput("candidate_count", String(candidateCount));

  await core.summary
    .addHeading("GHCR PR image cleanup plan (stage 1)")
    .addRaw(`Images: \`${uniqueImageNames.join(", ")}\`\n`)
    .addRaw("Mode: `dry-run`\n")
    .addRaw(`Selection: \`${selectedText}\`\n`)
    .addRaw(`Older than days: \`${olderThanDays}\`\n`)
    .addRaw(`Cutoff (UTC): \`${cutoffIso}\`\n`)
    .addRaw(`Total candidates: \`${candidateCount}\`\n\n`);

  for (const result of results) {
    core.summary
      .addRaw(`### ${result.image}\n`)
      .addRaw(`Versions scanned: \`${result.versionsScanned}\`\n`)
      .addRaw(`Candidates: \`${result.candidates}\`\n`)
      .addRaw(`Protected (mixed PR/non-PR tags): \`${result.protectedMixed}\`\n`)
      .addRaw(`Skipped (partial selection overlap): \`${result.skippedBySelection}\`\n`)
      .addRaw(`Skipped (newer than cutoff): \`${result.skippedByAge}\`\n`)
      .addRaw(`Skipped (missing/invalid timestamp): \`${result.skippedNoTimestamp}\`\n`);
    if (result.error) {
      core.summary.addRaw(`Error: \`${result.error}\`\n`);
    }
    core.summary.addRaw("\n");
  }

  await core.summary.write();

  const imageErrors = results.filter((r) => Boolean(r.error));
  if (imageErrors.length > 0) {
    core.setFailed(`Failed to process ${imageErrors.length} image(s). Check logs/summary.`);
  }
};
