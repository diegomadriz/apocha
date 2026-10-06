# Receipts

A receipt is a Git note (under `refs.notes`, default `refs/notes/apocha`) on each promoted
commit. It records what was verified, how, and by whom, in a form anyone can check against Git.

## Version 3

Schema: `schemas/receipt-v3.schema.json`.

| Field | Meaning |
|---|---|
| `schema` | `apocha.receipt.v3` |
| `generator` | Package name and version that wrote it |
| `workflow`, `run_id`, `task_id` | Which workflow and run produced the commit |
| `task_digest` | SHA-256 of the normalized task: scope, criteria, checks, repair limit |
| `promoted_head`, `tree`, `parents`, `base_commit` | The commit's identity; `base_commit` is the first parent |
| `candidate_digest` | `sha256({ base_commit, changed_files, diff })` of the verified candidate |
| `checks[]` | Each check's ID, `pass`, the digest of its definition (argv, cwd, timeout, dependencies, network, env), and the sandbox it ran in |
| `tests` | Test edit policy, added test paths, and modified existing test paths (including deletions). Optional in older v3 receipts. |
| `review` | `PASS` and the number of findings across the run |
| `repairs`, `agent_invocations`, `retries` | How much work it took |
| `runtimes` | Adapter, adapter version, provider, and model for each role |
| `config_digest` | The project config at the base commit |
| `runtime_config_digest` | The runtime config used |
| `policy_digest` | Prompts, tool definitions and limits, workflow definition, and package version |
| `governance` | Whether governance edits were allowed, by whom (Git identity), and why |

The digests let two results be compared honestly: same `policy_digest` and
`runtime_config_digest` means the same harness and runtimes produced them.

## Verification

`apocha receipt <commit>` and `land` check, in order:

1. the note parses and matches the schema (v3), or the legacy shape (v1, v2);
2. `promoted_head` is the commit, and `tree` and `parents` match the commit object;
3. `base_commit` is the first parent;
4. **the candidate digest recomputed from Git** (`git diff base..commit`) equals
   `candidate_digest`, so the note cannot claim a different change than the commit holds;
5. every check passed and the review decision is `PASS`.

## Landing

`apocha land <source> --target <branch>`:

- requires the target to be a first-parent ancestor of the source;
- verifies the receipt of every first-parent commit between them (integration commits carry their
  own receipt; the topic commits they merge are covered by it);
- fast-forwards the target with a compare-and-swap, or, if the target is checked out in a clean
  worktree, fast-forwards that worktree;
- retires the landed batch ref and identified integrated topic batch refs under the configured
  `refs.batch_prefix`, using compare-and-swap deletion; `--keep-batch` skips retirement;
- keeps the target, moved refs, refs outside the prefix, symbolic refs, refs checked out in any
  worktree, and batch refs of RUNNING or PAUSED runs;
- prints each retired ref and its old OID, and writes a JSON land record under
  `<git-common-dir>/apocha/lands/` with tips, commits, retirements, and reasons for kept refs;
- never pushes.

Receipts are notes on commits, independent of batch refs. After retirement,
`apocha receipt <commit-oid>` still verifies the landed commit. To restore a batch ref,
take its name and old OID from the land output or record and run
`git update-ref <ref> <old-oid> ""`. The empty expected old value prevents overwriting
a ref recreated since retirement.

## Legacy receipts

Version 3 receipts with the old schema ID `panagent.receipt.v3` still verify, alongside
`apocha.receipt.v3` receipts.

Versions 1 and 2 were written by the harness Apocha was extracted from. They verify with the
same commit checks and the same recomputed digest, so a repository that switches to Apocha and
keeps its batch prefix and notes ref can land across both histories.

## Limits

- Notes are not signed. Anyone with write access can add a note, and a forged note that matches
  the commit's real content and passes the schema would verify. Signing (SSH or Sigstore) and an
  in-toto envelope are planned.
- Notes do not travel with `git push` by default. Push the notes ref explicitly
  (`git push origin refs/notes/apocha`) if receipts should be shared.
