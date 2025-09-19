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

- `.github/workflows/build-and-deploy.yaml` – Builds and pushes a container image to GitHub Container Registry (GHCR), can deploy the image to Kubernetes clusters, and creates a GitHub Release for the calling project.

- `.github/workflows/release.yaml` – Manages version bumps and publishes releases for this repository's reusable workflows.
