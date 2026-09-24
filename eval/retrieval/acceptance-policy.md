# Retrieval Change Acceptance

## Tuning

Retrieval tuning must meet the frozen Phase16C gate: held-out MRR@5 or Recall@5 improves by at least `+0.02` absolute, the companion metric stays within its frozen tolerance, and held-out class/family protections and correctness invariants pass. Recall@10 does not substitute for this gate.

## Correctness fixes

A retrieval correctness fix may omit aggregate uplift only when a general source-level defect is reproduced by a prospective fixture before the fix and the fix repairs that invariant. It must preserve existing correctness invariants, avoid regression in held-out MRR@5 and Recall@5, lose no more than `0.05` Recall@10 in any held-out query class or fixture family, remain deterministic, preserve semantic fallback, SCIP, TaskContext, and B1.1 contracts, and introduce no unexplained canonical full-suite failure identity. Update a test that expected defective behavior only when its replacement asserts the corrected invariant.

Classify a change by its demonstrated defect before reviewing aggregate results. Missing the tuning gate alone does not make a tuning change a correctness fix.
