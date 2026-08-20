SKILL.md
---
name: add-city-county-site
description: Creates a new tenant site for the adobe-pubsec/city-county demo by duplicating /blueprint into /sites/<slug> in DA (via the DA Source API), populating it with real (or localized-fallback) news and events content, registering it in /metadata.json with a color-primary/secondary/accent palette and logo extracted from a sample site the requester provides, and previewing the result. Use whenever a user wants to add a new city/county site to this repeatable demo — typically invoked as just a URL, e.g. "Add a site for https://www.cityname.gov". Do NOT use for creating a brand-new GitHub repo/DA project from scratch — that's the separate create-site skill.
license: Apache-2.0
metadata:
  version: "5.1.0"
---

# Add a New Tenant Site (blueprint → /sites/<slug>)

This project (`adobe-pubsec/city-county`) is a repeatable demo: `/blueprint`
holds the canonical, host-agnostic content, and every folder under `/sites/`
is a standalone tenant site that reuses the same code but is skinned per-site
via `/metadata.json`. The header/footer (`blocks/header/header.js`,
`blocks/footer/footer.js`) and theme colors (`scripts/utils/site-theme.js`,
`styles/styles.css`) already read `site-base`, `color-primary`,
`color-secondary`, and `color-accent` from that sheet at runtime — this
skill's job is purely content-side: clone the folder, populate news/events,
add the metadata row, and swap in the new site's own logo and colors.

News and events are shared, cross-tenant query-indices
(`/news-index.json`, `/events-index.json` — see `helix-query.yaml`), not
per-site files. `scripts/utils/query-index.js`'s `filterBySite()` filters
those combined indices down to the current site by `path` prefix at read
time, so anything this skill publishes under `/sites/{{SLUG}}/news/**` or
`/sites/{{SLUG}}/events/**` shows up automatically in that site's news
blocks and search — no separate per-site index config needed.

## Execution model — READ THIS FIRST

This skill runs in **SLICC**. There are **no native "content tools"** and
you are **not pre-authenticated**. Every content operation is a **DA Source
API call made over the shell** (`admin.da.live` for source/list, plus
`admin.hlx.page` for preview), using an Adobe IMS token you obtain yourself.
The DA API contract, sheet JSON shape, and binary rules are in the
**da-content** skill — load it alongside this one.

Base endpoints (substitute `{org}=adobe-pubsec`, `{repo}=city-county`):

- List a folder: `GET https://admin.da.live/list/{org}/{repo}/<path>`
- Read a doc/binary: `GET https://admin.da.live/source/{org}/{repo}/<path>`
- Write a doc/binary: `PUT https://admin.da.live/source/{org}/{repo}/<path>`
  with `-F "data=@<file>;type=<mime>"`
- Preview a path: `POST https://admin.hlx.page/preview/{org}/{repo}/main/<path>`

All calls carry `-H "Authorization: Bearer $TOKEN"`.

**Audience:** the requester is typically a solutions consultant setting this
up to demo to a prospective city or county — the goal is a fast, convincing,
correctly-branded standalone-looking site, not a production launch. Confirm
the derived slug and the palette (both cheap) before writing; keep publishing
to `aem.live` gated behind explicit confirmation.

## When to Use This Skill

- "Add a new site for \<city/county name>" / "Add a site for \<URL>"
- "Duplicate the blueprint for \<name>"
- "Onboard a new tenant" in this specific repo

**Do NOT use for:** creating a brand-new GitHub repo / DA project from scratch
(use **create-site**), or changing block code / theming plumbing (already
implemented — see `scripts/utils/site-theme.js`, `blocks/header/header.js`,
`blocks/footer/footer.js`).

## Related Skills

- **da-content** — REQUIRED. DA content model, path rules, sheet JSON shape,
  binary format/size caps, and the preview-is-separate-from-write rule.
- **da-auth** — fallback if `oauth-token adobe` does not yield a usable token.
- **scrape-webpage** — for sourcing real news/events content and brand
  extraction from the requester's URL (Steps 5 and 6a).

---

## Step 0: Create a TodoList

1. Authenticate to DA
2. Gather inputs (site URL or name/color sample)
3. Enumerate & clone `/blueprint` → `/sites/<slug>` (docs **and** binaries)
4. Rewrite paths, strip host prefixes, AND replace the placeholder entity name
5. Populate news and events (real content if found, localized fallback if not)
6. Extract brand assets: 3-color palette, logo, and a location hero image
7. Update `/metadata.json`
8. Preview (and, once confirmed, publish)
9. Hand off

---

## Step 1: Authenticate

Obtain an Adobe IMS token and allow-list the DA domains for the proxied
transport:

```bash
TOKEN=$(oauth-token adobe | tr -d '[:space:]')
oauth-domain add adobe admin.da.live
oauth-domain add adobe content.da.live
oauth-domain add adobe admin.hlx.page
```

If `oauth-token adobe` returns nothing usable, run the **da-auth** skill
first, then re-read the token. Verify with a cheap call:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "https://admin.da.live/list/adobe-pubsec/city-county"
# expect 200
```

---

## Step 2: Gather Inputs

**Expect the common case to be a single URL** — e.g. "Add a site for
https://www.wake.gov". That one URL does triple duty:

1. **Site name/slug** — fetch the page; derive the name from `<title>`,
   `og:site_name`, or a prominent "City of ___" / "County of ___" heading.
   Slugify: lowercase, spaces/underscores → dashes, strip anything outside
   `[a-z0-9-]` (e.g. "Wake County Government" → `wake-county`).
   **Confirm the derived name and slug with the user before proceeding.**
2. **Colors and logo** — the same URL is the input to Step 6's extraction.
3. **News and events content** — the same URL is also the input to Step 5's
   sourcing pass.

Don't ask for separate samples for any of the above when a URL was given —
extract everything from it.

Only fall back to explicit questions if no URL is given (named site with no
link, hex codes provided directly, or a logo image attached). Never invent
colors, never fabricate a logo, and never fabricate news/events content.

Also capture **`{{ENTITY}}`** — the proper display name that replaces the
blueprint's placeholder in Step 4 (e.g. "Wake County", "City of
Harrisonburg"). This is the confirmed site name without a trailing
"Government"/"Home". Confirm it if the formal vs. colloquial form is
ambiguous.

Store `{{ORG}}=adobe-pubsec`, `{{REPO}}=city-county`, `{{SLUG}}`, `{{ENTITY}}`.

---

## Step 3: Clone `/blueprint` → `/sites/<slug>` (docs AND binaries)

The blueprint contains **HTML documents AND binary media** (logos live in a
hidden `.header/` folder as image files). A doc-only copy will leave the new
site with broken/placeholder images. You must copy **both**.

1. **Enumerate the blueprint tree recursively.** `GET /list/...` returns a
   mix of files (they carry an `ext`) and folders (no `ext`); recurse into
   every folder, including hidden `.`-prefixed ones like
   `/blueprint/fragments/nav/.header`:

   ```bash
   # list a folder
   curl -s -H "Authorization: Bearer $TOKEN" \
     "https://admin.da.live/list/{{ORG}}/{{REPO}}/blueprint/<subpath>"
   ```
   Build a full list of every file path under `/blueprint`. This necessarily
   includes `/blueprint/news/**` and `/blueprint/events/**` — those example
   articles/events come along for free here and are what Step 5's fallback
   builds on.

2. **For each file:** `GET` the source, then `PUT` it to the mirrored path
   under `/sites/{{SLUG}}/...`.
   - **HTML/JSON (text):** apply the rewrites in Step 4 *before* PUT, and
     send `type=text/html` (or `application/json`).
   - **Binaries (png/svg/jpg/webp/pdf):** copy bytes verbatim, send the
     correct MIME (`image/png`, `image/svg+xml`, …). **Do not** run text
     rewrites on binaries. Respect the caps in **da-content** (SVG ≤ 40 KB,
     raster ≤ 20 MB).

**Verify:** `GET /list/.../sites/{{SLUG}}` and confirm the tree mirrors the
blueprint (same files, including the `.header` binaries and the `news`/
`events` folders).

---

## Step 4: Rewrite copied text content

Two rewrites, applied to every copied **text** document (not binaries):

1. **`/blueprint` → `/sites/{{SLUG}}`** — internal links, `src`, fragment
   references, etc. A plain string replace is sufficient.
2. **Fix absolute EDS host prefixes — but treat links and images
   DIFFERENTLY.** Foreign hosts (e.g. `…--jfoxx.aem.live`,
   `…--chrissands.aem.live`) must not leak in, but **image `media_*`
   references are NOT the same as nav links** and must be handled separately.

   > ⚠️ Lesson learned: a blanket "strip every `main--…--….aem` host"
   > breaks `media_*` image references — a bare `/media_<hash>` renders on
   > the live page but **fails in the DA editor**. Always distinguish
   > **links → relative** from **images → canonical absolute host**, and
   > never touch `content.da.live` URLs (those are real DA media/hero refs,
   > handled in Steps 5 and 6c).

   - **Nav / content links** (`…aem.live/departments`, etc.) → strip to a
     **relative** path so they resolve on any host:
     ```bash
     # links only: an aem host followed by a path that is NOT /media_
     sed -i -E 's#https?://main--[a-z0-9-]+--[a-z0-9]+\.aem\.(live|page)(/(?!media_)[^"'"'"']*)#\2#g' <file>
     ```
   - **Image `media_*` references** (`src=`/`srcset=` pointing at
     `…/media_<hash>.<ext>`) → rewrite to an **absolute URL on THIS
     project's own host** (foreign-host media, and any accidental
     root-relative `/media_`):
     ```bash
     CANON="https://main--{{REPO}}--{{ORG}}.aem.live"
     sed -i -E "s#https?://main--[a-z0-9-]+--[a-z0-9]+\.aem\.(live|page)(/media_)#$CANON\2#g" <file>
     sed -i -E "s#(src|srcset)=\"/media_#\1=\"$CANON/media_#g" <file>
     ```
   - **`content.da.live` URLs** (hero/`.index` images, per-article images) →
     **leave as-is**; they are project-owned assets handled elsewhere. Do
     not strip them.

   Net effect: links become host-agnostic relative paths, while images keep
   a valid, resolvable absolute reference to this project's own media.

3. **Replace the placeholder entity name.** The blueprint carries a generic
   entity name that must become the new site's real one. Two forms appear in
   the content and **both** must be replaced (longest first, to avoid partial
   matches):
   - **`City County Government`** → `{{ENTITY}} Government`
     (e.g. `Wake County Government`)
   - **`City County`** → `{{ENTITY}}`
     (e.g. `Wake County`)

   `{{ENTITY}}` is the site's proper name derived in Step 2 (e.g. "Wake
   County", "City of Harrisonburg") — typically the confirmed site name
   *without* a trailing "Government"/"Home"/"Government Home". Apply the
   replacements in that order:

   ```bash
   sed -i "s#City County Government#{{ENTITY}} Government#g; s#City County#{{ENTITY}}#g" <file>
   ```

   These strings appear in the header brand (`fragments/nav/header.html`),
   the footer (`fragments/nav/footer.html`), and the homepage
   (`index.html`). **Confirm `{{ENTITY}}` with the user** if it isn't
   obvious from the source (formal vs. colloquial names differ — "Wake
   County" vs. "Wake County Government" vs. "County of Wake").

Note: header/footer and theme colors resolve relative to `site-base` at
runtime and need no further path-rewriting. This exact-string pass also
applies to the blueprint's example news/events articles copied in Step 3 —
but see Step 5 for the *additional*, broader locality-reword pass those
specifically need.

**Verify:** grep the copied text for leftover `/blueprint` references, for
any **foreign** `main--…--….aem` host strings (i.e. any host that is NOT
`main--{{REPO}}--{{ORG}}`), for root-relative `/media_` image refs, **and**
for the placeholder `City County` — all four counts must be 0. (Canonical
`main--{{REPO}}--{{ORG}}.aem.live/media_*` refs and `content.da.live` URLs
are expected to remain — those are correct.)

---

## Step 5: Populate News and Events

Steps 3–4 already gave the new site *working* news/event pages — the
blueprint's own example articles, cloned and generically de-placeholdered.
This step's job: replace that filler with real content from the source site
where possible, and make whatever's left over read as genuinely local where
it isn't.

### 5a. Try to source real content

Look for a News/Press Releases/Announcements section and an Events/Calendar
section on the source site (the URL from Step 2; `scrape-webpage` can help
pull full page content if a simple fetch isn't enough).

If found, for **news** and/or **events** independently:

1. Pick **4–5 real, current items** — genuine headlines/titles, dates,
   descriptions. Never invent facts to fill the count; use fewer if that's
   all that's genuinely there.
2. **Use an existing blueprint example as the structural mold.** Read one
   already-cloned page at `/sites/{{SLUG}}/news/<slug>.html` (or
   `/events/<slug>.html`) and mirror its exact shape — same Page Metadata
   block keys (`Title`, `Description`, `Image`, `Publication Date`,
   `Article:tag` for news; add `Start Date`/`Start Time`/`End Date`/
   `End Time`/`Location` for events — check the actual example, don't
   guess), same hero/lead-image placement, same body structure. Only the
   *content* changes — title, dates, description, tags, location, body
   copy, image. This is what `templates/news-article/news-article.js` and
   `templates/event-detail/event-detail.js` render, and what the
   `news`/`events` indices in `helix-query.yaml` select — matching the
   existing shape keeps both working without guesswork.
3. Either **overwrite** one of the already-cloned blueprint example pages
   with real content (reusing its path), or **create additional pages** at
   `/sites/{{SLUG}}/news/<new-slug>.html` / `/events/<new-slug>.html` cloned
   from that same structural mold if you want more than the blueprint
   provided one-for-one. Slugify new filenames the same way as the site
   slug.
4. **Images:** download from the source site and re-upload into the site's
   media, same as the logo step (Step 6b) — don't hotlink a third party;
   respect the size caps.
5. Dates: match whatever format the blueprint's own example already uses in
   its `Publication Date`/`Start Date` cell (see `tools/date-inserter` and
   the parsing comments in `blocks/news/news.js`/`blocks/events/events.js`
   for the accepted formats) rather than inventing a new one.

### 5b. Fallback — no real content found (in whole or in part)

For whichever of news/events couldn't be sourced from the requester's site,
leave the blueprint-derived copies from Steps 3–4 in place, but run one more
targeted pass on just `/sites/{{SLUG}}/news/**` and `/sites/{{SLUG}}/events/**`:

- **Reword generic locality references** — phrases like "the county",
  "county officials", "the city," etc. — to `{{ENTITY}}` (e.g. "the county"
  → "Wake County") so the articles read as genuinely local rather than
  obvious filler. This is broader than Step 4's exact-string
  `City County`/`City County Government` replacement: read each article in
  context and reword the locality mentions, don't blind-`sed` a fixed token
  that may not literally appear.
- **Don't fabricate specific facts** — real incidents, official names,
  statistics, addresses. Only reword the locality reference itself; leave
  the rest of the blueprint's placeholder narrative intact.

### 5c. Publish so the shared indices pick it up

`POST` a preview for every news/events path you touched in 5a/5b (new,
overwritten, or reworded) — same preview call as Step 8, but do it here so
`/news-index.json`/`/events-index.json` reflect the new site promptly
rather than waiting for the final full-site preview pass:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "https://admin.hlx.page/preview/{{ORG}}/{{REPO}}/main/sites/{{SLUG}}/news/<slug>"
# repeat per news/events path touched
```

Preview (not `aem.live` publish) is what populates the shared index on the
`aem.page` domain — confirmed empirically when testing `/sites/wake-county`.
Pushing to production `aem.live` still follows the same ask-before-publishing
rule as the rest of this skill (Step 8) — these pages go live together with
everything else, not ahead of it.

**Verify:** fetch `/news-index.json` and `/events-index.json` and confirm
rows with `path` under `/sites/{{SLUG}}/news/` and `/sites/{{SLUG}}/events/`
appear, and spot-check that no fallback article still reads with obviously
generic locality phrasing.

---

## Step 6: Extract Brand Assets — Colors and Logo

Both come from the URL in Step 2 (or an attached image).

### 6a. Color palette
Goal: `color-primary`, `color-secondary`, `color-accent` (map to
`--primary`/`--secondary`/`--accent` in `styles/styles.css`).

- **Hex codes already given?** Use them, skip to 6b.
- **URL given?**
  1. Check for explicit signals first: `<meta name="theme-color">`, or CSS
     custom properties (`--primary`/`--brand`/`--color-*`) in linked styles.
  2. Otherwise **open the page in the browser** (`playwright-cli open`) and
     read computed colors of brand elements (header/nav bg, links, buttons)
     — this is far more reliable than parsing static HTML, which often has no
     inline colors. Sample the most frequent non-black/white brand color as
     primary; a supporting color as secondary.
  3. Assign roles: **Primary** = dominant brand color; **Secondary** =
     supporting; **Accent** = a bright, sparingly-used pop.
- **Image given?** View it and assign roles by eye.

**If < 3 distinct brand colors:** derive the accent from primary (more
saturated/lighter variant) rather than inventing one; keep the
primary-solid / accent-pop contrast relationship the blocks expect
(`blocks/quick-links/quick-links.css`, `blocks/alert/alert.css`).

**Confirm the 3 hex values with the user before writing.**

### 6b. Logo
Goal: replace the blueprint placeholder in the copied header fragment
(`/sites/{{SLUG}}/fragments/nav/header.html`).

1. **Locate the clearest logo** on the source page — prefer an `<img>`/`<svg>`
   in the site's header/nav (alt/class/id containing "logo", or wrapping the
   home link). Read it from the **rendered** page (`playwright-cli eval`) so
   you get the real element and its **intrinsic** width/height. Fall back to
   `apple-touch-icon`/large favicon only if there's no real nav logo.
2. **Prefer vector (SVG)**; else take the highest-res raster.
3. **Download** it (`curl`) from its absolute URL; enforce the size caps.
4. **Upload into the clone's `.header/` folder** via `PUT /source/...` with
   the correct MIME, then **update the header fragment** to reference the new
   asset (rewrite the `<picture>`/`<img>` `src`/`srcset`, e.g.
   `.header/logo.png` → `.header/logo.svg`).
5. **Set `logo-is`.** The header's `section-metadata` block has a
   `logo-is` row (key cell `logo-is`, value cell `square` by default). Set
   the value from the logo's **intrinsic** dimensions:
   - width > height → `wide`
   - height > width → `tall`
   - ≈ equal → `square`

   The value sits in the second cell of the pair, e.g. the source pattern is
   `…<p>logo-is</p></div><div><p>square</p>…`. Replace `square` with the
   correct value (there may be more than one occurrence). Get dimensions from
   the intrinsic `naturalWidth/naturalHeight` or the downloaded file — not the
   scaled display size.
6. **No usable logo found?** Tell the user and leave the placeholder (and its
   `square` value) in place — don't fabricate one.
7. **Point the home link(s) at the site-base index.** `blocks/header/header.js`
   `decorateBrandSection` doesn't set or rewrite `href` at all — the home
   link comes straight from content, untouched by any runtime JS. The
   blanket `/blueprint` → `/sites/{{SLUG}}` string replace in Step 4 only
   catches it if it was literally authored as `/blueprint`; blueprint content
   is often authored home-relative (e.g. `href="/"`), which has no
   `/blueprint` substring to catch. So explicitly:
   - Find every `<a>` in the header's brand section — the one wrapping the
     logo image and the one wrapping (or shared with) the site name text may
     be the same anchor or two separate ones; update whichever exist.
   - Set each one's `href` to the site-base index **with a trailing
     slash**: `/sites/{{SLUG}}/`. Without the trailing slash the path
     doesn't resolve (confirmed: `/sites/{{SLUG}}` 404s, `/sites/{{SLUG}}/`
     doesn't) — this bit both the header link and the global breadcrumbs'
     Home link (see `scripts/utils/breadcrumbs.js`) before being caught.
   - Do this regardless of what the blueprint originally authored there
     (`/`, `/blueprint`, `/blueprint/`, or anything else) — don't rely on
     the Step 4 rewrite to have already fixed it.

`PUT` the updated header fragment back after the logo swap + `logo-is` edit
+ home link fix.

### 6c. Hero background image
Goal: replace the blueprint homepage's placeholder hero image with a real,
attractive photo of the actual city/county, so the site looks authentic.

The blueprint's hero is the **first `<picture>`** inside
`<div class="hero center">` in `index.html`. It references a generated
placeholder via an **absolute** `content.da.live` URL (a
`.index/firefly_…skyline….png` file at the repo root) — so the Step 4
path/host rewrites do **not** touch it, and the clone still points at the
shared placeholder. Give each tenant its own image:

1. **Source a location photo.** Find a nice, wide, representative image of the
   city/county — a skyline, notable landmark, downtown, or aerial view.
   **Prefer freely-licensed sources** (Wikimedia Commons is reliable and
   citation-clean; Unsplash also fine). A dependable no-key path is the
   Wikimedia Commons API:
   ```bash
   # search for images
   curl -s -A "Mozilla/5.0" \
     "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=8&srsearch=<City>%20<State>%20skyline"
   # resolve a chosen File: title to a ~1920px-wide thumbnail URL
   curl -s -A "Mozilla/5.0" \
     "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size&iiurlwidth=1920&titles=<File:Title>"
   ```
   Prefer a landscape/wide crop (the hero is wide); avoid portrait or tiny
   images. If nothing suitable is found, leave the placeholder rather than
   using a poor image.
2. **Download** it (`curl -L`) and enforce the raster cap (≤ 20 MB); a
   ~1600–1920px-wide JPEG is ideal.
3. **Upload** into the tenant's own hidden index media folder:
   ```bash
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
     -F "data=@hero.jpg;type=image/jpeg" \
     "https://admin.da.live/source/{{ORG}}/{{REPO}}/sites/{{SLUG}}/.index/hero.jpg"
   ```
4. **Rewrite the hero `<picture>`** in the cloned `index.html` — replace all
   references to the placeholder (the `content.da.live/.../.index/firefly…png`
   URL appears **3 times**: two `<source srcset>` and one `<img src>`) with the
   new image's content URL:
   `https://content.da.live/{{ORG}}/{{REPO}}/sites/{{SLUG}}/.index/hero.jpg`
   Then `PUT` `index.html` back and re-preview it.

**Verify:** on the rendered homepage the hero shows the new photo. Note EDS
transforms the source path into an optimized `media_<hash>.jpg` URL at render
time (with `width`/`height` attributes matching your image), so the raw
`.index/hero.jpg` path is not directly reachable — confirm via the rendered
page, not by fetching the source path.

**Attribution:** for a demo this is fine as-is; if the image will be shown
publicly, note the source/license (the Wikimedia file page) in case
attribution is required.

---

## Step 7: Update `/metadata.json`

`/metadata.json` is a **DA sheet**, not a bare array — its shape is:
`{ "total", "limit", "offset", "data": [ …rows… ], ":colWidths", ":sheetname":"data", ":type":"sheet" }`.
You must preserve that envelope and every existing row (see **da-content**
for sheet rules — writing a bare array corrupts it silently).

1. `GET` the current sheet.
2. Append (or replace, if a row for this slug exists — idempotent) one row,
   leaving all others untouched:
   ```json
   {
     "url": "/sites/{{SLUG}}/**",
     "site-base": "/sites/{{SLUG}}",
     "color-primary": "{{PRIMARY_HEX}}",
     "color-accent": "{{ACCENT_HEX}}",
     "color-secondary": "{{SECONDARY_HEX}}"
   }
   ```
3. Update `total`/`limit` to match the row count; `PUT` the whole sheet back
   with `type=application/json`.

**Verify:** re-read `/metadata.json` and confirm the new row is present
alongside every prior row, and the envelope keys survived.

---

## Step 8: Preview (and, only if confirmed, Publish)

`POST` a preview for **every path copied in Step 3**, plus any pages added
(not just overwritten) in Step 5, plus the metadata sheet. Note the metadata
path is **`/metadata.json`** (previewing `/metadata` 404s):

```bash
for p in sites/{{SLUG}}/index \
         sites/{{SLUG}}/fragments/nav/header \
         sites/{{SLUG}}/fragments/nav/footer \
         sites/{{SLUG}}/fragments/nav/header/languages \
         metadata.json ; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    "https://admin.hlx.page/preview/{{ORG}}/{{REPO}}/main/$p"
done
```

(News/events paths were already previewed in Step 5c — no need to repeat
those here unless something changed since.)

**Render check:** open
`https://main--{{REPO}}--{{ORG}}.aem.page/sites/{{SLUG}}/` and confirm the
page renders, the palette is applied (inspect `--primary`/`--secondary`/
`--accent` on `:root`), the new logo shows, and the news/events blocks show
the populated content.

**Publishing** to `aem.live` is production-visible — **ask the user to
confirm** before publishing. Don't publish automatically.

---

## Step 9: Hand Off

Tell the user:

> **New site ready:** `{{SLUG}}`
>
> - **Preview:** `https://main--{{REPO}}--{{ORG}}.aem.page/sites/{{SLUG}}/`
> - **Browse in DA:** `https://da.live/#/{{ORG}}/{{REPO}}/sites/{{SLUG}}`
> - **Palette:** `color-primary: {{PRIMARY_HEX}}`,
>   `color-secondary: {{SECONDARY_HEX}}`, `color-accent: {{ACCENT_HEX}}`
> - **Logo:** swapped into the header (`logo-is: {{wide|tall|square}}`) —
>   or: left as the blueprint placeholder (no usable logo found)
> - **Hero image:** a photo of {{ENTITY}} (source: {{IMAGE_SOURCE}}) —
>   or: left as the blueprint placeholder (no suitable image found)
> - **News/Events:** {{N}} real articles/events sourced from the requester's
>   site — or: blueprint examples retained with locality reworded to
>   `{{ENTITY}}`
>
> Not yet published to production — let me know when you want that pushed live.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` returns nothing / 401 | Token missing/expired or domain not allow-listed | Re-run Step 1 (`oauth-token adobe`, `oauth-domain add adobe admin.da.live`); run **da-auth** if needed |
| New site's images are broken / show placeholder | Binaries under `.header/` weren't copied (doc-only clone) | Re-run Step 3 including hidden folders and binary files |
| Links go to another city's host (e.g. `…--chrissands.aem.live`) | Foreign host prefix not stripped from links in Step 4 | Apply the links-only host-strip (the `(?!media_)` variant) to every copied text file |
| Images broken in the DA editor / bare `/media_<hash>` refs | Blanket host-strip wrongly made image refs root-relative | Rewrite `media_*` refs to `main--{{REPO}}--{{ORG}}.aem.live/media_*` (Step 4, images branch) — never leave them root-relative |
| New site still says "City County Government" | Placeholder entity name not replaced | Apply the Step 4 entity `sed` (longest-first) to header, footer, index |
| Copied pages still say `/blueprint/...` | Path rewrite skipped | Grep copied content for `/blueprint` and fix |
| Clicking the logo/site name goes to the wrong site (or 404s) | Home link was authored root-relative (`href="/"`) with no `/blueprint` substring for Step 4's blanket rewrite to catch | Explicitly set the brand section's anchor(s) `href` to `/sites/{{SLUG}}/` — **with a trailing slash** (Step 6b.7) — don't rely on the blanket rewrite |
| Breadcrumb "Home" link 404s | `site-base` (e.g. `/sites/{{SLUG}}`) has no trailing slash, and that path alone doesn't resolve | Already fixed in `scripts/utils/breadcrumbs.js` (appends `/`) — if it recurs elsewhere, apply the same trailing-slash fix |
| News/events articles still read like generic filler ("the county...") | Step 5b's locality reword pass was skipped or only caught the exact Step 4 tokens | Re-read each fallback article and reword locality mentions to `{{ENTITY}}` in context |
| New site's news/events pages don't show up in listings or search | Not previewed (Step 5c), or `path` doesn't actually sit under `/sites/{{SLUG}}/news/` or `/events/` | Preview the specific page path; confirm it matches the `helix-query.yaml` include glob `/sites/*/news/**` or `/sites/*/events/**` |
| Metadata write corrupts the sheet / other rows vanish | Wrote a bare array instead of the sheet envelope | Preserve `{data, :type:"sheet", …}`; see **da-content** |
| Preview 404 for metadata | Used `/metadata` instead of `/metadata.json` | Preview `metadata.json` |
| Preview 404 for a page | Path wasn't copied, or wrong branch | Re-check Step 3 output; branch is `main` |
| Colors look wrong on preview | Row `url` glob doesn't match, or extraction was off | Confirm `url` is `/sites/{{SLUG}}/**`; re-sample from the rendered page |
| Logo blurry/oversized | Low-res or pre-scaled thumbnail used | Re-locate the real nav logo / SVG, not a favicon |
| Logo squished/cropped | `logo-is` not matched to aspect ratio | Set `logo-is` from intrinsic width/height |
| Hero still shows the placeholder skyline | Hero `<picture>` refs not rewritten (absolute `content.da.live` URLs, untouched by the Step 4 rewrites) | Replace all 3 firefly refs with the tenant's `.index/hero.jpg` content URL (Step 6c); re-preview |
| Hero image 404 at `.index/hero.jpg` | Expected — EDS serves an optimized `media_<hash>` URL, not the raw path | Verify on the rendered page, not the source path |

## Reference

- Runtime theming: `scripts/utils/site-config.js`, `scripts/utils/site-theme.js`,
  `blocks/header/header.js`, `blocks/footer/footer.js`
- News/events rendering & indexing: `blocks/news/news.js`,
  `blocks/news-listing/news-listing.js`, `blocks/events/events.js`,
  `blocks/events-calendar/events-calendar.js`,
  `templates/news-article/news-article.js`,
  `templates/event-detail/event-detail.js`, `scripts/utils/query-index.js`,
  `helix-query.yaml`
- DA API / sheet / binary rules: **da-content** skill