# Maintainer operations

## Repository protection

The active `main-protection` ruleset targets `main` with no bypass actors:

- Require a pull request and resolve all review conversations.
- Require the `Quality` check from GitHub Actions and an up-to-date branch.
- Block branch deletion and force pushes.
- Allow squash merges only.
- Require zero approving reviews while there is one maintainer; do not require
  a code owner or last-pusher approval that the maintainer cannot supply alone.

The owner can change repository settings. These rules enforce the normal change
process; they do not protect an account whose administrative access is compromised.
Use 2FA or a passkey on GitHub and npm, protect recovery methods, and keep write
access limited to trusted maintainers. Review installed GitHub Apps, deploy keys,
and tokens when access needs change.

When another maintainer joins, require at least one approving review, dismiss
stale approvals when code changes, and consider required code owner reviews.
Keep the `Quality` job name stable. Introduce and observe a replacement check
before changing the required status-check name.

## Automation

- Default workflow token permissions are read-only; Actions cannot approve PRs.
- All external contributors need approval to run fork PR workflows.
- Allowed external actions are checkout, setup-node, upload-artifact,
  download-artifact, pnpm/action-setup, and the pinned dependabot/fetch-metadata.
  Full commit SHA references are required.
- Do not execute PR code with `pull_request_target`, privileged `workflow_run`,
  self-hosted runners, or publishing credentials.
- CI does not share dependency caches with publishing jobs or use repository secrets.
- Dependabot opens weekly npm and Actions update PRs with a seven-day cooldown for
  routine npm releases. CI uses the official Dependabot metadata action to mark
  stable forward minor/patch updates eligible (only patches within a `0.x` minor).
  Unknown versions, major changes, prereleases and maintainer edits require review.
- `Dependabot auto-merge` responds to completed CI runs. It verifies the exact bot
  identity, every signed commit, latest head/base CI, successful `Quality` and
  `Dependabot eligible` jobs, unchanged package scripts/contracts, dependency-only
  files, and strict `main` protection before an expected-SHA squash merge. CI audits
  development dependencies as well as production dependencies. Failed or stale
  evidence never permits a merge. Workflow, source, dependency-set and range
  operator changes require review. GitHub Actions upgrades require review.
- The privileged merge job executes only the trusted workflow on `main`, with no
  source checkout, installs, caches, artifacts, PAT, publishing secrets or OIDC.
  This public repository uses GitHub's official metadata action and a repository-
  specific workflow; it does not contain or fetch private workspace tooling.
  Manual dispatch defaults to dry-run. Disable this workflow to pause merging;
  preserve branch protection and CI. GitHub-token merges do not trigger push CI.
- Dependabot alerts and security updates, secret scanning and push protection,
  and private vulnerability reporting are enabled in repository settings.

## Publish to npm

Publishing is separate from PR CI and never runs automatically on push or merge.
`.github/workflows/publish.yml` accepts a stable version, runs the same CI against
the selected main commit, and publishes its packaged artifact. The publish job
does not check out source, install project dependencies, or run package lifecycle
scripts. Only that job can request an OIDC token.

The `npm` GitHub environment allows only the `main` branch, requires approval from
`ha-chi88`, and disallows administrator bypass. Self-approval is allowed because
there is one maintainer. Review the workflow commit, version, and successful CI
before approving the environment.

The npm trusted publisher for `safe-webview-bridge` must match these values
in its npm package settings:

| Field                | Value                                |
| -------------------- | ------------------------------------ |
| Provider             | GitHub Actions                       |
| Organization or user | `ha-chi88`                           |
| Repository           | `safe-webview-bridge`                |
| Workflow filename    | `publish.yml`                        |
| Environment          | `npm`                                |
| Allowed action       | Direct publishing with `npm publish` |

Do not add an `NPM_TOKEN` secret. Keep the package's option to require 2FA and
disallow bypass-2FA tokens enabled. Trusted publishing continues to work with
that setting. `npm stage publish` is also allowed by npm; dist-tag management
is not needed by this workflow and remains disabled.

Configure the trusted publisher close to the release: npm requires a new
configuration's first successful publish within two days. Creating it without
publishing is not a verified setup. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

1. Change the version through a reviewed PR and wait for `Quality` to pass.
2. Merge that PR, then select **Publish to npm → Run workflow** on **main**.
3. Enter the exact stable version in `package.json`, such as `2.0.0`.
4. Verify the commit and CI result, then approve the `npm` environment.
5. Confirm the npm version and provenance refer to the intended repository and
   commit. An already published version cannot be overwritten; use a new version
   for corrections.

Never dispatch this workflow merely to test configuration: successful execution
publishes a real package. Use a normal CI run to validate building and packaging.
