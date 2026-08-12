const assert = require("node:assert/strict");
const test = require("node:test");
const {
  coverageRows,
  diffCatalog,
  discoverMicromarketingImages,
  discoveredImageNames,
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
    { image: "ghcr.io/jwilson45/future-app", inGhcr: false, inCatalog: true, action: "skipped; warn" },
    { image: "ghcr.io/jwilson45/mm", inGhcr: true, inCatalog: true, action: "will clean" },
    { image: "ghcr.io/jwilson45/mm-postgres-replication", inGhcr: true, inCatalog: false, action: "will clean" },
  ]);
});

test("toImageName lowercases the owner and keeps the package name", () => {
  assert.equal(toImageName("outlook-connector", "JWilson45"), "ghcr.io/jwilson45/outlook-connector");
});

test("discoverMicromarketingImages paginates user packages and fail-closes on 403", async () => {
  const github = {
    paginate: async (fn) => fn(),
    rest: {
      packages: {
        listPackagesForUser: async () => micromarketingPackages,
      },
    },
  };
  assert.ok((await discoverMicromarketingImages({ github })).includes("ghcr.io/jwilson45/outlook-connector"));

  const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
  const failing = {
    paginate: async (fn) => fn(),
    rest: {
      packages: {
        listPackagesForUser: async () => {
          throw forbidden;
        },
      },
    },
  };
  await assert.rejects(
    () => discoverMicromarketingImages({ github: failing }),
    /Unable to list container packages for JWilson45 \(HTTP 403\)/
  );
});
