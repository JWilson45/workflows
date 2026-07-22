const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPrStateLookup,
  evaluateStaticEligibility,
  extractPrFromTag,
} = require("./common");
const { getCurrentVersion } = require("./delete");
const { listPackageVersions } = require("./plan");

const oldVersion = (tags) => ({
  id: 1,
  updated_at: "2026-01-01T00:00:00Z",
  metadata: { container: { tags } },
});
const cutoffMs = Date.parse("2026-01-08T00:00:00Z");

test("recognizes image, per-image cache, and shared dependency cache PR tags", () => {
  assert.equal(extractPrFromTag("1.2.3-pr42-a1b2c3d"), "42");
  assert.equal(extractPrFromTag("buildcache-modern-api-pr42"), "42");
  assert.equal(extractPrFromTag("deps-pr42"), "42");
  assert.equal(extractPrFromTag("buildcache-modern-api"), null);
});

test("keeps mixed tags and newer versions out of the delete plan", () => {
  assert.equal(
    evaluateStaticEligibility(oldVersion(["1.2.3-pr42-a1b2c3d", "latest"]), { selectedPrs: new Set(), cutoffMs }).skip,
    "mixed-tags"
  );
  const newer = oldVersion(["1.2.3-pr42-a1b2c3d"]);
  newer.updated_at = "2026-01-09T00:00:00Z";
  assert.equal(evaluateStaticEligibility(newer, { selectedPrs: new Set(), cutoffMs }).skip, "newer-than-cutoff");
});

test("plans old untagged and selected PR artifacts", () => {
  assert.equal(evaluateStaticEligibility(oldVersion([]), { selectedPrs: new Set(), cutoffMs }).reason, "untagged");
  assert.equal(
    evaluateStaticEligibility(oldVersion(["deps-pr42"]), { selectedPrs: new Set(["42"]), cutoffMs }).reason,
    "pr-tagged"
  );
  assert.equal(
    evaluateStaticEligibility(oldVersion(["deps-pr42"]), { selectedPrs: new Set(["43"]), cutoffMs }).skip,
    "selection"
  );
});

test("uses and caches the read-only token for a private cross-repository PR lookup", async () => {
  let calls = 0;
  const lookup = createPrStateLookup({
    github: null,
    context: { repo: { owner: "JWilson45", repo: "workflows" } },
    prRepository: { owner: "JWilson45", repo: "micromarketing", name: "JWilson45/micromarketing" },
    token: "read-only-token",
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ state: "open" }) };
    },
  });
  assert.equal(await lookup("228"), "open");
  assert.equal(await lookup("228"), "open");
  assert.equal(calls, 1);
});

test("fails closed when cross-repository open-PR protection has no token", async () => {
  const lookup = createPrStateLookup({
    github: null,
    context: { repo: { owner: "JWilson45", repo: "workflows" } },
    prRepository: { owner: "JWilson45", repo: "micromarketing", name: "JWilson45/micromarketing" },
    token: "",
  });
  await assert.rejects(() => lookup("228"), /requires PR_READ_TOKEN/);
});

test("a stale plan whose version gained a release tag is no longer eligible", () => {
  assert.equal(
    evaluateStaticEligibility(oldVersion(["deps-pr42", "latest"]), { selectedPrs: new Set(), cutoffMs }).skip,
    "mixed-tags"
  );
});

test("treats a disappeared package version as a revalidation skip", async () => {
  const missing = Object.assign(new Error("Not Found"), { status: 404 });
  const github = {
    rest: {
      packages: {
        getPackageVersionForUser: async () => { throw missing; },
      },
    },
  };
  const result = await getCurrentVersion(github, { owner: "JWilson45", packageName: "mm", scope: "user" }, 123);
  assert.equal(result, null);
});

test("treats a package that has not been built yet as empty rather than an error", async () => {
  const missing = Object.assign(new Error("Package not found"), { status: 404 });
  const github = {
    paginate: async () => { throw missing; },
    rest: {
      packages: {
        getAllPackageVersionsForPackageOwnedByOrg: {},
        getAllPackageVersionsForPackageOwnedByUser: {},
      },
    },
  };
  const result = await listPackageVersions(github, "JWilson45", "mm-buildcache");
  assert.deepEqual(result, { versions: [], scope: null, missing: true });
});
