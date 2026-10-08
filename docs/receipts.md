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
| `tests.on_base` | Added and modified test files run against base code, when `tests.run_files` is configured. |
| `tests.test_changes` | Optional evidence under `justified`: path, modified/deleted change, `old_on_candidate`, `new_on_base` for modified files, and necessary/unnecessary/weakened/error verdict. Also stored in verification evidence and run state, and sent to review with each file diff. Older receipts without it still verify. |
| `criteria_evidence` | Full implementer evidence array, indexed by 1-based acceptance criterion; stored independently of verification in run state and run records and paired with criterion text for review. Optional so old receipts still verify. |
| `review` | `PASS` and the number of findings across the run |
| `review_independence` | Configured `implementer_provider`, `reviewer_provider`, and boolean `independent` (providers differ). Written on every new receipt; optional so older receipts still verify. |
| `repairs`, `agent_invocations`, `retries` | How much work it took |
| `runtimes` | Adapter, adapter version, provider, and model for each role |
| `config_digest` | The project config at the base commit |
| `runtime_config_digest` | The final runtime config used |
| `runtime_config_digests` | Optional ordered config history, included only when the runtime config changed during the run |
| `policy_digest` | Prompts, tool definitions and limits, workflow definition, and package version |
| `governance` | Whether governance edits were allowed, by whom (Git identity), and why |

The run record keeps `runtime_config_digests` starting with the start config digest,
appending each resume's digest only when it differs from the last entry. Returning to an
earlier config adds another entry. Its existing `runtime_config_digest` remains the start
digest for compatibility; the receipt's field remains the final digest. Receipts omit the
history when it has only one entry, preserving the existing receipt format and bytes.
Older receipts without this optional field still verify. Each `agent.started` and
`agent.finished` event records the active `runtime_config_digest` for that invocation.

Compare `policy_digest` and the full runtime config history (or `runtime_config_digest`
when history is absent) to compare the harness and configs used across runs.

Analytics counts runs with recorded role runtimes under `review_independence`:
`independent`, `same_provider`, or `unknown` when provider evidence is missing.
These counts use the runtimes recorded per run, rather than the current config.

Delivery metrics count integer repair values 0, 1, and 2 in their respective buckets.
Missing counts and all other values count under `unknown`; legacy `repair_attempts`
is used when `repairs` is absent.

## Verification

`apocha receipt <commit>` and `land` check, in order:

1. the note parses and matches the schema (v3), or the legacy shape (v1, v2);
2. `promoted_head` is the commit, and `tree` and `parents` match the commit object;
3. `base_commit` is the first parent;
4. **the candidate digest recomputed from Git** (`git diff base..commit`) equals
   `candidate_digest`, so the note cannot claim a different change than the commit holds;
5. every check passed and the review decision is `PASS`.

## SSH signatures

Runtime `signing: { "key": "~/.ssh/receipt_key", "principal": "operator@example.com" }`
signs every new receipt using offline `ssh-keygen -Y sign`. Keep the private key outside
the repository. Without this config, receipts remain unsigned.

The optional `signature` object contains `format: "ssh"`, `namespace: "apocha-receipt"`,
the principal, and armored SSH signature text. Signed bytes are canonical JSON of the
entire receipt excluding `signature`: recursively sorted object keys, no whitespace.
Temporary verification files live in a private directory removed after use.

`apocha receipt <commit>` reports `signature.status`: `valid`, `unsigned`,
`invalid`, or `unknown_signer`, with the claimed principal. Unsigned receipts still
pass consistency checks, including older receipts. Verification can use a specified Git
commit for trust; the receipt CLI uses HEAD.

## Landing

`apocha land <source> --target <branch>`:

- requires the target to be a first-parent ancestor of the source;
- with `--require-signed` or target config `receipts.require_signed: true`, requires
  valid signatures for all these commits; unsigned receipts fail with `unsigned_receipt`
  and bad or unauthorized signatures with `bad_signature`, naming the commit;
- reads the standard SSH allowed_signers file (`receipts.allowed_signers`, default
  `.apocha/allowed_signers`) from the target tip before landing, never the source;
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

- Without required signatures, anyone with repository write access can forge a consistent note.
  Use `--require-signed` or `receipts.require_signed` to reject these notes.
- A valid signature proves possession of an authorized signing key and protects receipt contents.
  It does not prove that checks really ran, that review was competent, or that the signing
  operator or key was uncompromised.
- Notes do not travel with `git push` by default. Push the notes ref explicitly
  (`git push origin refs/notes/apocha`) if receipts should be shared.
