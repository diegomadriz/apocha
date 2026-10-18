# Manual commits and baseline ledger

Snapshot: **2026-10-18**. Owner-approved OQ5 option 2 (2026-10-18).
This public ledger records manual/unreceipted commits and verification baseline moves.
Preserve the original commits, receipt signatures, notes, and history; do not rewrite
history or fabricate receipts to cover a manual commit.

## Historical signing baseline

The historical signing baseline is
`12e2bad0a6f9f698100953b1f9053dbf6bbd63fe` — **Require signed receipts**,
2026-10-17. The signature requirement begins there. Git range syntax excludes
that baseline commit itself: `12e2bad..main` checks commits after it.

As of the task base for this snapshot, there are **no manual commits after
12e2bad**. The original signed range
`apocha verify-range 12e2bad..main --require-signed` is valid at that base.
Keep this original range independently verified; a later CI baseline does not
replace its historical assurance.

## Ledger

| Manual commit (full SHA) | Date | Operator | Reason / subject |
|---|---|---|---|
| `1ab605fd86da5609c2853f65969d750b0d3768d1` | 2026-10-17 | Diego Ramirez | Authorise the receipt signing key |

This bootstrap key-authorization row **predates 12e2bad** and is included for
trust context. It is outside the original signed range and has no retroactive
signed-receipt claim. Every manual commit and baseline move since the historical
baseline belongs in this ledger; currently there are none.

| Pending item | Value / status |
|---|---|
| Owner manual CI commit full SHA | **Pending** — commit does not exist yet |
| Owner manual CI commit date | **Pending** |
| GitHub Actions repository variable `RECEIPTS_BASELINE` | **Pending** — value not configured; forward CI coverage not enforced yet |

These placeholders do not record a completed commit or baseline move. This
snapshot does not claim that CI is active, pushed, or green.

## Option 2: explicit forward CI baseline

After the owner's manual CI commit exists, enter its full SHA, date, operator,
and reason in the ledger. That commit becomes the explicit forward CI baseline:
store its full SHA outside Git in the GitHub Actions repository variable
`RECEIPTS_BASELINE`, and record the reviewed baseline move here through Apocha.
The owner manages this variable; it is not a cryptographic attestation.

Automatic CI will verify only commits **after** that baseline. The CI commit
excludes itself through range syntax, avoiding an own-SHA paradox. That coverage
does not verify the bootstrap commit or prior history. Preserve the independently
verified original signed range separately, including its verified tip's full SHA
when recording historical verification; do not extend that range across the
manual CI commit and claim it still passes.

Later manual commits must instead go through Apocha, or be explicitly entered
in this ledger with reason, date, and operator together with a reviewed baseline
move through Apocha. There are no automatic exemptions and no fabricated receipts.
A baseline move changes the coverage boundary and must remain visible for review.

## Reader verification

Fetch the receipt notes before verifying:

```sh
git fetch origin refs/notes/apocha:refs/notes/apocha
```

At the task base, verify the original signed range using the full baseline SHA:

```sh
apocha verify-range 12e2bad0a6f9f698100953b1f9053dbf6bbd63fe..main --require-signed
```

After the manual CI commit exists, use the recorded historical tip's full SHA
instead of `main` to recheck the original range without including that manual
commit. Full SHAs are preferred for both range endpoints.

Independently check this ledger and the GitHub Actions repository variable
`RECEIPTS_BASELINE`. Confirm that its full SHA matches the reviewed forward
baseline and inspect any intervening manual entries and baseline moves. Once
configured, substitute that full SHA for `<baseline>` below:

```sh
apocha verify-range <baseline>..main --require-signed
```

The placeholder is not a configured value. A successful forward-range check
says nothing about excluded commits. Check authorized signing keys at the target
tip as described in [Receipts](receipts.md#checking-signatures), and keep the
historical and forward verification results distinct.
