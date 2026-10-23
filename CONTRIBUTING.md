# Contributing

Use issues for reproducible bugs and feature discussions. For suspected security
vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

Use Node.js 24 and the pnpm version pinned in `package.json`. Fork the repository
if you do not have write access, then create a branch from `main`.

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm exec playwright install chromium
CI=true pnpm test:browser
pnpm audit:production
```

CI also runs `npm pack --ignore-scripts` to verify package generation. Dependencies
are installed without lifecycle scripts. Any change that needs an install script
must explain why and narrowly scope the additional execution.

The quality gate checks lint and formatting, compile-time API contracts, runtime
behavior, schema interoperability, and the package installed in an isolated
consumer. Package checks exercise browser bundles and Metro bundles for iOS and
Android. Browser tests cover real DOM message delivery and iframe-origin
isolation. Add focused regression tests for behavior changes. These checks do
not replace integration testing on the host application's supported devices.

## Pull requests

- Keep each PR focused and explain the problem, behavior change, and validation.
- Update the lockfile with pnpm when changing dependencies; do not hand-edit it.
- Do not include `node_modules`, generated `dist` output, credentials, or private data.
- Address review conversations and bring the branch up to date with `main`.
- Wait for the `Quality` check, then a maintainer can squash-merge the PR.

All changes to `main`, including maintainer changes, go through a PR. Direct
changes, force pushes, and deletion of `main` are blocked by the repository
ruleset. Only maintainers have merge access. There is currently one maintainer,
so a separate approving review is not required; this does not grant contributors
merge access. `CODEOWNERS` requests maintainer review when applicable.

Workflows from external contributors require maintainer approval before they
run. Approval to run CI is separate from accepting the code. PR CI uses a
read-only token, GitHub-hosted runners, and no publishing credentials. Changes
to workflows and dependencies receive particular attention during review.

See [.github/MAINTAINING.md](.github/MAINTAINING.md) for repository administration
and the release procedure.
