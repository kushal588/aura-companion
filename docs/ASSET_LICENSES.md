# Asset licences

## What this repository ships

**No third-party avatars, animation clips, voices or artwork.** Not a sample VRM, not a VRMA, not a voice clone.

Reasons: redistribution rights for character models are rarely granted, a shipped avatar would make the repository's
licence misleading, and an unlicensed asset in a public repository is a legal problem for everyone who clones it.

Instead the app builds a **procedural placeholder character** in code (`src/avatar/proceduralAvatar.ts`) and the icon is
generated (`scripts/generate-icons.mjs`). Both are MIT, like the rest of the code.

## What you import

Anything you import stays on your machine, but its licence still applies to you:

| Asset type | Typical situation |
|---|---|
| `.vrm` avatar | VRM models have their own licence and usage terms (often with conditions on commercial use, modification or redistribution). Check the model's page. |
| `.vrma` animation | Animations are separately licensed from the model. |
| Voice | Only use the provider's own prebuilt voice names, or voices you have the right to use. Do not clone a real person's voice without permission. |
| Character prompt | Yours, unless you copy it from somewhere with its own terms. |

AURA never re-uploads, redistributes or transmits your imported files. It reads them locally to render the character.

## Third-party dependencies

See `NOTICE` for the dependency list and attributions. The code dependencies are MIT/Apache-2.0/BSD-style licences,
except:

- **Three.js** (MIT) and **`@pixiv/three-vrm` / `@pixiv/three-vrm-animation`** (MIT) — rendering and VRM/VRMA loading.
- **Gemini API** — not a dependency but a service you sign up for; Google's terms apply to everything you send.

## If you want to ship your own character pack

1. Verify the avatar, animations and voice permit redistribution and commercial use.
2. Add the licence text next to the assets and reference it from the character manifest (`"license"` field).
3. Never include assets whose licence you cannot show.
