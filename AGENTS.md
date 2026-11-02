## Tusk CMS

This site's editable content is managed in Tusk CMS (https://tuskcms.com).
The full agent guide is at https://tuskcms.com/llms-full.txt — read it before
changing anything below.

- Editable elements are marked with `data-tusk` / `data-tusk-list` attributes in
  the HTML. Add attributes only; never change layout, styles, markup order,
  class names or wording around them.
- This is a plain HTML site deployed from the repo root, so the build runs
  `node tusk-pull.mjs && node tusk-apply.mjs .` (`npm run build`). It writes
  published content into the marked HTML; the built site never talks to Tusk at
  runtime.
- Every read of published content has a fallback equal to the original text on
  the page, so the site builds before the first publish.
- `TUSK_SITE` and `TUSK_TOKEN` live in `.env` (git-ignored) and in the host's
  environment variables. TUSK_TOKEN is a secret: never print it, never commit it,
  never paste it into a committed file. `TUSK_ASSETS=tusk` so pulled photos are
  served at /tusk/ from the repo-root output.
- Publishing goes live via the host's deploy hook (set in Tusk under Manage →
  Going live). After changing which elements are marked, deploy and then re-scan
  in Tusk before the new fields appear in the owner's editor.
