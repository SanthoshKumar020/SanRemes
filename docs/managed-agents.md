# Managed agents

A **managed agent** is a long-running agent defined once and run on a schedule or by
hand: a name, the bot it runs as, what it should do, when it runs, which tools it
may use, and a spend cap. The definition is executor-agnostic: the same agent runs
identically whether its executor is this computer or SanRemes Cloud — only the
executor differs, and the hand-off decision picks it.

## Where they live

The **Managed agents** page sits in the sidebar under Tools, next to Running. It
lists every agent with its schedule, its last run, and its next run; from there
you can create one, run one now, pause or resume it, and delete it. An agent can
also be made from an existing routine: its instructions and schedule come from
the routine, and it keeps following the routine's own firing.

## Where work runs

**Where work runs** on the same page holds the one hand-off setting: `auto`
(wherever is attached), `local` (this computer), or `cloud` (SanRemes Cloud).
The default is this computer until a cloud executor is attached. Asking for the
Cloud without one runs the work here instead and says so in plain words — work
is never silently sent somewhere else, and never silently dropped.

The same decision drives cloud sessions and hosted batches: all three resolve
through one executor registry (`server/executors.ts`).

## Schedules

- **Runs by hand**: only the Run now button (or the API) starts it.
- **Daily**: a local time, every day or on chosen weekdays.
- **Every few minutes**: an interval of 5 to 1,440 minutes.
- **Runs with its routine**: the agent was made from a routine and the routine
  does the work on its own schedule.

A run already going refuses a second one, and a scheduled run that is due while
one is going waits for the next tick.

## Spend caps

An agent may carry a cap in dollars or tokens over a day or a month, counted
from the usage ledger rows its runs booked. A reached cap stops the agent before
it runs, and the stopped run says so in plain words: what it spent, what the
cap is, and that raising the cap or waiting for the period to roll over unblocks
it.

One honest limit: a cap can only stop an agent on usage its runs report. A local
run through a bot turn reports no token counts here (the turn's own usage is
booked by the turn pipeline under its own trigger), so a token cap cannot stop a
local run — the server-wide usage caps are what stop it. A cloud executor that
reports tokens and cost makes the caps bite.

## Cloud sessions and hosted batches

The same page lists **Cloud sessions** — parallel agent sessions sharing a repo,
each on its own `sanremes/<taskId>` branch, opening pull requests — and **Hosted
batches**, the batch runner offered as a cloud job: a bot and a list of prompts,
run one prompt per queued task. Both run through the executor the hand-off
decision resolves. With no cloud executor attached they run on this computer;
the cloud side refuses in plain words until real Cloud infrastructure exists
(see `docs/plans/phase5-notes.md`, "Needs hosted infrastructure").

## Usage for billing

**Usage for billing** on the same page shows this month's managed-agent and
cloud-job use — tokens in and out, and cost where it is priced — with a
downloadable CSV. The same report is at `GET /api/cloud-usage/report`
(`?format=csv` for the CSV), and it is what the Cloud site bills from. It
carries amounts and counts only: no prices are invented here, no payment is
taken here, and checkout lives on the external Cloud site.
