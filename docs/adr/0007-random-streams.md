# ADR-0007: Random streams with xoshiro128** derived per entity key

- Status: accepted
- Date: 2026-10-14
- Deciders: Claude, owner on review

## Context and problem statement

Plan section 4 asks for one master seed, with each entity (machine, failure mode, operator) drawing from its own derived stream, "so adding a machine does not change the random sequence of the others". `Math.random` cannot be seeded and is banned in deterministic code (ADR-0006). Which generator, and how is a stream derived from the seed?

## Considered options

Generators:

1. Mulberry32: tiny, but only 32 bits of state, so streams cycle after 2^32 draws.
2. PCG32: excellent, but needs 64-bit multiplication, which is slow in JavaScript without `bigint`.
3. xoshiro128**: 128 bits of state, only 32-bit operations (`Math.imul`, shifts), passes BigCrush, with a public reference implementation.

Stream derivation:

- A. Advance one generator and hand out consecutive blocks: the order in which entities ask for streams would change their numbers.
- B. Hash the entity key together with the seed and expand the hash into a fresh 128-bit state.

## Decision outcome

Chosen: **xoshiro128\*\*** with **derivation B**.

- `streamState(seed, key)`:
  - starts from `z = FNV-1a(key) XOR fmix32(seed)`;
  - then fills the four state words with `fmix32(z += 0x9E3779B9)`, a SplitMix-style expansion using MurmurHash3's finalizer.
  - `fmix32` is a bijection with `fmix32(0) = 0`, so at most one word can be zero and the state is never all zero.
- A stream depends only on (seed, key). Creating, removing or reordering other streams never changes it.
- `RandomSource.stream(key)` refuses to issue the same key twice: two entities sharing a stream would be silently correlated.
- Keys are paths that name the entity and its purpose, for example `cnc-01/failure/spindle-overload` and `asm-01/operator/op-a1/speed`.
- `nextFloat()` returns `nextUint32() / 2^32`, a value in [0, 1) with 32-bit resolution, which is more than enough for every distribution in the model.
- Seeds are unsigned 32-bit integers.

Verification:

- The generator matches the authors' reference C implementation (`xoshiro128starstar.c` from prng.di.unimi.it) on two published-state vectors.
- `fnv1a32` matches the published FNV-1a test vectors.
- The derivation was cross-checked against an independent Python implementation and is locked by an inline snapshot.

### Consequences

- Good: reproducible per-entity randomness that survives model changes; adding a seventh machine leaves the golden scenarios of the other six untouched.
- Good: pure 32-bit arithmetic, fast, no dependencies.
- Bad: changing a key, for example renaming a failure code, changes that entity's sequence. Golden snapshots will show it, and that is intended.
- Bad: the derivation is project-specific, not a published standard. That is acceptable because it only seeds a standard generator, and it is locked by tests.
