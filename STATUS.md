# Broker Status

> **Reality check:** Every broker entry here is labeled `untested` until manually verified against the live site. The selectors compile and the test suite verifies their internal structure, but no end-to-end verification has been performed in the current run window. Many of these sites change their DOM frequently - selectors decay.
>
> **What "untested" means:** the broker entry is structurally valid but has not been hand-verified against the live site recently. The opt-out attempt will be made but may silently fail if the site has changed its form.
>
> **Brokers known to be dead or moved as of late 2025:**
> - **NationalPublicData**: defunct (Aug 2024 SSN breach + Oct 2024 bankruptcy). Listing kept for historical reference; opt-out flow does not work.
> - **Clearbit**: acquired by HubSpot (Nov 2023), now "Breeze Intelligence". Opt-out runs through a DataGrail request center at preferences.clearbit.com. Now `manual`: the form needs a custom dropdown and a second confirm step that the direct-form runner cannot complete.
> - **Acxiom**: live but requires multi-step identity verification at acxiom.com/about-us/privacy/. Single-form POST will fail.
> - **LexisNexis Risk Solutions**: requires a fillable PDF mailed/faxed + a separate portal at consumer.risk.lexisnexis.com. Single-form POST will fail.
> - **ZoomInfo**: opt-out is at privacyrequest.zoominfo.com/remove/verify, behind a "Press & Hold" bot challenge and email verification. Now `manual`.
> - **Andrews Wharton**: added to `brokers.js` as `manual` (Oct 2026). It came from the Markup dataset, and the generic runner submitted the marketing sign-up form on its homepage as if it were an opt-out. The explicit entry keeps the generic runner off that host; the real opt-out is Stirista's portal at unsubscribe.stirista.com.
> - **ClustrMaps**: removed from `brokers.js` (Oct 2026). Its own DNS points clustrmaps.com at 127.0.0.1 (since about Sep 2026), so the site is unreachable everywhere; the domain is still registered and may return.
> - **PublicDataUSA**: removed from `brokers.js` (Oct 2026). The domain no longer resolves; the site appears to have shut down around September 2026.
>
> If you encounter a broker that has changed its form, please file a GitHub issue with the broker name and the new form layout.

**Last updated:** auto-generated table - re-run `node scripts/generate-status.js` after editing `brokers.js`.

## How to read this

- **Method** - how the opt-out is automated. `search-form` (looks you up first, then submits removal), `direct-form` (goes straight to the opt-out URL), `email` (sends a removal-request email), `manual` (opened in your browser).
- **CAPTCHA** - whether CapSolver is invoked before submit.
- **Confidence** - `verified` means the selectors / flow have been manually confirmed against the live site. `untested` means the entry exists but has not been hand-verified end-to-end and depends on the broker not having changed its DOM.
- **US-only** - site indexes US public records / voter data / phone directories; automatically skipped for non-US users.

**This list covers the 51 explicit brokers in `brokers.js` only.** The other ~490 brokers in `data/markup-parsed.json` and `data/badbool-extra.json` are handled by the heuristic generic runner - every one of those is best-effort. Run `node watcher.js --verify` to spot-check whether opt-outs are still in effect.

---

## Explicit brokers

| Broker | Method | CAPTCHA | Confidence | US-only |
|---|---|---|---|---|
| California DELETE Portal | direct-form | no | untested | no |
| Spokeo | search-form | no | untested | yes |
| WhitePages | search-form | no | untested | yes |
| FastPeopleSearch | search-form | no | untested | yes |
| TruePeopleSearch | direct-form | no | untested | yes |
| BeenVerified | direct-form | yes | untested | yes |
| Radaris | search-form | no | untested | no |
| Intelius | direct-form | no | untested | no |
| PeopleFinders | direct-form | no | untested | no |
| PeopleSmart | direct-form | no | untested | no |
| MyLife | search-form | yes | untested | no |
| Nuwber | search-form | no | untested | no |
| FamilyTreeNow | direct-form | yes | untested | no |
| CheckPeople | direct-form | no | untested | no |
| ThatsThem | direct-form | no | untested | no |
| USPhonebook | direct-form | yes | untested | yes |
| SmartBackgroundChecks | direct-form | no | untested | no |
| SearchPeopleFree | direct-form | no | untested | no |
| PeopleSearchNow | direct-form | no | untested | no |
| InfoTracer | direct-form | no | untested | no |
| SocialCatfish | direct-form | no | untested | no |
| NationalPublicData | direct-form | no | defunct | no |
| PrivateRecords | direct-form | no | untested | no |
| Acxiom | direct-form | no | defunct | no |
| LexisNexis | direct-form | no | defunct | no |
| ZoomInfo | manual | n/a | n/a | no |
| Clearbit | manual | n/a | n/a | no |
| Andrews Wharton | manual | n/a | n/a | no |
| PeekYou | direct-form | no | untested | no |
| Addresses.com | direct-form | no | untested | yes |
| AnyWho | direct-form | no | untested | yes |
| TruthFinder | direct-form | no | untested | yes |
| InstantCheckmate | direct-form | no | untested | yes |
| Epsilon | direct-form | no | untested | no |
| Oracle Data Cloud | direct-form | no | untested | no |
| Equifax (marketing) | direct-form | no | untested | no |
| Experian (marketing) | direct-form | no | untested | no |
| DataAxle | direct-form | no | untested | no |
| Truecaller | manual | n/a | n/a | no |
| Sync.ME | direct-form | yes | untested | yes |
| CallApp | direct-form | no | untested | no |
| NumLookup | direct-form | no | untested | yes |
| Hiya | email | n/a | untested | no |
| Eyecon | email | n/a | untested | no |
| National Do Not Call Registry | manual | n/a | n/a | yes |
| Spy Dialer | manual | n/a | n/a | yes |
| Pipl | email | n/a | untested | no |
| Spokeo (email) | email | n/a | untested | no |
| CalPrivacy DROP | manual | n/a | n/a | no |
| Google - Results About You | manual | n/a | n/a | no |
| Google - Outdated Content | manual | n/a | n/a | no |

## How confident should I be?

| Path | Confidence | Why |
|---|---|---|
| Explicit + `verified` | High | Hand-tested selectors against the live page. |
| Explicit + `untested` | Medium | Definition exists, DOM may have shifted. Failures show up as `error` or `pending_confirm`. |
| Generic runner (~490 sites) | Best-effort | 4-strategy heuristic. Many succeed; some get a manual fallback. **Not guaranteed.** |
| `manual` | High (you) | Opened in your browser; you complete it. |
| `email` | High (delivery) / Medium (compliance) | Email is sent. Whether the broker honors it is up to them. |

After running, use `node watcher.js --verify` to search the broker for your name again and confirm whether listings are gone. `--verify` is the honest ceiling - "submitted" ≠ "deleted."

## Reporting drift

If you notice a `verified` broker has started failing, please open an issue with a screenshot of the broker's current opt-out form. Selector changes are the most common cause.
