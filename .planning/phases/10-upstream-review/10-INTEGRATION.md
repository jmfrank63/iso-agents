# Phase 10: PR amended with speedup

**Verdict:** COMPLETE — PR #85 HEAD = multi-run @ 6cf7c19 (review fixes d540d0b + incremental speedup rebased), pushed to jmfrank63/ts-rust.

## Final state
- Fork: multi-run @ 6cf7c19 (PR HEAD), multi-run-incr force-synced to 6cf7c19 (history rewritten: 79ffdb0 was pre-rebase)
- Artifact: 5,241,049 B, sha256 830cf48846922473209ea827cbda4cbc155a2c05a103230310cb0fa0df968ab0 (pinned 1.95.0, build.sh)
- iso-agents: artifact re-shipped, identity ts-rust@multi-run/6cf7c19 (wasm), 116/116 unit, wasm harness 55 ok (contracts updated: replay ~0ms allowed; operator-chain guest → 500 recycle; deep-nested → 400 via v6 guard)
- PR body corrected per review (scope, memory characterization + real curves, host contract = none, npm runTsc future work, #99 pointer); measured-speedup comment posted
## Review response status
- Blocker 1 (mtime contract): content-hash keying — host contract NONE (their memoryFileSystem mtime=0 repro covered by regression test)
- Blocker 2 (memory): eviction + freeable first parses — new-path 302→20.2 KiB/run; recycle documented as bound
- Blocker 3 (case-flag): rejection mirroring cwd — regression test
- Smaller points: wrap location + set_thread_program acknowledged in-code; --incremental parse-reuse documented
