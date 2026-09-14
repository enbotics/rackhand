# Event-triggered tomorrow plans

Sheet edit → signed webhook → durable debounced inbox → queued plan card → safe-idle analysis → readiness report.

## Enable on the warehouse-owning EC2/PM2 Node deployment

1. Run `npm run db:deploy` and `npm run build` before restarting the app.
2. Set `ENGINEERING_PLAN_SHEET_RANGE=UpdatedPlan!A1:O250`, `ENGINEERING_PLAN_TIME_ZONE=Asia/Ulaanbaatar`, `ENGINEERING_PLAN_AUTO_ENABLED=true`, and `ENGINEERING_PLAN_WEBHOOK_SECRET` to a random secret of at least 32 characters. Keep the existing spreadsheet ID and read-only service-account credentials.
3. Restart PM2 with its updated environment. Do not enable the automatic worker in separate local deployments pointing at the same physical warehouse. The simulator is process-local; keep PM2 in single-instance fork mode until hardware status is external.
4. Open the Sheet → Extensions → Apps Script. Paste [the supplied script](../hardware/google-sheets/rackhand-plan-trigger.gs).
5. In Project Settings → Script Properties set:
   - `RACKHAND_WEBHOOK_URL`: `https://warehouse.enbotics.tech/api/agent/plan-analysis/sheet-change`
   - `RACKHAND_WEBHOOK_SECRET`: exactly the same server secret.
   - `RACKHAND_TIME_ZONE`: `Asia/Ulaanbaatar`.
6. Run `installRackHandPlanTriggers` once, authorize it as the Sheet owner/editor, and check Apps Script Executions for successful delivery. Installation submits the initial snapshot. No Pi changes are needed.

## Behavior

- Editing UpdatedPlan, structural changes, and the first Sheet open each day send an event. Script/API writes do not fire Google's edit triggers: integrations must invoke `sendRackHandPlanChange` or send the authenticated webhook themselves. Failed deliveries report an honest Apps Script execution error and retry with a fresh signature up to five times using one-off delivery timers. After retries are exhausted, resend the event manually when connectivity is restored. These are event-delivery retries, not scheduled Sheet scans or autonomous audit schedules.
- The signed event carries only the spreadsheet ID and timestamp. The server re-reads tomorrow's enabled PREPARE/RELEASED rows using its existing read-only Sheets integration. Edits debounce for 15 seconds. Only actionable content/date changes create analyses; older/replayed signals do not restart the queue.
- A waiting version is replaced by newer requirements. An active audit completes its current safe bin return; the next audit yields to pending Sheet updates and submitted client requests.
- The persisted queue drains every 10 seconds on the Node server even without a browser. This is queue/idle checking, not camera or Sheet polling. Read failures retain the event and back off 60 seconds.
- Before each automatic audit: acquire the shared database hardware lease, recheck client activity, pending approvals, bin statuses, unfinished movements, active audits, and gantry readiness/home. Audits hold the lease through capture and shelf return. Client approval waits for the current safe hardware cycle, rather than interrupting movement. Leases heartbeat; lost/restarted processes are not treated as completed physical work.
- Completed-bin evidence and attempted targets are checkpointed between audits. Pausing resumes from that checkpoint, without asking the planner to redo its requirements. Interrupted running analyses fail honestly after heartbeat loss; they are not blindly replayed. Existing physical-recovery guards still protect uncertain bin positions.
- Automatic plan cards are warehouse-wide because the Sheet plan is shared. Client chats, approvals and camera decisions remain session-scoped. The progress card uses short-lived status requests, not another permanent browser stream. Refresh does not lose queued or running work.
- Build-plan analysis has no HITL and never retrieves fulfillment materials. Unsafe observations remain report issues, not hidden approval prompts. `/trig` remains the manual, session-scoped option.

Disable new automatic work by setting `ENGINEERING_PLAN_AUTO_ENABLED=false` and restarting. Do this only after an active bin has returned safely; stopping a process mid-motion is not an abort mechanism.

Google references: [Installable triggers and their restrictions](https://developers.google.com/apps-script/guides/triggers/installable), [UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app), [HMAC utilities](https://developers.google.com/apps-script/reference/utilities/utilities).
