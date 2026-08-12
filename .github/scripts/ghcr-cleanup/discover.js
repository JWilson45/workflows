const DEFAULT_PACKAGE_OWNER = "JWilson45";
const DEFAULT_SOURCE_REPOSITORY = "JWilson45/micromarketing";

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function parseExclude(value) {
  if (Array.isArray(value)) {
    return new Set(value.map(normalizeName).filter(Boolean));
  }
  const raw = String(value || "").trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map(normalizeName).filter(Boolean));
}

function toImageName(packageName, owner = DEFAULT_PACKAGE_OWNER) {
  const name = String(packageName || "").trim();
  if (!name) throw new Error("package name is required to build a GHCR image reference");
  return `ghcr.io/${normalizeName(owner)}/${name}`;
}

function linkedRepository(pkg) {
  return String(pkg?.repository?.full_name || "").trim();
}

function filterMicromarketingPackages(packages, { sourceRepository = DEFAULT_SOURCE_REPOSITORY, exclude } = {}) {
  const source = normalizeName(sourceRepository);
  if (!source.includes("/")) {
    throw new Error(`sourceRepository must be owner/repository. Received: ${sourceRepository || "(empty)"}`);
  }
  const excluded = parseExclude(exclude);
  return (Array.isArray(packages) ? packages : []).filter((pkg) => {
    const name = normalizeName(pkg?.name);
    if (!name || excluded.has(name)) return false;
    return normalizeName(linkedRepository(pkg)) === source;
  });
}

function imageNamesFromPackages(packages, owner = DEFAULT_PACKAGE_OWNER) {
  return [...new Set((Array.isArray(packages) ? packages : []).map((pkg) => toImageName(pkg.name, owner)))].sort();
}

function readCatalogImages(catalog) {
  return [...new Set(
    Object.values(catalog?.images || {})
      .map((image) => String(image?.image || "").trim())
      .filter(Boolean)
      .map((image) => image.toLowerCase())
  )].sort();
}

function diffCatalog(discovered, catalogImages) {
  const discoveredSet = new Set((discovered || []).map(normalizeName));
  const catalogSet = new Set((catalogImages || []).map(normalizeName));
  return {
    missingFromGhcr: [...catalogSet].filter((image) => !discoveredSet.has(image)).sort(),
    extraInGhcr: [...discoveredSet].filter((image) => !catalogSet.has(image)).sort(),
  };
}

function coverageRows(discovered, catalogImages) {
  const discoveredSet = new Set((discovered || []).map(normalizeName));
  const catalogSet = new Set((catalogImages || []).map(normalizeName));
  const images = [...new Set([...discoveredSet, ...catalogSet])].sort();
  return images.map((image) => {
    const inGhcr = discoveredSet.has(image);
    const inCatalog = catalogSet.has(image);
    return {
      image,
      inGhcr,
      inCatalog,
      action: inGhcr ? "will clean" : "skipped; warn",
    };
  });
}

function listPackagesErrorMessage(error, username = DEFAULT_PACKAGE_OWNER) {
  const status = error?.status;
  if (status === 400 || status === 403 || status === 404) {
    return `Unable to list container packages for ${username} (HTTP ${status}). GitHub App tokens must list public and private packages separately and need permission to list user packages; failing closed instead of falling back to the CI catalog.`;
  }
  return error?.message || String(error);
}

async function listUserContainerPackages(github, username = DEFAULT_PACKAGE_OWNER) {
  // GITHUB_TOKEN is a GitHub App installation token. Listing user packages
  // without `visibility` returns HTTP 400 Invalid argument.
  const visibilities = ["public", "private"];
  const packages = [];
  const seen = new Set();
  try {
    for (const visibility of visibilities) {
      const page = await github.paginate(github.rest.packages.listPackagesForUser, {
        username,
        package_type: "container",
        visibility,
        per_page: 100,
      });
      for (const pkg of page) {
        const key = normalizeName(pkg?.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        packages.push(pkg);
      }
    }
    return packages;
  } catch (error) {
    const wrapped = new Error(listPackagesErrorMessage(error, username));
    wrapped.cause = error;
    wrapped.status = error?.status;
    throw wrapped;
  }
}

function discoveredImageNames(packages, options = {}) {
  const owner = options.owner || DEFAULT_PACKAGE_OWNER;
  const matched = filterMicromarketingPackages(packages, options);
  const imageNames = imageNamesFromPackages(matched, owner);
  if (imageNames.length === 0) {
    throw new Error(
      `No container packages linked to ${options.sourceRepository || DEFAULT_SOURCE_REPOSITORY} were found for ${owner}.`
    );
  }
  if (imageNames.some((image) => !image.startsWith("ghcr.io/"))) {
    throw new Error("Discovered image names must be GHCR references.");
  }
  return imageNames;
}

async function discoverMicromarketingImages({ github, owner = DEFAULT_PACKAGE_OWNER, sourceRepository, exclude } = {}) {
  if (!github?.paginate || !github?.rest?.packages?.listPackagesForUser) {
    throw new Error("discoverMicromarketingImages requires a GitHub client with packages.listPackagesForUser.");
  }
  const packages = await listUserContainerPackages(github, owner);
  return discoveredImageNames(packages, { owner, sourceRepository, exclude });
}

module.exports = {
  DEFAULT_PACKAGE_OWNER,
  DEFAULT_SOURCE_REPOSITORY,
  coverageRows,
  diffCatalog,
  discoverMicromarketingImages,
  discoveredImageNames,
  filterMicromarketingPackages,
  imageNamesFromPackages,
  listUserContainerPackages,
  parseExclude,
  readCatalogImages,
  toImageName,
};
