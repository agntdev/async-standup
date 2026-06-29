# Async Standup Bot — Bot specification

**Archetype:** workflow

**Voice:** professional and encouraging — write every user-facing message, button label, error, and empty state in this voice.

Automates asynchronous daily standups by prompting team members with configurable questions at their local time, collecting responses, and posting a digest to a team channel. Tracks participation, highlights blockers, and maintains a searchable history of responses.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- team leads
- engineering teams
- product teams

## Success criteria

- Daily digests posted to team channels with 100% completion tracking
- 95%+ user participation rate in standups
- Blockers flagged in digest with 24hr visibility
- 90-day searchable history of standup responses

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with team setup options for admins or join prompt for new users
- **Create Team** (button, actor: admin, callback: team:create) — Initialize new team with custom schedule and questions
- **Join Team** (button, actor: user, callback: join:link) — Accept invite link to become team member
- **View History** (button, actor: user, callback: history:recent) — Request last 30 standup runs with filters

## Flows

### Daily Standup Run
_Trigger:_ scheduled local time

1. Send private prompt with questions
2. Track responses/skips
3. Send nudge if unresponsive
4. Compile digest at cutoff

_Data touched:_ Team, Member, Standup Run

### Admin Setup
_Trigger:_ /start

1. Create team
2. Configure schedule/questions
3. Generate invite link

_Data touched:_ Team, Question Set

### Digest Generation
_Trigger:_ cutoff time reached

1. Aggregate responses
2. Format digest with blockers
3. Post to team channel

_Data touched:_ Standup Run, Digest

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Team** _(retention: persistent)_ — Workspace configuration with schedule, questions, and channel link
  - fields: name, channel_id, schedule, questions, timezone_policy
- **Member** _(retention: persistent)_ — User profile with participation history and timezone
  - fields: telegram_id, display_name, timezone, response_history
- **Standup Run** _(retention: persistent)_ — Single day's standup data including responses and statuses
  - fields: run_date, participants, answers, status
- **Digest** _(retention: persistent)_ — Formatted summary of completed standup run
  - fields: run_date, responses, blockers, pending_users

## Integrations

- **Telegram** (required) — Private messaging and channel posting
- **Invite Link System** (required) — User onboarding and team membership
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create/edit team configurations
- Generate and revoke invite links
- Customize question sets
- View participation metrics

## Notifications

- Private standup prompts with quick reply options
- Digest posts to team channel
- Reminder nudges for non-responders

## Permissions & privacy

- Private prompts only to invited members
- Digests posted to configured channel only
- Response history visible only to team members with channel access

## Edge cases

- Users across multiple timezones in same team
- Late-joining members after run starts
- Empty blocker answers not flagged
- Invite link expiration/reuse

## Required tests

- End-to-end run from prompt to digest with 3-member team
- Nudge suppression after cutoff
- History search across 90-day window
- Blocker flagging in digest formatting

## Assumptions

- Invite links are manually distributed by admins
- Timezone detection from Telegram profile is reliable
- Digest cutoff time is 24hrs after prompt
