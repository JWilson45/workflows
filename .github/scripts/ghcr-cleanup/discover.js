const fs = require("fs");
const path = require("path");

const DEFAULT_PACKAGE_OWNER = "JWilson45";
const DEFAULT_SOURCE_REPOSITORY = "JWilson45/micromarketing";
const DEFAULT_EXTRAS = ["ghcr.io/jwilson45/mm-buildcache"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);
const SCAN_EXTENSIONS = new Set([".json", ".yml", ".yaml", ".hcl", ".md", ".sh", ".mjs", ".js"]);
const SCAN_BASENAMES = new Set(["dockerfile", "docker-bake.hcl", "package.json", "catalog.json"]);

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
    const inDiscovered = discoveredSet.has(image);
    const inCatalog = catalogSet.has(image);
    return {
      image,
      inGhcr: inDiscovered,
      inDiscovered,
      inCatalog,
      action: inDiscovered ? "will clean" : "skipped; warn",
    };
  });
}

function extractImageNames(text, owner = DEFAULT_PACKAGE_OWNER) {
  const pattern = new RegExp(`ghcr\\.io/${normalizeName(owner)}/([a-z0-9][a-z0-9._-]*)`, "gi");
  const names = new Set();
  for (const match of String(text || "").matchAll(pattern)) {
    names.add(toImageName(match[1], owner));
  }
  return [...names];
}

function shouldScanFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (SCAN_BASENAMES.has(base)) return true;
  return SCAN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walkSourceFiles(rootDir) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (shouldScanFile(fullPath)) files.push(fullPath);
    }
  };
  visit(rootDir);
  return files;
}

function discoverFromSource(sourceRoot, { owner = DEFAULT_PACKAGE_OWNER, extras = DEFAULT_EXTRAS } = {}) {
  if (!sourceRoot) throw new Error("sourceRoot is required to discover micromarketing images from source.");
  const images = new Set((extras || []).map(normalizeName).filter(Boolean));
  for (const filePath of walkSourceFiles(sourceRoot)) {
    let text;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 1_000_000) continue;
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const image of extractImageNames(text, owner)) images.add(image);
  }
  return [...images].sort();
}

function listPackagesErrorMessage(error, username = DEFAULT_PACKAGE_OWNER) {
  const status = error?.status;
  if (status === 400 || status === 403 || status === 404) {
    return `Unable to list container packages for ${username} (HTTP ${status}). GitHub App tokens cannot list user packages; failing closed instead of falling back to the CI catalog.`;
  }
  return error?.message || String(error);
}

async function listUserContainerPackages(github, username = DEFAULT_PACKAGE_OWNER) {
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

function finalizeImageNames(images, { owner = DEFAULT_PACKAGE_OWNER, sourceRepository, exclude } = {}) {
  const excluded = parseExclude(exclude);
  const imageNames = [...new Set((images || []).map(normalizeName).filter(Boolean))]
    .filter((image) => !excluded.has(image.split("/").pop()))
    .sort();
  if (imageNames.length === 0) {
    throw new Error(
      `No container packages linked to ${sourceRepository || DEFAULT_SOURCE_REPOSITORY} were found for ${owner}.`
    );
  }
  if (imageNames.some((image) => !image.startsWith("ghcr.io/"))) {
    throw new Error("Discovered image names must be GHCR references.");
  }
  return imageNames;
}

function discoveredImageNames(packages, options = {}) {
  const owner = options.owner || DEFAULT_PACKAGE_OWNER;
  return finalizeImageNames(
    imageNamesFromPackages(filterMicromarketingPackages(packages, options), owner),
    options
  );
}

async function discoverMicromarketingImages({
  github,
  sourceRoot,
  owner = DEFAULT_PACKAGE_OWNER,
  sourceRepository,
  exclude,
  extras = DEFAULT_EXTRAS,
} = {}) {
  const images = new Set();
  if (sourceRoot) {
    for (const image of discoverFromSource(sourceRoot, { owner, extras })) images.add(image);
  }
  if (github?.paginate && github?.rest?.packages?.listPackagesForUser) {
    try {
      const packages = await listUserContainerPackages(github, owner);
      for (const image of imageNamesFromPackages(
        filterMicromarketingPackages(packages, { sourceRepository, exclude }),
        owner
      )) {
        images.add(image);
      }
    } catch (error) {
      if (images.size === 0) throw error;
    }
  }
  return finalizeImageNames([...images], { owner, sourceRepository, exclude });
}

module.exports = {
  DEFAULT_EXTRAS,
  DEFAULT_PACKAGE_OWNER,
  DEFAULT_SOURCE_REPOSITORY,
  coverageRows,
  diffCatalog,
  discoverFromSource,
  discoverMicromarketingImages,
  discoveredImageNames,
  extractImageNames,
  filterMicromarketingPackages,
  imageNamesFromPackages,
  listUserContainerPackages,
  parseExclude,
  readCatalogImages,
  toImageName,
};
