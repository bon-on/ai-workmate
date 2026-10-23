---
id: lab-followup
title: Turn research results into follow-up work
status: maintained
related_adrs:
  - shared-evidence
related_contracts:
  - verification
---
# Lab follow-up
## Problem
Completed reports only offer archive/discard; unread results appear indefinitely on Today.
## Scope
- Read state, parent-linked follow-up schedules, archive recovery.
## Acceptance Criteria
- Read results stay in the lab but no longer count as new results.
- Practice, implementation and research require a user-selected topic and link to the original report.
- Follow-ups use the original workspace and existing scheduler, sandbox and result delivery.
- Archived results remain accessible and can be restored without deleting files.
- Active jobs cannot be archived; polling preserves expanded results.
- Dashboard research requests are due immediately, not at a fixed nightly time; explicit schedules remain unchanged.
- One request form defaults to general requests; opting into a research report records results in the lab. The lab links back to that form rather than duplicating it.
- Operational failures appear under automation, not research decisions, with per-execution error details.
- Every completed lab result has a Markdown report in the workspace: the report the job wrote, or the result summary saved under documents/reports/YYYY-MM/YYYY-MM-DD-<lab id>.md.
- Markdown/text documents open in an in-dashboard viewer that works on a phone without downloading; rendering escapes document HTML and allows only http(s)/mailto links.
## Constraints
- Do not launch real AI jobs or alter user results during tests.
## Evidence
- test/lab-followup.test.js: read state, practice/research/implement follow-ups, original workspace, archive and restore, active-job archive guard, emitted polling JavaScript and immediate dashboard research.
- test/documents.test.js and test/claude-primary-gaps.test.js: report reuse and fallback Markdown for lab results.
- test/markdown-render.test.js: viewer rendering and escaping.
- npm run verify:harness
