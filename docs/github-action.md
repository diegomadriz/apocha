# GitHub Action

Use the verify-only composite action as a required pull request status check.
Replace `<owner>` with the owner of the Apocha repository:

```yaml
name: Receipts
on: pull_request
permissions:
  contents: read
jobs:
  receipts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: <owner>/apocha@v0.2.0
        with:
          require-signed: 'true'
```

In branch protection or a ruleset, require the `receipts` job to pass before
merging. Publish receipt notes to the origin before opening or updating the PR;
the action fetches `refs/notes/*`. It never pushes, runs an agent, or needs model
credentials. It installs Apocha from the action directory and verifies the
checked-out repository with Node.js 24 by default.

Inputs `base` and `head` default to the pull request event's base and head SHAs.
Override them for other events. `node-version` defaults to `24`;
`require-signed` defaults to `false`. Base configuration can also require signed
receipts; the input cannot disable that policy.

The check proves that every commit on the PR head's first-parent chain that is
not reachable from base carries a valid receipt: commit identity, parents and
change digest match, and any signature is valid and authorized. Integration
merge commits are checked too. With signatures required, every receipt must be
signed by a key in the base commit's allowed signers. Configuration, notes ref,
and signer trust all come from base, so a PR cannot authorize its own key.

It does not re-run checks or review. Unsigned receipts establish consistency,
not authenticated provenance. Commits on merged side branches are represented
by their integration receipt rather than individually traversed.

Locally, run `apocha verify-range <base>..<head> [--require-signed] [--json]`.
It reports every commit and signature status, names the first failing commit
(oldest first), and exits non-zero on failure. In Actions it writes the same
results as a table to `GITHUB_STEP_SUMMARY` when set.
