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

- `.github/workflows/build-and-deploy.yaml` – Builds and pushes a container image to GitHub Container Registry (GHCR), can deploy the image to Kubernetes clusters, and creates a GitHub Release for the calling project. For pull request builds, the image tag is suffixed as `${version}-pr${number}-${sha}` and the `latest` tag is not updated.

- `.github/workflows/cleanup-pr-images.yaml` – Manually triggered workflow that removes PR-tagged GHCR container versions. It supports deleting all PR images for a package or only specific PR numbers, with a `dry-run` preview mode.

- `.github/workflows/cleanup-pr-images-weekly.yaml` – Weekly scheduler that dispatches the cleanup workflow with fixed inputs for micromarketing images and no approval gate.

- `.github/workflows/release.yaml` – Manages version bumps and publishes releases for this repository's reusable workflows.

## Helm deployments

The build-and-deploy workflow can deploy with Helm instead of `kubectl`. Helm is enabled when `use_helm: "true"` or when `helm_values_file` is set. The image tag is set via `helm_image_tag_path` (defaults to `image.tag`).

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

## GHCR PR image cleanup

Use *Actions -> Cleanup GHCR PR Images* to clean up PR images that were created by the build workflow.

- `image_name` (optional): one or more images, comma-separated (for example `ghcr.io/org/repo-a,ghcr.io/org/repo-b`)
- default image when blank: `ghcr.io/JWilson45/<repo>`
- `pr_numbers` (optional): comma-separated PR numbers, for example `123,456`; leave blank to target all PR images
- `older_than_days` (default `7`): only delete PR image versions older than this many days
- `require_approval` (default `true`): when true, stage 2 uses environment `delete`
- note: IDs like `652340938` in logs are GHCR package version IDs (not PR numbers)
- permissions: delete requires package admin access for the token on the target package
- stage 1 builds a dry-run delete plan and uploads `delete-plan` artifact
- manual stage 2 runs in environment `delete` (approval gate)
- implementation files:
  `.github/scripts/ghcr-cleanup/plan.js`,
  `.github/scripts/ghcr-cleanup/delete.js`

## Weekly scheduled cleanup

`cleanup-pr-images-weekly.yaml` runs every Sunday at 16:20 UTC and dispatches `cleanup-pr-images.yaml` with:

- `image_name`: `ghcr.io/JWilson45/mmmodern-web,ghcr.io/JWilson45/mmmodern-api,ghcr.io/JWilson45/mm`
- `pr_numbers`: blank (all PR images)
- `older_than_days`: `7`
- `require_approval`: `false`
