# Broker Status

> **What this page is:** a weekly health check of the opt-out pages of the 48 explicit brokers in `brokers.js`. A scheduled job loads each page with a plain headless browser and checks that the page answers and that the selectors the definition relies on still exist. It is generated: edit `brokers.js` or let the weekly job refresh `data/broker-health.json`, then run `node scripts/generate-status.js`. Do not edit the table by hand.
>
> **Limits, plainly:** the check looks at the shape of the form. It never types, clicks or submits, so it cannot tell you whether a submission deletes anything. It cannot tell the real opt-out form from another form with the same fields on the page (a newsletter box with an email field and a submit button satisfies `input[type="email"]` plus `button[type="submit"]`). `aidr verify` is the check for that. And the weekly job runs from a data centre address that some sites refuse, so a page can be `blocked` here and fine from your home connection. `aidr doctor --brokers` runs the same check from your own machine.

The last check ran on 2026-11-17, from a run on a developer machine.

**12 ok, 13 drifted, 18 blocked, 0 dead, 1 error** out of 44 brokers with a page to check; 4 n/a (email brokers have no page).

## Health labels

- `ok` - the page loads and every selector the definition relies on (the form fields and the submit button) matches a **visible** element, the same test the runner applies before it fills a field. A CAPTCHA widget on a complete form is part of the form and still counts as `ok`. A `manual` broker is `ok` when its page answers: **its form is not checked**, so for those `ok` says only that the page answers on the same site (a soft 404 or a page that merely loads also answers).
- `drifted` - the page loads, but one or more of those selectors match no visible element (the site changed its form, or moved it), or the page ended up on a different site than the opt-out URL (the detail says `redirected to <host>`: a parking page, a sold domain, a moved portal). The weekly job opens one issue per drifted broker after two checks in a row from the same kind of runner. A real form with a CAPTCHA widget beside it and some fields renamed is `drifted`, not `blocked`.
- `blocked` - a bot challenge, a 403 or 429, a challenge-style 503, or a CAPTCHA or bot-manager marker with **not one** of the selectors visible (the widget may be hiding the form). We did not see the real page, so a blocked broker is reported as `blocked`, not `drifted`.
- `dead` - the host does not resolve, the connection is refused, or the page answers 404 or 410.
- `error` - a timeout, a 5xx that is not a challenge, a reset connection, or a page that rendered nothing. Shown, but it never opens an issue: the next weekly check replaces it.
- `n/a` - email brokers. Removal is an email, so there is no page to check.
- `not checked yet` - the broker has no result in `data/broker-health.json`.

**Brokers known to be dead, moved or removed (as of Nov 2026):**
- **NationalPublicData**: defunct (Aug 2024 SSN breach + Oct 2024 bankruptcy). Listing kept for historical reference; opt-out flow does not work.
- **Clearbit**: acquired by HubSpot (Nov 2023), now "Breeze Intelligence". Opt-out runs through a DataGrail request center at preferences.clearbit.com. Now `manual`: the form needs a custom dropdown and a second confirm step that the direct-form runner cannot complete.
- **Acxiom**: live but requires multi-step identity verification at acxiom.com/about-us/privacy/. Single-form POST will fail.
- **LexisNexis Risk Solutions**: requires a fillable PDF mailed/faxed + a separate portal at consumer.risk.lexisnexis.com. Single-form POST will fail.
- **ZoomInfo**: opt-out is at privacyrequest.zoominfo.com/remove/verify, behind a "Press & Hold" bot challenge and email verification. Now `manual`.
- **Andrews Wharton**: added to `brokers.js` as `manual` (Oct 2026). It came from the Markup dataset, and the generic runner submitted the marketing sign-up form on its homepage as if it were an opt-out. The explicit entry keeps the generic runner off that host; the real opt-out is Stirista's portal at unsubscribe.stirista.com.
- **ClustrMaps**: removed from `brokers.js` (Oct 2026). Its own DNS points clustrmaps.com at 127.0.0.1 (since about Sep 2026), so the site is unreachable everywhere; the domain is still registered and may return.
- **PublicDataUSA**: removed from `brokers.js` (Oct 2026). The domain no longer resolves; the site appears to have shut down around September 2026.
- **Radaris**: removed from `brokers.js` (Nov 2026). radaris.com was transferred by court order to Atlas Data Privacy Corporation; every URL on it, search URLs included, now shows the same "This Domain Has Been Transferred by Court Order" notice and the opt-out pages no longer exist (confirmed 2026-11-17). The host is in `data/dead-urls.json` so no pass visits it.
- **PeekYou**: removed from `brokers.js` (Nov 2026). peekyou.com was transferred by court order to the same company and shows a "Domain Update" notice; the opt-out page no longer exists (confirmed 2026-11-17). The host is in `data/dead-urls.json` so no pass visits it.

If you encounter a broker that has changed its form, please file a GitHub issue with the broker name and the new form layout.

## How to read the table

- **Method** - how the opt-out is automated. `search-form` (looks you up first, then submits removal), `direct-form` (goes straight to the opt-out URL), `email` (sends a removal-request email), `manual` (opened in your browser).
- **CAPTCHA** - whether CapSolver is invoked before submit.
- **Health** - the label from the last weekly check (see above).
- **Checked** - the UTC date of that check.
- **US-only** - site indexes US public records / voter data / phone directories; automatically skipped for non-US users.
- **Search step** - `yes` when the broker has a search URL the runner uses to find your listing first; the date is when that search page was last confirmed to work, if it has been.

**This list covers the 48 explicit brokers in `brokers.js` only.** The other ~490 brokers in `data/markup-parsed.json` and `data/badbool-extra.json` are handled by the heuristic generic runner - every one of those is best-effort. Run `node watcher.js --verify` to spot-check whether opt-outs are still in effect.

---

## Explicit brokers

| Broker | Method | CAPTCHA | Health | Checked | US-only | Search step |
|---|---|---|---|---|---|---|
| Spokeo | search-form | no | blocked | 2026-11-17 | yes | yes (not checked) |
| WhitePages | search-form | no | blocked | 2026-11-17 | yes | yes (not checked) |
| FastPeopleSearch | search-form | no | drifted | 2026-11-17 | yes | yes (not checked) |
| TruePeopleSearch | direct-form | no | blocked | 2026-11-17 | yes | no |
| BeenVerified | direct-form | yes | blocked | 2026-11-17 | yes | no |
| Intelius | direct-form | no | blocked | 2026-11-17 | no | no |
| PeopleFinders | direct-form | no | blocked | 2026-11-17 | no | no |
| PeopleSmart | direct-form | no | drifted | 2026-11-17 | no | no |
| MyLife | search-form | yes | blocked | 2026-11-17 | no | yes (not checked) |
| Nuwber | search-form | no | blocked | 2026-11-17 | no | yes (not checked) |
| FamilyTreeNow | direct-form | yes | blocked | 2026-11-17 | no | no |
| CheckPeople | direct-form | no | drifted | 2026-11-17 | no | no |
| ThatsThem | direct-form | no | blocked | 2026-11-17 | no | no |
| USPhonebook | direct-form | yes | ok | 2026-11-17 | yes | yes (2026-11-17) |
| SmartBackgroundChecks | direct-form | no | drifted | 2026-11-17 | no | no |
| SearchPeopleFree | direct-form | no | blocked | 2026-11-17 | no | no |
| PeopleSearchNow | direct-form | no | drifted | 2026-11-17 | no | no |
| InfoTracer | direct-form | no | drifted | 2026-11-17 | no | no |
| SocialCatfish | direct-form | no | drifted | 2026-11-17 | no | no |
| NationalPublicData | direct-form | no | blocked | 2026-11-17 | no | no |
| PrivateRecords | direct-form | no | drifted | 2026-11-17 | no | no |
| Acxiom | direct-form | no | drifted | 2026-11-17 | no | no |
| LexisNexis | direct-form | no | drifted | 2026-11-17 | no | no |
| ZoomInfo | manual | n/a | blocked | 2026-11-17 | no | no |
| Clearbit | manual | n/a | ok | 2026-11-17 | no | no |
| Andrews Wharton | manual | n/a | ok | 2026-11-17 | no | no |
| Addresses.com | direct-form | no | blocked | 2026-11-17 | no | no |
| AnyWho | direct-form | no | blocked | 2026-11-17 | no | no |
| TruthFinder | direct-form | no | blocked | 2026-11-17 | no | no |
| InstantCheckmate | direct-form | no | blocked | 2026-11-17 | no | no |
| Spokeo (email) | email | n/a | n/a | 2026-11-17 | no | no |
| Epsilon | direct-form | no | drifted | 2026-11-17 | no | no |
| Oracle Data Cloud | direct-form | no | drifted | 2026-11-17 | no | no |
| Equifax (marketing) | direct-form | no | error | 2026-11-17 | no | no |
| Experian (marketing) | direct-form | no | blocked | 2026-11-17 | no | no |
| DataAxle | direct-form | no | drifted | 2026-11-17 | no | no |
| Truecaller | manual | n/a | ok | 2026-11-17 | no | no |
| Sync.ME | direct-form | yes | ok | 2026-11-17 | yes | no |
| CallApp | direct-form | no | ok | 2026-11-17 | no | no |
| NumLookup | direct-form | no | ok | 2026-11-17 | yes | no |
| Hiya | email | n/a | n/a | 2026-11-17 | no | no |
| Eyecon | email | n/a | n/a | 2026-11-17 | no | no |
| National Do Not Call Registry | manual | n/a | ok | 2026-11-17 | yes | no |
| Spy Dialer | manual | n/a | ok | 2026-11-17 | yes | no |
| Pipl | email | n/a | n/a | 2026-11-17 | no | no |
| Google - Results About You | manual | n/a | ok | 2026-11-17 | no | no |
| Google - Outdated Content | manual | n/a | ok | 2026-11-17 | no | no |
| CalPrivacy DROP | manual | n/a | ok | 2026-11-17 | no | no |

## How confident should I be?

| Path | Confidence | Why |
|---|---|---|
| Explicit + health `ok` | Medium to high | The page loads and the form has the shape the definition expects. A submission was not tested. |
| Explicit + `drifted` | Low until fixed | The form changed. The runner may still find the fields by their meaning, but do not count on it. |
| Explicit + `blocked` | Unknown | The weekly job could not see the page. Run `aidr doctor --brokers` from your own connection. |
| Explicit + `dead` or `error` | Low | The page is gone, or did not answer this week. |
| Generic runner (~490 sites) | Best-effort | 4-strategy heuristic. Many succeed; some get a manual fallback. **Not guaranteed.** |
| `manual` | High (you) | Opened in your browser; you complete it. |
| `email` | High (delivery) / Medium (compliance) | Email is sent. Whether the broker honors it is up to them. |

After running, use `node watcher.js --verify` to search the broker for your name again and confirm whether listings are gone. `--verify` is the honest ceiling - "submitted" is not "deleted."

## Reporting drift

When a broker is `drifted` on two weekly checks in a row (from the same kind of runner: the first check from the weekly job after a local run does not count), an issue titled `Broker drift: <name>` is opened with what no longer matches, and it closes itself when the broker is `ok` again. The broker an issue belongs to is recorded in a hidden marker in its body, so you can retitle it. If you close it because the problem is known, add the `wontfix` label and it stays closed; without that label it is reopened when the broker drifts again. If you notice a broker failing that the table still shows as `ok`, please open an issue with a screenshot of its current opt-out form.
