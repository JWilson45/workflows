const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  coverageRows,
  diffCatalog,
  discoverFromSource,
  discoverMicromarketingImages,
  discoveredImageNames,
  extractImageNames,
  filterMicromarketingPackages,
  parseExclude,
  readCatalogImages,
  toImageName,
} = require("./discover");

const pkg = (name, repo) => ({
  name,
  repository: repo ? { full_name: repo } : undefined,
});

const micromarketingPackages = [
  pkg("mm", "JWilson45/micromarketing"),
  pkg("outlook-connector", "JWilson45/micromarketing"),
  pkg("mm-postgres-replication", "JWilson45/micromarketing"),
  pkg("mm-buildcache", "jwilson45/micromarketing"),
  pkg("github-runner", "JWilson45/github-runner"),
  pkg("obx-conditions", "JWilson45/obx"),
  pkg("unlinked"),
];

test("keeps micromarketing-linked packages and drops other repos", () => {
  const matched = filterMicromarketingPackages(micromarketingPackages);
  assert.deepEqual(
    matched.map((item) => item.name),
    ["mm", "outlook-connector", "mm-postgres-replication", "mm-buildcache"]
  );
});

test("exclude list is case-insensitive and removes matching package names", () => {
  const matched = filterMicromarketingPackages(micromarketingPackages, {
    exclude: "MM-BUILDCACHE,github-runner",
  });
  assert.deepEqual(
    matched.map((item) => item.name),
    ["mm", "outlook-connector", "mm-postgres-replication"]
  );
});

test("parseExclude accepts arrays and comma-separated strings", () => {
  assert.deepEqual([...parseExclude("MM, outlook-connector")], ["mm", "outlook-connector"]);
  assert.deepEqual([...parseExclude(["MM-BUILDCACHE"])], ["mm-buildcache"]);
  assert.equal(parseExclude("").size, 0);
});

test("discovered image names are sorted GHCR refs and include Outlook MCP", () => {
  assert.deepEqual(discoveredImageNames(micromarketingPackages), [
    "ghcr.io/jwilson45/mm",
    "ghcr.io/jwilson45/mm-buildcache",
    "ghcr.io/jwilson45/mm-postgres-replication",
    "ghcr.io/jwilson45/outlook-connector",
  ]);
});

test("empty list after filter throws", () => {
  assert.throws(
    () => discoveredImageNames([pkg("github-runner", "JWilson45/github-runner")]),
    /No container packages linked to JWilson45\/micromarketing/
  );
  assert.throws(
    () => discoveredImageNames(micromarketingPackages, { exclude: "mm,outlook-connector,mm-postgres-replication,mm-buildcache" }),
    /No container packages linked/
  );
});

test("catalog diff reports extras and missing catalog images", () => {
  const catalogImages = readCatalogImages({
    images: {
      "sales-rep-web-app": { image: "ghcr.io/jwilson45/mm" },
      "outlook-connector": { image: "ghcr.io/jwilson45/outlook-connector" },
      "not-published-yet": { image: "ghcr.io/jwilson45/future-app" },
    },
  });
  const discovered = discoveredImageNames(micromarketingPackages);
  const drift = diffCatalog(discovered, catalogImages);
  assert.deepEqual(drift.missingFromGhcr, ["ghcr.io/jwilson45/future-app"]);
  assert.deepEqual(drift.extraInGhcr, [
    "ghcr.io/jwilson45/mm-buildcache",
    "ghcr.io/jwilson45/mm-postgres-replication",
  ]);
});

test("coverage rows mark catalog-only images as skipped", () => {
  const rows = coverageRows(
    ["ghcr.io/jwilson45/mm", "ghcr.io/jwilson45/mm-postgres-replication"],
    ["ghcr.io/jwilson45/mm", "ghcr.io/jwilson45/future-app"]
  );
  assert.deepEqual(rows, [
    { image: "ghcr.io/jwilson45/future-app", inGhcr: false, inDiscovered: false, inCatalog: true, action: "skipped; warn" },
    { image: "ghcr.io/jwilson45/mm", inGhcr: true, inDiscovered: true, inCatalog: true, action: "will clean" },
    { image: "ghcr.io/jwilson45/mm-postgres-replication", inGhcr: true, inDiscovered: true, inCatalog: false, action: "will clean" },
  ]);
});

test("extractImageNames strips tags and interpolations", () => {
  const text = [
    "ghcr.io/jwilson45/mm-postgres-replication:latest",
    "ghcr.io/jwilson45/outlook-connector:${TAG}",
    "repository: ghcr.io/jwilson45/mm",
    "ghcr.io/someone-else/ignored",
  ].join("\n");
  assert.deepEqual(extractImageNames(text).sort(), [
    "ghcr.io/jwilson45/mm",
    "ghcr.io/jwilson45/mm-postgres-replication",
    "ghcr.io/jwilson45/outlook-connector",
  ]);
});

test("source scan finds micromarketing images and always includes the build cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghcr-discover-"));
  fs.mkdirSync(path.join(root, ".github", "ci"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "ci", "catalog.json"),
    JSON.stringify({ images: { mm: { image: "ghcr.io/jwilson45/mm" } } })
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "build:postgres-replication": "docker build -t ghcr.io/jwilson45/mm-postgres-replication:1.0.0",
        "build:outlook-connector": "docker build -t ghcr.io/jwilson45/outlook-connector:latest",
      },
    })
  );
  const images = discoverFromSource(root);
  assert.deepEqual(images, [
    "ghcr.io/jwilson45/mm",
    "ghcr.io/jwilson45/mm-buildcache",
    "ghcr.io/jwilson45/mm-postgres-replication",
    "ghcr.io/jwilson45/outlook-connector",
  ]);
});

test("toImageName lowercases the owner and keeps the package name", () => {
  assert.equal(toImageName("outlook-connector", "JWilson45"), "ghcr.io/jwilson45/outlook-connector");
});

test("discoverMicromarketingImages uses source even when GHCR listing returns 400", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghcr-discover-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"build":"docker build -t ghcr.io/jwilson45/outlook-connector:latest"}}');
  const failing = {
    paginate: async () => {
      throw Object.assign(new Error("Invalid argument."), { status: 400 });
    },
    rest: { packages: { listPackagesForUser: async () => {} } },
  };
  const images = await discoverMicromarketingImages({ github: failing, sourceRoot: root });
  assert.ok(images.includes("ghcr.io/jwilson45/outlook-connector"));
  assert.ok(images.includes("ghcr.io/jwilson45/mm-buildcache"));
});

test("discoverMicromarketingImages fail-closes on GHCR list errors when there is no source", async () => {
  const failing = {
    paginate: async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    },
    rest: { packages: { listPackagesForUser: async () => {} } },
  };
  await assert.rejects(
    () => discoverMicromarketingImages({ github: failing }),
    /Unable to list container packages for JWilson45 \(HTTP 403\)/
  );
});
