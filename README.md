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

- `.github/workflows/build-and-deploy.yaml` – Plans, builds, and optionally deploys one or more container images. When `images_json` lists multiple images, they are built in a **single** `docker buildx bake` job (one DinD runner) so monorepo multi-stage Dockerfiles share intermediate layers such as `deps`. Images are pushed to GHCR (or other registries in the image refs).

  **Multi-product (atomic) deploy:** pass `products_json` (array of products with `name`, `image_names`, `kube_namespace`, `helm_release`, `helm_chart`, `helm_values_file`, `gitops_application_file`, optional `do_deploy`, `helm_timeout`, `gitops_update_target_revision`). All deployable products are updated in **one GitOps commit** and one Argo webhook. Single-product callers can keep using `helm_release` / `kube_namespace` / `helm_values_file` / `gitops_application_file` without `products_json`.

  **Registry tag probes (plan):** GHCR existence checks authenticate with `GITHUB_TOKEN` (`packages: read`) and cache one pull token per repository for the plan job, avoiding anonymous `ghcr.io/token` minting that hits low rate limits on multi-image monorepo plans.

  For pull request builds, image tags are suffixed as `${version}-pr${number}-${sha}` and the `latest` tag is not updated.

- `.github/workflows/cleanup-pr-images.yaml` – Manually triggered workflow that removes PR-tagged GHCR container versions, PR-specific build caches, and untagged GHCR versions. It supports deleting all PR artifacts for a package or only specific PR numbers, with a `dry-run` preview mode.

- `.github/workflows/cleanup-pr-images-weekly.yaml` – Weekly scheduler that dispatches the cleanup workflow with fixed inputs for micromarketing images and no approval gate.

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
- `require_approval` (default `true`): when true, stage 2 uses environment `delete`
- note: IDs like `652340938` in logs are GHCR package version IDs (not PR numbers)
- permissions: delete requires package admin access for the token on the target package
- deletes versions whose tags are all PR image tags like `1.2.3-pr123-abcdef0`
- deletes versions whose tags are all PR cache tags like `buildcache-api-pr123`
- deletes untagged versions older than the cutoff
- protects versions with any non-PR tag, including `latest`, release/version tags, and shared baseline cache tags like `buildcache-api`
- stage 1 builds a dry-run delete plan and uploads `delete-plan` artifact
- manual stage 2 runs in environment `delete` (approval gate)
- implementation files:
  `.github/scripts/ghcr-cleanup/plan.js`,
  `.github/scripts/ghcr-cleanup/delete.js`

## Weekly scheduled cleanup

`cleanup-pr-images-weekly.yaml` runs every Sunday at 16:20 UTC and dispatches `cleanup-pr-images.yaml` with:

- `image_name`: `ghcr.io/JWilson45/mmmodern-web,ghcr.io/JWilson45/mmmodern-api,ghcr.io/JWilson45/mm`
- `pr_numbers`: blank (all PR-tagged versions)
- `older_than_days`: `7`
- `require_approval`: `false`
