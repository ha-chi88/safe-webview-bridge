# Security policy

## Supported versions

Security fixes target the latest stable version published on npm. Older versions
do not receive separate backports. Upgrade to the latest stable release before
assessing whether a problem remains. Unreleased branches are development code.

## Report a vulnerability privately

Use [GitHub's private vulnerability report form](https://github.com/ha-chi88/safe-webview-bridge/security/advisories/new).
Include the affected version, relevant platform and configuration, impact,
reproduction steps, and a minimal proof of concept when possible. Remove tokens,
personal data, and other secrets from the report.

Do not post unpatched vulnerability details in public issues, discussions, or
pull requests. The maintainer will assess the report and coordinate a fix and
disclosure through the private advisory. This is a volunteer-maintained project;
there is no guaranteed response or remediation deadline.

## Security boundaries

Schema validation checks message data. It does not authenticate the sender,
authorize an operation, or establish that loaded web content is trustworthy.
Applications must restrict WebView navigation and origins, authorize sensitive
native operations, and avoid loading untrusted content into a privileged bridge.

Treat messages as untrusted input. Do not place secrets in example payloads or
logs. Report validation bypasses, unsafe message handling, and package or release
integrity issues through the private channel above.
