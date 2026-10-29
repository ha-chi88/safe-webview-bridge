# Maintainer operations

## Repository protection

The active `main-protection` ruleset targets `main` with no bypass actors:

- Require a pull request and resolve all review conversations.
- Require `Quality` and `Infrastructure security` from GitHub Actions and an up-to-date branch.
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
Keep the required job names stable. Introduce and observe a replacement check
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
- The dedicated Renovate App creates GitHub-verified update commits. Routine npm
  releases wait seven days; security advisories bypass that Renovate delay.
  Renovate cannot merge PRs or run package lifecycle scripts. pnpm updates have
  their own group so they cannot block routine library updates.
- `Renovate auto-merge` responds to completed CI runs. It verifies the numeric bot
  identity, every signed commit, latest head/base CI, successful `Quality` and
  `Infrastructure security` jobs, and strict `main` protection before an expected-SHA
  squash merge. CI audits development and production dependencies. Stable forward
  version updates, including majors and `0.x` minors, preserve scripts, contracts,
  dependency names and range operators. Failed or stale evidence never permits a merge.
- Separate pnpm updates may change only `packageManager` and `pnpm-lock.yaml`.
  They additionally require an official stable `pnpm/pnpm` release at least seven
  days old and zero active reviewed, unreviewed or malware advisories for the exact
  pnpm version. This toolchain age gate also applies to security-update PRs.
- Runner-only PRs may change existing job-level `runs-on` lines in `ci.yml`,
  `publish.yml` and `renovate-automerge.yml` to a newer approved Ubuntu image
  (22.04, 24.04, 26.04). Full file contents must otherwise match exactly.
  New images require a reviewed allowlist update after GitHub declares them GA.
  Action references, commands, permissions, triggers, source, overrides, mixed
  library/toolchain changes and other policy changes still require review.
- The privileged merge job executes only the trusted workflow on `main`, with no
  source checkout, installs, caches, artifacts, PAT, publishing secrets or OIDC.
  This public repository uses a repository-specific workflow and public GitHub APIs;
  it does not contain or fetch private workspace tooling.
  Manual dispatch defaults to dry-run. Disable this workflow to pause merging;
  preserve branch protection and CI. GitHub-token merges do not trigger push CI.
- Dependabot alerts, secret scanning, push protection and private vulnerability
  reporting remain enabled. Renovate handles update PRs, including security fixes.

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
