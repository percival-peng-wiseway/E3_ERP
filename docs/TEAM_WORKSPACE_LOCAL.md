# Team Workspace

Production uses Cloudflare D1 (`erp_documents`, key `team-workspace/entries`) for
weekly plans, tasks, feedback, notifications and audit metadata. Attachments use
ERP_FILES keys under `team-workspace/attachments/` and authenticated API downloads.
Missing cloud bindings fail closed. Concurrent saves use document compare-and-swap,
with bounded retries for unrelated edits and per-entry version conflicts for stale
forms. Tasks and notifications commit atomically. Image previews only allow PNG,
JPEG, GIF and WebP signatures; other formats download as attachments.

Local development (`npm run dev`) continues to use isolated files under
`.data/team-workspace`, even if other ERP modules use remote read-only data.
TEAM_WORKSPACE_DATA_DIR can isolate test runs. Local demo tasks and files are not
migrated by deployment. The existing ERP_DB and ERP_FILES bindings suffice; this
feature needs no new migration or secrets.

## Weekly tasks & goals

Six fixed cards: RuiHan, Sam, Wendy, Hogan, Kevin and JiaQi. Each Monday–Sunday week
contains the previous week's completed work and the selected week's plan. Everyone can read; only the card's
owner can edit. Compact cards are grouped into Sales & Marketing (RuiHan, Sam),
Procurement (Kevin), Operation (Hogan, Wendy), and Finance & HR (JiaQi). Cards open
an enlarged report with dated, collapsible prior weeks.

## Task requests

Admins create a request assigned to any active employee, including another admin.
One inline card contains due date, assigner, assignee and requirements on the left;
attachments, status, Employee feedback and Admin feedback on the right. Feedback
fields persist independently and are editable only by their respective authors.

- Employee Save starts/resumes work; Request review sends it for acceptance.
- Admin Send feedback returns it for changes. Done requires pending review.
- Upload supports multiple files, max 10 MB each and 30 per task. Images have
  thumbnails and enlarged previews; ordinary files have download links.
- Task history is retained in storage but not displayed as a timeline.
- Every update notifies active admins at High priority. Creation, reassignment,
  feedback and acceptance also notify the assignee. Reminders are grouped by task
  and recipient in Home and Team Workspace, with a 30-second workspace refresh.
- Installer accounts can access Team Workspace in addition to Home and Time Table.
- Notifications are in-app only; no email or SMS is configured.

The current versioned document has the ERP storage layer's 1.9 MB safety limit.
When growing beyond that limit, partition records before expanding retention.
An ambiguous storage failure may leave an unattached upload for later cleanup;
never delete a file whose metadata commit may have succeeded.

Validation: `npm run typecheck` and
`node --experimental-strip-types --test src/lib/team-workspace/*.test.ts`.
