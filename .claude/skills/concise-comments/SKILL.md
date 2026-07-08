---
name: concise-comments
description: Concise comments and documentation style for code comments, docstrings, and module/file docs. Use when writing, editing, or reviewing comments, doc-comments, struct/field docs, constants, or entry (lib/index) files. Encodes Yoni-Starkware's review preferences — concise, present-tense, no history or design-doc references.
---

# Concise comments

Yoni-Starkware's review preferences. Applies when writing, editing, or
reviewing comments, doc-comments, module/file docs, or constants — any
language (examples are Cairo/TS).

Rule of thumb: keep it short, describe the present, don't narrate history.

## Rules

1. **Present, not history.** No "old / used to / removed / retired".
   - BAD: `// The old claim path that used to live here was REMOVED.`
   - GOOD: `// Forwards a pool withdrawal to CCTP.`

2. **No design-doc references.** Don't cite plans/specs in code.
   - BAD: `// Attaches the forwarding hook. bridge-plan.md #9.`
   - GOOD: `// Attaches the forwarding hook so Circle submits the mint.`

3. **Don't re-document external interfaces.** Link to theirs.
   - BAD: `/// Same as deposit_for_burn but appends hook_data... panics if empty.`
   - GOOD: `/// See TokenMessengerV2::deposit_for_burn_with_hook.`

4. **No duplicated docs.** Document once — not on both trait decl and impl.

5. **Entry files hold only module declarations.** Move types/impls out of
   `lib.cairo` / `index.ts` / `mod.rs`; leave `mod`/re-export lists.

6. **Short per-field comments, not struct-level essays.**
   - GOOD: `// Destination chain (e.g. Ethereum, Polygon).` above the field.

7. **Constants: state the meaning AND the alternative.**
   - BAD: `/// Permissionless mint. const CALLER: u256 = 0;`
   - GOOD: `/// 0 = anyone may submit the mint; nonzero restricts to that caller.`

8. **Names reflect content** (files, modules, dirs); group error constants in
   their own `errors` file.

9. **Enforce in CI**, not in review nags: `scarb fmt`, prettier, eslint.
