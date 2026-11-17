# Feature roadmap - 2026-11-17

Written after 2.0.1. The 2026-10-29 roadmap (R0-R8) made the tool dependable to run: one home directory, a
crash-safe journal, resume, a scheduler you can see, retention. This one is about what the tool does for you.

## Status

- **2.1.0** shipped Q1, Q2, Q3, Q4 and F1.
- **2.2.0** shipped F2 and F3.
- F4, F5 and the Later list are not started.

Where the result differs from the plan below:

- **Q3.** Vermont's export stopped serving a file, and Texas and Oregon publish none, so only
  California's registry is read.
- **F2.** The plan was a search step on about 20 brokers. Six have one, and only one (USPhonebook) could
  be validated, because the sites refuse a plain browser and getting around bot checks is on the Not
  doing list. Only a validated search step may skip a broker, so `--found-only` changes little today.
- **F3.** The first check found most explicit forms either blocked to a plain browser or drifted. See
  STATUS.md.
- Radaris and PeekYou were removed: both domains were transferred to another company by court order.

Four things drive it:

1. **Nobody can say which broker flows still work.** All 51 explicit brokers are `untested` in STATUS.md, and
   drift is only noticed on one machine after three failed runs (`lib/drift.js`).
2. **The tool sends before it looks.** It submits to about 540 brokers whether or not they hold you. Only 6 of
   the 51 explicit brokers have a search step, so `aidr verify` can check 6. This was the most repeated
   objection in the Show HN thread: "an automated way to send your information to 500 data brokers".
3. **The law moved.** California's one-request deletion platform (DROP) has been live since 2026-01-01 and
   registered brokers have had to act on it since 2026-08-01. The README, STATUS.md and `brokers.js` still say
   "not yet live".
4. **Confirmation emails are still half manual.** A broker that sends a confirm link is not done until someone
   clicks it, and today the auto-click only reads a local folder of `.eml` files.

Every item ships with tests written first. Nothing here makes the run concurrent, and nothing sends personal
data anywhere new.

## Quick wins (2.1)

### Q1. Say the truth about DROP
**Problem.** Three places say DROP is not live: the README section "California residents", the first row of
STATUS.md, and the `California DELETE Portal` entry in `brokers.js` (`confidence: 'documented_not_live'`,
pointing at the registry landing page).
**Shape.** Update all three: live for consumers since 2026-01-01, brokers processing since 2026-08-01. Point
the manual entry at the consumer page. A doc test pins the wording so it cannot go stale silently again.
**Done when.** No file in the repo says DROP is not live, and the manual entry opens the right page.

### Q2. A spend cap for CapSolver
**Problem.** A run can call the solver for every CAPTCHA broker with no ceiling. Carried over from the last
roadmap's Later list.
**Shape.** `capsolver.maxSolvesPerRun`. When the cap is reached, the remaining CAPTCHA brokers are recorded
`captcha_failed` with the reason "solve cap reached", so `aidr captchas` picks them up. The run summary shows
solves used and the estimated spend.
**Done when.** A run with a cap of 2 against three fixture CAPTCHA pages solves two and reports the third.

### Q3. Broker lists that are current
**Problem.** `lib/feeds.js` reads California's legacy Attorney General export, which its own comment dates
2020-2023. The registry moved to the state privacy agency in 2024 and now lists 500 to 600 brokers. The
README describes this feed as the SB 362 registry, which it is not.
**Shape.** Switch the California source to the current registry. Add Texas and Oregon if they publish a
machine-readable export (not yet checked). Record which registries list each broker
(`registries: ['CA', 'VT']`), which F1 needs. Connecticut and New Jersey passed registry laws in 2026: add
them when their lists are published.
**Done when.** `aidr update-brokers` reports a California count in line with the agency's own figure, and each
feed row carries its registries.

### Q4. Show what would be sent, before it is sent
**Problem.** `aidr preview` fills forms without submitting, but nothing lists which of your details go to
which broker. Asked for in the HN thread: "a broken selector could also leak personal data to the wrong
place".
**Shape.** `aidr preview --fields` prints, per broker, the form fields it would fill and which of your
details go in each (names of the details only; `--show-values` prints the values). The same table goes into
the audit report of a real run.
**Done when.** For a fixture broker the table lists exactly the fields the runner typed into, and no value
appears without `--show-values`.

## Features

### F1. `aidr drop`: California's one-request deletion (2.1)
**Problem.** For a California resident, one DROP request legally binds every registered broker. The tool
ignores it and keeps sending per-broker forms to the same companies.
**Shape.**
- Applies to people whose state is CA. The platform verifies identity and residency, so this step cannot be
  automated and the tool will not try.
- `aidr drop` opens the platform, says what it will ask for, and records the date you submitted
  (`aidr drop --done`).
- From then on, brokers on the California registry are marked "covered by DROP" for that person. The generic
  pass skips them and says so in the summary, so fewer companies receive your details. The explicit
  people-search brokers still run, because their listings are public and a form is often faster.
  `drop.alsoSubmit: true` keeps everything running as before.
- The tool tracks the legal clock. Brokers must collect requests at least every 45 days; the deletion window
  after that needs confirming against the regulation before it is coded. Once it has passed, `aidr verify`
  re-checks and `aidr complaints` drafts a complaint to the California privacy agency for a registered broker
  that still lists you. As today, a complaint is only built from evidence, never from the age of a request.
- The exposure score counts DROP coverage.
**Done when.** With a fixture registry, a California person's run skips the covered generic brokers with a
reason, a person in another state is unaffected, and a complaint is only drafted when verification found a
listing after the window.

### F2. `aidr scan`: see where you are listed before sending anything (2.2)
**Problem.** See point 2 above. A "removal" is also never tied to a listing having existed, so the counts
cannot be trusted (the last roadmap's "evidence-backed removal").
**Shape.**
- `aidr scan` searches each broker that can be searched, for each person, and records found, not found or
  could not tell, with the listing URL and a screenshot. It submits nothing.
- Add a search step to the main people-search brokers: from 6 today to about 20. Sites behind a bot wall
  report "could not tell" and never "not found".
- `aidr run --found-only` submits only where the scan found you. Brokers that cannot be searched follow
  `scan.unknown` (`submit` by default, or `skip`).
- A removal counts as verified only when a listing was seen before and is gone after. The score and the
  complaints use that.
**Done when.** Against fixture broker pages: found is submitted, not found is skipped with a reason, and
"could not tell" follows the setting. `aidr verify` reports "never seen" separately from "removed".

### F3. A weekly broker health check (2.2)
**Problem.** See point 1 above.
**Shape.**
- A scheduled CI job with no personal data loads each explicit broker's opt-out page and checks that the page
  answers and that the selectors the definition relies on still exist.
- Each broker gets `ok`, `drifted`, `blocked` or `dead` with a date. STATUS.md is regenerated from that, one
  issue is opened or updated per drifted broker, and the README shows the count.
- `aidr doctor --brokers` runs the same check from your machine, where a home connection gets past bot walls
  that a CI address does not.
**Limits.** It checks the shape of the form, not that a submission deletes anything. CI addresses will be
blocked by some sites; that is reported as `blocked`, not `drifted`.
**Done when.** Against fixture pages, a removed selector reports `drifted`, a challenge page reports
`blocked`, and STATUS.md shows a date per broker.

### F4. Confirmation emails, end to end (2.3)
**Problem.** See point 4 above. With a SimpleLogin relay the forwarded mail has a rewritten sender, so those
confirmations are not matched at all. Both halves were on the last roadmap's Later list.
**Shape.**
- Opt-in, read-only mailbox access (`email.imap`): fetch only messages from known broker sender domains since
  the last run, run the existing link-safety checks, and click. Mail is never stored, moved, deleted or
  marked read.
- Match relay-forwarded confirmations by their reverse alias.
- `aidr pending` shows what was clicked and what still needs you. Setup explains app passwords for Gmail,
  iCloud and Fastmail.
**Risk.** A new dependency and a mailbox credential. It gets its own security review before release, and the
credential is covered by config encryption.
**Done when.** Against a local test mail server, a confirmation from a known broker is clicked once, mail from
an unknown sender is ignored, and the mailbox is unchanged afterwards.

### F5. More of you: past addresses, extra emails and numbers (2.3)
**Problem.** A person has one city, state and ZIP, one email and one phone (name aliases already exist).
People-search sites keep a separate listing per past address and per number, and those stay up.
**Shape.** `person.addresses[]` (current first), `person.emails[]` and `person.phones[]`. Search brokers try
each address, phone brokers each number; the address used for submissions stays the primary or the relay
alias. State is keyed per person and address, so one cleared listing does not hide another. Setup and the
dashboard wizard ask for them. Existing configs keep working unchanged.
**Done when.** A person with two addresses produces two searches on a fixture search broker and two separate
state entries, and an old single-address config runs without edits.

## Later

- **Share outcomes without sharing identity.** `aidr share-results` writes a file with broker, method, outcome
  and date only, to attach to an issue. Combined across users, it answers which of the ~490 generic brokers
  fail silently, which no single install can.
- **Selector repair proposals.** When F3 flags drift, propose new selectors from the public, empty form and
  open a pull request for a person to review. No user data is involved.
- **Outside the US.** Erasure requests by email under GDPR to a curated UK and EU list; Canada and Australia
  after that. Asked for repeatedly in the HN thread. Today non-US users only get the global brokers.
- **Fill only required fields** (`privacy.minimal`).
- **A guided "Results about you" step** that feeds Google the URLs `aidr serp` found.
- Still open from 2026-10-29: fill and submit inside one `<form>` for explicit brokers, a masked `From` for
  opt-out emails with a relay, Windows in CI, and a SQLite state backend.

## Not doing

- **A hosted service or accounts.** Your details stay on your machine.
- **Automating proof of identity:** DROP's verification, Truecaller's SMS, a Google sign-in.
- **Beating bot managers** such as press-and-hold or reCAPTCHA Enterprise. Those brokers stay manual.
- **Parallel pages.** One page at a time is what keeps a 2 GB NAS at about 250 MB.
- **Sending pages or personal details to a hosted AI model to drive forms.** Worth revisiting only with a
  model that runs locally.

## Sources

- DROP status and dates: <https://cppa.ca.gov/data_brokers>,
  <https://privacy.ca.gov/2026/07/drop-data-broker-deletions-how-do-they-work/>,
  <https://www.malwarebytes.com/blog/news/2026/08/californians-can-tell-data-brokers-to-drop-their-information>.
  The 45-day collection rule is the agency's; the deletion window after it was reported as 90 days by one
  article and is not confirmed here.
- New state registries (Connecticut, New Jersey):
  <https://www.multistate.us/insider/2026/10/28/twenty-four-states-now-have-comprehensive-consumer-privacy-laws>,
  <https://www.datagrail.io/blog/data-privacy/data-broker-compliance/>. Bill numbers and dates differ
  between sources and are not confirmed here.
- User requests: the Show HN thread, <https://news.ycombinator.com/item?id=48178184>.
