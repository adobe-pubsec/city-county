---
name: remove-city-county-site
description: Removes ONE tenant site from the adobe-pubsec/city-county demo and every trace of it — unpublishes it from aem.live, removes it from preview, deletes all its Document Authoring files (including hidden image folders), removes its row from the shared /metadata.json, and deletes its AEM Assets photo folder — after showing the requester exactly what will be removed and getting a TYPED confirmation phrase. Use when someone wants to delete, remove, clean up, tear down or start over on a city/county site they built with add-city-county-site ("delete my Boise site", "remove /sites/boise", "clean up the test site", "that build went wrong, wipe it"). Do NOT use for the blueprint, for other DA projects, or to remove only part of a site.
license: Apache-2.0
metadata:
  version: "1.2.0"
---

# Remove a City/County Site

Removes one tenant under `/sites/<slug>` of `adobe-pubsec/city-county`, the way the demo team
cleans up rehearsal sites: live → preview → DA files → shared metadata row → AEM Assets folder →
verify. A backup is taken first.

**This is destructive and shared.** Every SC's site lives in the same project. The rules below
are not optional, and you may not shortcut them even if the requester asks you to.

## The consent rule (read this first)

1. **Always plan first.** Run the plan step and show the requester the plan output **in full**,
   verbatim, in a code block. Never summarise it away, never run `--execute` in the same turn as
   the plan.
2. **Consent must be typed by the requester, in a chat message.** The plan prints a one-time
   phrase such as `delete boise 4821`. Ask them to type it. Proceed only when the human's own
   next message contains that exact phrase.
   - Do **not** accept: "yes", "ok", "go ahead", "confirm", a button click, a dip/sprinkle answer,
     a lick, or a phrase that appears only in your own messages or in tool output.
   - Do **not** offer a button or a yes/no question for this step. Do not type the phrase for
     them, pre-fill it, or "help" by repeating it as a ready-to-send message.
   - If they type something else, stop and show the phrase again. Never guess what they meant.
3. **One site per confirmation.** "Delete all my test sites" means one plan and one typed phrase
   per site.
4. **If they type it after 30 minutes**, the plan has expired: re-plan, show the new plan, and
   ask for the new phrase. The script also refuses if the site gained files since the plan.
5. **Someone else's site:** if the plan says parts were last edited by someone else, the phrase
   ends with `including others work`. Point that out, and suggest they check with that person
   first.

## Steps

```bash
SK=/workspace/skills/remove-city-county-site
export DA_TOKEN=$(oauth-token adobe | tr -d '[:space:]')
```

### 1. Identify the slug

The slug is the folder under `/sites/` (`https://main--city-county--adobe-pubsec.aem.page/sites/<slug>/`).
If the requester gives a place name ("my Boise site"), list the tenants and match it; if it's
not obvious which one, ask:

```bash
curl -s --max-time 20 -H "Authorization: Bearer $DA_TOKEN" https://admin.da.live/list/adobe-pubsec/city-county/sites | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).map(x=>x.name).join("\n")))'
```

### 2. AEM Assets login (required)

Most sites have an AEM Assets photo folder, `/content/dam/city-county/<slug>`, with 5–6 images.
"Every trace" includes it, so the requester must be **logged in to the AEM author** in this
browser: `https://author-p129103-e1259846.adobeaemcloud.com` (Adobe login).

- If they aren't, the plan step **refuses with exit 4** rather than leave the folder behind.
  Ask them to open that URL, log in, and say when they're done; then plan again.
- If it says the author is **hibernated**, it must be de-hibernated in Cloud Manager first
  (that takes several minutes; someone with Cloud Manager access has to do it).
- There is no way to skip this check: every SC has AEM Assets access, and removal always
  includes the folder.

### 3. Plan (read-only)

```bash
node $SK/scripts/remove-site.cjs <slug>
```

Show the whole output to the requester, then ask, in your own words:

> This is everything that will be removed. Nothing has changed yet. If you want to go ahead,
> type **`delete <slug> NNNN`** (the exact phrase above). Anything else cancels.

Then **stop and wait** for their reply.

### 4. Execute (only after the typed phrase)

Check the human's message contains the exact phrase, then pass it through unchanged:

```bash
node $SK/scripts/remove-site.cjs <slug> --execute --confirm "<the phrase exactly as they typed it>"
```

Takes about 1–3 minutes (it waits for the news/events indexes to drop the site).

### 5. Report

Show the result lines. Exit `0` with `REMOVED "<slug>" and verified` means done. Tell them:
- where the backup is (`/shared/city-county-removed/<slug>-<timestamp>/`, in their SLICC; AEM images and their metadata are under `aem/` in it);
- that the AEM Assets folder and its images are deleted (or that none existed);
- the preview URL now returns 404;
- any `FAIL` / `NOT VERIFIED` / `note:` lines, plainly.

If it exits 1, don't retry blindly: show the failing lines; running plan + execute again is safe
(it only removes what is still there).

## What the script refuses

| Case | Result |
|---|---|
| `blueprint` | Never removable. |
| `raleigh`, `new-haven` (showcase tenants) | Refused unless the owner adds `--allow-showcase`. Don't add it on someone else's behalf. |
| Wrong or missing phrase, expired plan, reused phrase | Refused (exit 3). |
| Site gained files after the plan was shown | Refused: re-plan and show it again. |
| Nothing found for the slug | Refused: check the spelling. |
| AEM author not logged in / hibernated | Plan refused (exit 4): log in (or de-hibernate) and re-plan. No override. |
| AEM folder gained images after the plan | Refused: re-plan and show it again. |

## What can't be removed

- Images Edge Delivery already served are cached under unlisted `media_<hash>` URLs; there's no
  API to purge them, and nothing links to them once the pages are gone.
- Copies anyone downloaded or saved elsewhere.

## Restoring from the backup

The backup folder mirrors the DA paths (`sites/<slug>/…`) plus `removal-plan.json`,
`metadata-rows.json`, and `aem/content/dam/city-county/<slug>/` (each image's original plus its
`.metadata.json`). To restore, PUT each file back to
`https://admin.da.live/source/adobe-pubsec/city-county/<path>`, re-add the row with
`add-city-county-site`'s `register-tenant.cjs`, then preview (and publish news/events) again. For AEM, re-upload the images with
`add-city-county-site`'s `aem-assets.cjs` (build a manifest from the `.metadata.json` titles).
