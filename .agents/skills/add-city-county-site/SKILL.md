---
name: add-site
description: Creates a new tenant site for this project by duplicating /blueprint into a new folder under /sites/ in DA, registering it in the shared /metadata.json sheet (url, site-base, and a color-primary/secondary/accent palette extracted from a sample site the requester provides), swapping in that site's logo, and previewing the result. Use whenever a user wants to add a new city/county site to this repeatable demo — typically invoked as just a URL, e.g. "Add a site for https://www.cityname.gov". Do NOT use for creating a brand-new GitHub repo/DA project from scratch — that's the separate create-site skill.
license: Apache-2.0
metadata:
  version: "3.0.0"
---

# Add a New Tenant Site (blueprint → /sites/<slug>)

This project (`adobe-pubsec/city-county`) is a repeatable demo: `/blueprint`
holds the canonical content, and every folder under `/sites/` is a
standalone tenant site that reuses the same code but is skinned per-site via
`/metadata.json`. The header/footer (`blocks/header/header.js`,
`blocks/footer/footer.js`) and theme colors (`scripts/utils/site-theme.js`,
`styles/styles.css`) already read `site-base`, `color-primary`,
`color-secondary`, and `color-accent` from that sheet at runtime — this
skill's job is purely content-side: clone the folder, add the row, and
swap in the new site's own logo and colors.

This skill runs inside AEM Experience Workspace, where content operations
(copy, read, write, list, preview, publish against DA) are available as
native agent tools and are already authenticated — there is no separate
auth step and no custom scripting. Use whichever native content tool covers
each action below; the steps describe *what* needs to happen, not a
specific tool call.

**Audience:** the requester is typically a solutions consultant setting
this up to demo to a prospective city or county — the point is a fast,
convincing, correctly-branded standalone-looking site, not a production
launch. Keep that in mind when deciding how much to double-check vs. move
fast (e.g. confirming the derived site name/slug is cheap and worth doing;
publishing to production is not needed for a demo and should stay gated
behind explicit confirmation).

## When to Use This Skill

Use this skill when a user asks to:
- "Add a new site for \<city/county name>"
- "Duplicate the blueprint for \<name>"
- "Onboard a new tenant" in this specific repo

**Do NOT use this skill for:**
- Creating a brand-new GitHub repo / DA project from scratch — use the
  **create-site** skill instead. This skill only adds a folder *within* the
  existing `adobe-pubsec/city-county` DA project.
- Changing block code, header/footer logic, or theming plumbing — that's
  already implemented; see `scripts/utils/site-theme.js` and
  `blocks/header/header.js` / `blocks/footer/footer.js` if it needs
  revisiting.

## Related Skills

- **da-content** — background reference for DA's content model if you need
  to fall back to raw API calls (path rules, sheet JSON shape,
  preview/publish being a separate step from writing content). Not needed
  for the happy path when native tools are available.
- **scrape-webpage** — optional heavier-weight tool for Step 3 if a full
  screenshot pipeline is wanted instead of a single fetch.

---

## Step 0: Create a TodoList

1. Gather inputs (site URL or name/org/repo/color sample)
2. Clone `/blueprint` → `/sites/<slug>`
3. Extract brand assets: 3-color palette and logo
4. Update `/metadata.json`
5. Preview (and, once confirmed, publish)
6. Hand off

---

## Step 1: Gather Inputs

**Expect the common case to be a single URL** — e.g. "Add a site for
https://www.harrisonburgva.gov". Treat that one URL as doing double duty:

1. **Site name/slug** — fetch the page and derive the name from `<title>`,
   an `og:site_name` meta tag, or a prominent "City of ___" / "County of
   ___" heading. Slugify it for the folder name: lowercase, spaces/
   underscores → dashes, strip anything outside `[a-z0-9-]` (e.g. "City of
   Harrisonburg" → `harrisonburg`, "Rockingham County" → `rockingham-county`).
   **Confirm the derived name and slug with the user before proceeding** —
   government sites often have a formal name that differs from what's
   colloquially expected.
2. **Colors and logo** — this same URL is the input to Step 3's brand
   extraction (palette *and* logo). Don't ask for a separate sample or a
   separate logo file when a URL was already given — extract both from it.

Only fall back to asking explicit questions if the request doesn't include
a URL — e.g. the requester names a site with no link, provides hex codes
directly, or attaches a logo/brand image instead. In that case ask for
whatever is missing (site name, and a color/logo sample — URL, image, or
hex codes). Never invent colors, and never fabricate a logo, if none can
be found.

**Org/repo:** default to `adobe-pubsec/city-county` (this project) unless
the user says otherwise.

Store as `{{ORG}}`, `{{REPO}}`, `{{SLUG}}`.

---

## Step 2: Clone `/blueprint` → `/sites/<slug>`

Copy the entire `/blueprint` folder to `/sites/{{SLUG}}`, preserving
structure (pages, fragments, media). If a native "copy folder" tool is
available, prefer it. Otherwise, list `/blueprint` recursively and
read+write each item individually to the mirrored path under
`/sites/{{SLUG}}`.

Either way, after copying: **rewrite literal `/blueprint` path references
to `/sites/{{SLUG}}`** inside the copied HTML/JSON documents — internal
links, image `src`, fragment references, etc. A plain string replace
(`/blueprint` → `/sites/{{SLUG}}`) across the copied text content is
sufficient; don't touch binaries.

Note: header/footer and theme colors do **not** need path-rewriting beyond
this — they already resolve relative to `site-base` at runtime (see
`blocks/header/header.js`, `blocks/footer/footer.js`,
`scripts/utils/site-theme.js`). This step only fixes literal `/blueprint`
references inside the copied content itself.

**Verify:** spot-check a page or two under `/sites/{{SLUG}}` for
leftover `/blueprint` references before moving on.

---

## Step 3: Extract Brand Assets — Colors and Logo

Both come from the same source (the URL gathered in Step 1, or whatever
image the requester attached instead).

### 3a. Color palette

Goal: 3 hex colors — `color-primary`, `color-secondary`, `color-accent` —
matching the tokens already consumed by `styles/styles.css`
(`--primary`, `--secondary`, `--accent`).

**If the requester already gave hex codes:** use them directly, skip to 3b.

**If given a URL:**
1. Check for an explicit signal first — fetch the page and look for
   `<meta name="theme-color" content="...">`, or a linked stylesheet
   declaring CSS custom properties like `--primary`/`--brand`/`--color-*`.
   These are the most reliable source when present.
2. Otherwise, fetch a screenshot (the **scrape-webpage** skill's
   `analyze-webpage.js` captures a full-page screenshot; a simpler `WebFetch`
   pass on the HTML can also surface obvious color declarations).
3. Visually inspect the page/screenshot and assign roles:
   - **Primary** — the dominant brand color (header/nav background, logo,
     primary buttons).
   - **Secondary** — a supporting color (links, secondary buttons, hover
     states).
   - **Accent** — a bright, sparingly-used pop color (CTA highlights,
     badges, active states).

**If given an image directly:** use the Read tool to view it and apply the
same role assignment by eye.

**If fewer than 3 distinct brand colors are found:** don't invent an
accent from nothing — derive it from primary (e.g. a more saturated/lighter
variant), or ask the requester which role is ambiguous. Note this checklist
matches how `blocks/quick-links/quick-links.css` and `blocks/alert/alert.css`
actually use these tokens (primary/secondary as solid fills, accent as a
lighter pop against a primary background) — keep that contrast relationship
in mind rather than picking three arbitrary hexes.

Confirm the 3 hex values with the user before writing them anywhere.

### 3b. Logo

Goal: replace the blueprint's placeholder logo with the new site's own mark
in the copied header fragment (`/sites/{{SLUG}}/fragments/nav/header`) —
the brand section that `blocks/header/header.js` `decorateBrandSection`
turns into `.brand-logo`.

1. **Locate the clearest logo asset** on the source page — prefer an
   `<img>`/`<svg>` in the site's own header/nav (look for `alt` text or a
   class/id containing "logo", or the element wrapping the homepage link).
   Fall back to `apple-touch-icon` or a large favicon only if no real nav
   logo exists — don't settle for a 16×16 favicon when a proper logo image
   is available.
2. **Prefer vector over raster** — an SVG logo scales cleanly into the
   header's `.brand-logo` sizing; if only raster is available, take the
   highest-resolution version referenced (not a pre-scaled thumbnail).
3. **Download the logo** from its resolved absolute URL.
4. **Upload it into `/sites/{{SLUG}}`'s DA content**, respecting binary
   format/size rules (SVG cap 40 KB, raster cap 20 MB — see `da-content` if
   you need the full rule set), then **replace the logo reference** inside
   the copied header fragment's brand section with the new asset.
5. **Set the `logo-is` aspect-ratio property.** The blueprint's brand
   section has a section-metadata property named `logo-is` directly beneath
   the logo, defaulted to `square` (matching the blueprint's own square
   placeholder). Check the extracted logo's actual width vs. height and
   update that property to match:
   - width > height → `wide`
   - height > width → `tall`
   - width ≈ height → leave as `square`

   Get the dimensions from the source `<img>`'s intrinsic size (not its
   rendered/CSS size) or from the downloaded file itself; don't guess from
   how it looks scaled down on the source page's nav.
6. **If no usable logo can be found**, tell the user and leave the
   blueprint's placeholder logo (and its `square` `logo-is` value) in place
   rather than guessing or fabricating one.

---

## Step 4: Update `/metadata.json`

Read the current sheet, then append (or update, if a row for this slug
already exists) a row — without touching any other site's existing row:

```json
{
  "url": "/sites/{{SLUG}}/**",
  "site-base": "/sites/{{SLUG}}",
  "color-primary": "{{PRIMARY_HEX}}",
  "color-accent": "{{ACCENT_HEX}}",
  "color-secondary": "{{SECONDARY_HEX}}"
}
```

Write the whole sheet back. **Verify:** re-read `/metadata.json` and
confirm the new row is present alongside every prior row.

---

## Step 5: Preview (and, only if confirmed, Publish)

Preview every path copied in Step 2, plus `/metadata` itself, so the new
site and its palette are reachable at `aem.page`.

**Publishing is a separate, production-visible action** — ask the user to
confirm before publishing to `aem.live`. Don't publish automatically.

---

## Step 6: Hand Off

Tell the user:

> **New site ready:** `{{SLUG}}`
>
> - **Preview:** `https://main--{{REPO}}--{{ORG}}.aem.page/sites/{{SLUG}}/`
> - **Browse in DA:** `https://da.live/#/{{ORG}}/{{REPO}}/sites/{{SLUG}}`
> - **Metadata row:** `color-primary: {{PRIMARY_HEX}}`,
>   `color-secondary: {{SECONDARY_HEX}}`, `color-accent: {{ACCENT_HEX}}`
> - **Logo:** swapped into the header (`logo-is: {{wide|tall|square}}`) —
>   or: left as the blueprint placeholder — no usable logo found on the
>   source site
>
> Not yet published to production — let me know when you want that pushed
> live.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Copied pages still say `/blueprint/...` internally | Rewrite step skipped, or a link used an absolute URL with a different host | Grep the copied content for `/blueprint` and fix remaining references |
| Metadata write fails | `/metadata.json` doesn't exist yet | Create it first with a single row (the `/blueprint` one) before running this skill |
| Preview returns 404 | Path wasn't actually copied, or wrong branch | Re-check Step 2 output; confirm branch name (`main`) |
| Colors look wrong on preview | Site-theme override didn't apply | Confirm the row's `url` glob (`/sites/{{SLUG}}/**`) actually matches the previewed path — see `scripts/utils/site-config.js` |
| Logo still shows the blueprint placeholder | Logo swap step was skipped, or upload/reference update failed | Re-check the header brand section under `/sites/{{SLUG}}/fragments/nav/header` for the new asset reference |
| Logo looks blurry or oversized | A low-res or pre-scaled thumbnail was used instead of the real nav logo | Re-locate the source site's actual header logo (or SVG) rather than a favicon |
| Logo looks squished or oddly cropped | `logo-is` wasn't updated to match the logo's actual aspect ratio | Re-check the logo's real width/height and set `logo-is` to `wide`/`tall`/`square` accordingly |

## Reference

- This project's runtime theming: `scripts/utils/site-config.js`,
  `scripts/utils/site-theme.js`, `blocks/header/header.js`,
  `blocks/footer/footer.js`
