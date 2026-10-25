# n8n Template Submission Notes

This page is for MEKA maintainers preparing the official n8n template-library submission. It is not evidence that the template has been accepted or published.

## Release Gate

- The executed public workflow is [`n8n/linkedin-jobs-to-google-sheets.json`](../n8n/linkedin-jobs-to-google-sheets.json).
- Executed workflow SHA-256: `8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac`.
- The human-review submission used an earlier byte revision of [`n8n/linkedin-jobs-to-google-sheets-template.json`](../n8n/linkedin-jobs-to-google-sheets-template.json), generated with `npm run build:n8n-template`.
- Submitted revision SHA-256: `33c74f2c0badbd7ded711d58f855d8f106d09f173d1a7f19c721ae326e02dec2`.
- Relative to the public source, the variant changes only the top-level name and the existing yellow **Before Running** sticky note. Every executable node and ID, every connection, every executable node position, `active: false`, and `settings` remain deep-equal to the executed source.
- The workflow is inactive and credential-free.
- The formal n8n template guidelines are [Template submission guidelines](https://n8n.notion.site/Template-submission-guidelines-9959894476734da3b402c90b124b1f77).
- The Creator Terms are confirmed, AI review is complete, and the Finalize form was submitted for human review after a byte-identical re-upload of the reviewed variant.
- The n8n confirmation modal says human review typically takes **3–5 business days**. Human review is pending, and no public template URL or official template ID has been issued.
- Publish a Cloud one-click button only after n8n returns the real approved template URL and template ID.
- Never infer, fabricate, or advertise a public template ID, URL, approval status, or official publication before n8n provides them.
- Keep trial-workspace URLs, Creator draft IDs, account addresses, spreadsheet IDs, OAuth data, and API tokens out of this page and the public repository.

## 2026-10-25 Naming Revision

- Desired template title: `Monitor new LinkedIn jobs daily in Google Sheets with Apify`.
- Current repository template SHA-256: `42d17a9284944acf70872a418b778d059e84da58664b1a04e1ced5036b01fcd1`.
- The current artifact changes only the top-level `name` relative to the submitted revision. Its executable nodes, IDs, connections, positions, activation flag, settings, and sticky note remain unchanged.
- A direct UI recheck found that the sole Pending card only opens the **Template under review (3–5 business days)** message and has no rename entry. The workflow edit page shows the title as a read-only heading and provides editable overview content, but no title input or upload control.
- The repository artifact title is updated, but the pending n8n Creator portal title remains `Track new LinkedIn jobs daily in Google Sheets with Apify MEKA`. The two titles are not synchronized, the portal title cannot currently be changed through the submission UI, and the existing submission remains pending human review. It has not been renamed or publicly published.
- The editable overview was submitted twice with **Save changes**. The button showed a loading state and then returned to normal both times. After waiting for completion and reloading, the portal restored its existing 27-word overview both times. The portal overview is therefore also unsynchronized; no portal title or overview update can be claimed.
- The existing pending submission remains in its original review state. The repository artifact and discovery metadata are prepared, while portal synchronization awaits an n8n UI state that can persist these fields.
- No support email has been sent. The pending submission has also not been withdrawn, duplicated, re-uploaded, or re-submitted.

## Copyable Title and Overview Request

This request has not been sent and contains no account or private submission data.

```text
Subject: Title and overview update for pending n8n template submission

Hello,

Please update the pending LinkedIn Jobs Scraper template submission:

Current title: Track new LinkedIn jobs daily in Google Sheets with Apify MEKA
Requested title: Monitor new LinkedIn jobs daily in Google Sheets with Apify

Current overview: Monitor new public LinkedIn jobs in Google Sheets with MEKA. The workflow validates a focused search, deduplicates job IDs against your sheet, and appends only unseen roles.
Requested overview: Stop checking LinkedIn manually. Save matching jobs to Google Sheets daily, skip duplicates, and keep your first-seen history.

The updated repository template artifact uses the requested title, and the requested overview is included above. Two attempts to save the overview through the editable field returned the previous copy after reloading. Please keep the existing submission under review and update both fields when possible.

Thank you.
```

The 2026-10-25 n8n Cloud 2.45.3 Experimental check established that an authorized user could import the workflow JSON through the UI, complete Google OAuth authorization, bind an authorized Apify credential, and complete two live Manual Trigger runs against Google Sheets. Both runs used the unchanged public workflow and the schedule remained inactive. Those runs used the instance-default timezone. The private workflow was later set to `Etc/UTC`, saved, reopened, and confirmed. The submission variant was not run again because all executable nodes and settings match the originally executed source; it is not a third acceptance run.

AI review returned generic guidance about improving sticky notes, with no specific blocking issue. It did not replace the independently authored and tested implementation. The form copy below is maintained from repository facts and was entered into the Finalize form instead of automatically generated submission text that named the workflow timezone or credentials incorrectly.

## Submission Copy

The current portal retains this submitted title:

```text
Track new LinkedIn jobs daily in Google Sheets with Apify MEKA
```

The maintained desired title for the generated artifact and manual rename request is:

```text
Monitor new LinkedIn jobs daily in Google Sheets with Apify
```

The `overview` below records the existing longer submitted copy. [`docs/discovery-metadata.json`](discovery-metadata.json) stores the approved, shorter hero copy in `n8nOverview`. Two attempts to save that value through the editable overview field did not persist, so the portal still shows the existing copy.

Other maintained submission copy:

```json
{
  "overview": "Monitor new public LinkedIn jobs in Google Sheets with MEKA. The workflow validates a focused search, deduplicates job IDs against your sheet, and appends only unseen roles.",
  "howItWorks": [
    "Use the Manual Trigger for a supervised test, or enable the included daily Schedule Trigger after setup.",
    "Read and validate search, spreadsheet, result, and budget settings before starting one MEKA Actor run through Apify.",
    "Handle READY and RUNNING responses with a bounded poll loop without retrying the billable start request.",
    "Read the Actor OUTPUT summary before accepting data; stop on failed searches and mark enrichment failures or budget stops as partial coverage.",
    "Fetch one bounded Dataset batch and normalize valid public LinkedIn job records into the documented ten-column shape.",
    "Read existing IDs from the target sheet and remove jobs already present or duplicated inside the fetched batch.",
    "Append only unseen rows, preserve firstSeenAt, and report fetched, new, appended, skipped, and coverage counts."
  ],
  "setup": [
    "Import the workflow JSON and keep it inactive.",
    "Create a Google Sheet with a Jobs worksheet and add these exact headers in row 1: id, title, company, location, postedAt, url, salary, employmentType, seniority, firstSeenAt.",
    "Create an HTTP Header Auth credential. Set the header Name to Authorization and Value to Bearer <YOUR_APIFY_TOKEN>. Select the same credential on Start Actor, Poll Actor Run, Get Run Output, and Get Dataset Items.",
    "In Search settings, enter your spreadsheet document ID and sheetName, then choose keywords, location, date window, limit, and budgetUsd (mapped to the maxTotalChargeUsd HTTP query parameter). Connect Google Sheets OAuth2 to Read Existing Jobs and Append Rows.",
    "Open Workflow settings -> Timezone and choose the timezone you intend to use. Confirm that 08:00 is the intended time in the timezone you explicitly choose. Run the Manual Trigger, inspect the execution and real sheet, and enable the Schedule Trigger only after that test succeeds."
  ],
  "requirements": [
    "Use n8n with an Apify account and token, a Google account that can authorize Google Sheets OAuth2, and a writable spreadsheet with the documented Jobs worksheet and ten headers. This template is free, but Apify Actor usage may incur separate Apify charges."
  ],
  "customization": [
    "Edit Search settings to change the keywords, location, date window, result limit, spending cap, spreadsheet, or worksheet. After choosing a workflow timezone, adjust the 08:00 schedule if needed. Focused smaller searches are easier to inspect; result limits and budget caps do not guarantee full-market coverage."
  ],
  "additionalInfo": "The template is free to use, while Apify Actor runs may incur separate Apify charges; the user's n8n plan may also apply. Public repository: https://github.com/meka-im/linkedin-jobs-scraper-examples. MEKA Actor: https://apify.com/meka.im/linkedin-jobs-scraper. Use one workflow and one active writer per sheet because concurrent read-and-append runs can race. Results depend on search ranking, public availability, enrichment outcomes, and result or budget limits, so this workflow does not provide full-market coverage."
}
```

The copy has one 27-word overview, seven how-it-works entries totaling 122 words, five setup entries totaling 153 words, one requirements entry, one customization entry, and one 74-word additional-information paragraph.

Three details are intentional:

- The schedule wording says 08:00 occurs **in the timezone you explicitly choose**. It does not claim that an import automatically preserves or applies UTC.
- The Apify credential instruction identifies an HTTP Header Auth **header** with `Name` set to `Authorization` and `Value` set to `Bearer <YOUR_APIFY_TOKEN>`. It does not call the credential itself `Authorization`.
- Search settings use `budgetUsd`. The workflow maps that value to the `maxTotalChargeUsd` HTTP query parameter; the two names are not interchangeable form fields.

## Submission Checklist

- The current portal uses the title `Track new LinkedIn jobs daily in Google Sheets with Apify MEKA` and retains its existing 27-word overview. The update request above is not evidence of a portal update and has not been sent.
- The other copy in the JSON above records the maintained Finalize submission fields for future requested changes.
- The human-review submission used the byte-identical reviewed variant at SHA-256 `33c74f2c0badbd7ded711d58f855d8f106d09f173d1a7f19c721ae326e02dec2`.
- Do not modify the submitted workflow JSON for form-copy corrections. If an executable change or a necessary sticky-note correction is made, re-run the offline suite, update the submitted-variant hash, and re-upload the changed JSON before continuing.
- Two editable-overview save attempts showed loading and then reverted to the old copy after reload. Do not claim a portal overview update. Keep the submission pending and record the actual title or overview only after n8n persists the change.
- Keep the Creator draft ID, private workspace URLs, spreadsheet links or IDs, credentials, account email addresses, and raw execution bodies out of public files and screenshots.
- Do not claim approval, a public template URL, an official template ID, or one-click availability while human review is pending. The current confirmation estimate is 3–5 business days.
- After review returns, record the approved public template URL and ID only from n8n's response, then update the public README and setup button.

Maintainer contact: [im@meka.im](mailto:im@meka.im). Product site: [meka.im](https://meka.im).
