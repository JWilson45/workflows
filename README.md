# Reusable Workflows

This repository hosts GitHub reusable workflows that power build and deploy pipelines across projects.

## Releasing

Releases are managed via an automated workflow that handles version bumps (patch, minor, major) and generates or augments release notes. All workflows in this repository are versioned together, and release notes clearly indicate which workflows have changed.

To create a release:

1. Ensure `main` contains the changes you want to publish.
2. Open *Actions → Release Reusable Workflows* and run the workflow.
3. Provide the type of version bump (patch, minor, or major). The workflow will automatically update the version tag accordingly.
4. The workflow creates or updates the git tag, publishes a GitHub Release with detailed notes including which workflows changed, and updates the matching major tag (for example `v1`).
5. Reference the workflows from other repositories using the major or exact tag, such as:

   ```yaml
   uses: jasonwilson/workflows/.github/workflows/build-and-deploy.yaml@v1
   ```

## Available workflows

- `.github/workflows/build-images.yaml` – **Single job (Bake):** plan tags + `docker buildx bake` for one or more images. Prefer this for monorepo CI build stages.
  - Defaults to `linux/amd64`
  - Inputs `attest_mode` (`min`|`max`|`none`) and `registry_cache_mode` (`min`|`max`)
  - **Registry cache only** (no local/type=local cache — ephemeral runners discard disk after the job)
  - Bake runs with `--progress=plain` for per-stage timings in logs

- `.github/workflows/deploy-products.yaml` – **Single job (Ship):** plan tags + Helm and/or atomic multi-product GitOps. Prefer this for monorepo CI deploy stages gated on tests.

- `.github/workflows/build-and-deploy.yaml` – Combined Bake → Ship for single-call callers (`phase=all`, default). Also supports `phase=build` / `phase=deploy` for one-job-only calls. Prefer the dedicated workflows above for the shortest Actions graph.

  **Multi-product (atomic) deploy:** pass `products_json` (array of products with `name`, `image_names`, `kube_namespace`, `helm_release`, `helm_chart`, `helm_values_file`, `gitops_application_file`, optional `do_deploy`, `helm_timeout`, `gitops_update_target_revision`). All deployable products are updated in **one GitOps commit** and one Argo webhook.

  **Registry tag probes:** GHCR checks authenticate with `GITHUB_TOKEN` and cache one pull token per repository.

  For pull request builds, image tags are suffixed as `${version}-pr${number}-${sha}` and the `latest` tag is not updated.

- `.github/workflows/cleanup-pr-images.yaml` – Manually triggered workflow that plans removal of stale PR-tagged GHCR versions, PR-specific build caches, and untagged versions. Manual runs are preview-only unless deletion is explicitly enabled.

- `.github/workflows/cleanup-pr-images-weekly.yaml` – Weekly scheduler that reads Micromarketing's CI image catalog, includes the shared build cache package, and performs the approved automatic cleanup.

- `.github/workflows/release.yaml` – Manages version bumps and publishes releases for this repository's reusable workflows.

## Helm deployments

The build-and-deploy workflow deploys with Helm when `kubeconfig_b64` is provided
or when no GitOps repository is configured. Image tags are set from each
`images_json` entry's `helmTagPath`.

When `gitops_repository` is set, the workflow updates the GitOps repository. If
`kubeconfig_b64` is also supplied, it also runs the Helm upgrade/install path for
transition-period compatibility. If `gitops_webhook_url` is provided, it posts a
GitHub-style push webhook to `${gitops_webhook_url}/api/webhook` after the GitOps
commit is pushed. This lets private runners trigger Argo CD refreshes over
Tailscale or another private network. If `gitops_webhook_secret` is provided, the
request includes `X-Hub-Signature-256`.

Example usage:

```yaml
jobs:
  deploy:
    uses: jasonwilson/workflows/.github/workflows/build-and-deploy.yaml@v1
    with:
      image_name: ghcr.io/org/repo
      app_dir: apps/micromarketing-modern-api
      kube_namespace: mmm-dev
      kube_deployment: mmmodern-api
      kube_container: mmmodern-api
      do_deploy: "true"
      helm_release: mmmodern-api-dev
      helm_chart: helm/mm-app
      helm_values_file: apps/micromarketing-modern-api/helm/values-dev.yaml
      helm_image_tag_path: image.tag
      helm_set: "extraFlag=true"
    secrets:
      kubeconfig_b64: ${{ secrets.KUBECONFIG_B64 }}
```

## GHCR image cleanup

Use *Actions -> Cleanup GHCR Images* to clean up PR images, PR-specific registry build caches, and tagless GHCR versions that were created by the build workflow.

- `image_name` (optional): one or more images, comma-separated (for example `ghcr.io/org/repo-a,ghcr.io/org/repo-b`)
- default image when blank: `ghcr.io/JWilson45/<repo>`
- `pr_numbers` (optional): comma-separated PR numbers, for example `123,456`; leave blank to target all PR-tagged versions
- `older_than_days` (default `7`): only delete candidate versions older than this many days
- `execute` (default `false`): set to true to run stage 2 deletion; manual dispatches otherwise stop after the uploaded plan
- `require_approval` (default `true`): when executing, use environment `delete` for approval
- `pr_repository` (optional): repository that owns PR numbers in image tags; blank uses this repository
- `protect_open_prs` (default `true`): do not delete artifacts for source PRs that remain open
- note: IDs like `652340938` in logs are GHCR package version IDs (not PR numbers)
- permissions: delete requires package admin access for the token on the target package
- deletes versions whose tags are all PR image tags like `1.2.3-pr123-abcdef0`
- deletes versions whose tags are all PR cache tags like `buildcache-api-pr123`
- deletes shared dependency-cache versions tagged `deps-pr123`
- deletes untagged versions older than the cutoff
- protects versions with any non-PR tag, including `latest`, release/version tags, and shared baseline cache tags like `buildcache-api`
- protects old PR-tagged versions when the associated source PR is still open
- stage 1 builds a dry-run delete plan and uploads `delete-plan` artifact
- stage 2 re-fetches every candidate before deleting, so changed tags, reopened PRs, and stale plans are skipped safely
- cleanup runs are serialized and delete-plan artifacts are retained for 30 days
- manual stage 2 runs in environment `delete` (approval gate) when `execute=true`
- implementation files:
  `.github/scripts/ghcr-cleanup/plan.js`,
  `.github/scripts/ghcr-cleanup/delete.js`

## Weekly scheduled cleanup

`cleanup-pr-images-weekly.yaml` runs every Sunday at 16:20 UTC. It reads
`JWilson45/micromarketing`'s `.github/ci/catalog.json`, adds
`ghcr.io/jwilson45/mm-buildcache`, and dispatches `cleanup-pr-images.yaml` with:

- `image_name`: every current CI image in the catalog plus the shared build cache (the Outlook MCP POC is not in this catalog)
- `pr_numbers`: blank (all PR-tagged versions)
- `older_than_days`: `7`
- `pr_repository`: `JWilson45/micromarketing`
- `protect_open_prs`: `true`
- `execute`: `true` on schedule; a manual run of the weekly wrapper defaults to preview-only
- `require_approval`: `false`

The public `workflows` repository needs a `MICROMARKETING_PR_READ_TOKEN` secret:
a fine-grained token limited to `JWilson45/micromarketing` with **Contents: Read**
and **Pull requests: Read**. It is used only to read the private CI catalog and
PR state; package listing and deletion continue to use the workflow token.
