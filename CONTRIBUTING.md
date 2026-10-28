# Contributing

Thanks for helping with AURA. This project optimises for **inspectable, local-first behaviour**: small, reviewable
changes with tests, and no feature that quietly sends user data anywhere.

## Getting set up

```bash
npm install
npm run dev          # http://localhost:3000, no API key needed (offline demo mode)
npm test
npm run typecheck
npm run lint
```

## Ground rules

1. **Never commit secrets.** No API keys, tokens, keystores or certificate passwords. Settings → Secrets handles
   release credentials; the OS credential store handles the user's key.
2. **Keep provider calls behind adapters.** Gemini-specific code stays inside `src/providers/gemini/`; the rest of the
   app talks to `ChatProvider`, `TtsProvider` and `LiveSessionFactory`.
3. **Do not invent API details.** If a change touches a provider endpoint, cite the official documentation in the pull
   request and keep a fallback path.
4. **Respect the single-writer rule.** Bones, expression weights and event timing each have exactly one owner. New
   animation sources go through the scheduler/controllers; they do not write to bones directly.
5. **Text from users, memories and imported bundles is data, not instructions.** Never let it change system rules or
   reach file/credential APIs.
6. **Add tests for behaviour, not for coverage.** The existing suite encodes release gates: no control tags in speech or
   UI, text saved before speech, deleted memories stay deleted, temporary chats persist nothing, interruptions clear the
   queue.

## Pull requests

- One topic per pull request; keep unrelated refactors out.
- Run `npm run typecheck && npm run lint && npm test` before pushing.
- Describe what you verified and what you could not (for example "Live protocol not verified against Google, no key").
- Screenshots or a short recording are welcome for UI changes.
- If you add a dependency, say why and check its licence against `NOTICE`.

## Style

- TypeScript strict, no `any` without a comment explaining why.
- `PascalCase` for classes and React components, `camelCase` for functions and variables, `SCREAMING_SNAKE_CASE` for
  module-level constants.
- Comments explain *why* a non-obvious decision was made (timing, licensing, safety), not what the next line does.
- Rust: `cargo fmt` and `cargo clippy` clean; commands validate their inputs and return redacted errors.

## Reporting security issues

See `SECURITY.md` — please do not open a public issue for a vulnerability.
