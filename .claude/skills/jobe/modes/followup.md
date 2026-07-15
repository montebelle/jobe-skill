# Follow-Up Mode

Track and draft follow-up communications.

## Cadence Rules

| Status | First Follow-Up | Subsequent | Max Attempts |
|---|---|---|---|
| Applied | 7 days | Every 7 days | 2 (then mark cold) |
| Responded | 1 day | Every 3 days | No limit |
| Interviewing | Same day (thank-you) | Every 3 days | No limit |

## Display

Read `${WORKSPACE}/data/tracker.md` and `${WORKSPACE}/data/followups.md`. Compute:
- **URGENT**: Response needed within 24 hours
- **OVERDUE**: Past due date
- **Upcoming**: Due within 3 days
- **On track**: Not yet due
- **COLD**: 2+ follow-ups with no response

Show a prioritized list of actions needed.

## Draft Follow-Up Messages

For each overdue or urgent follow-up, draft a message:
- Reference the specific role and something from the evaluation report
- Under 150 words
- Lead with value, not the ask
- NEVER use: "just checking in", "touching base", "circling back", "following up"
- Be specific: mention a project, a skill match, or a question about the team

## Update

After drafting, update `${WORKSPACE}/data/followups.md` with the new follow-up date.

## Data Format (${WORKSPACE}/data/followups.md)

```markdown
| # | App# | Company | Role | Last Action | Last Date | Next Due | Status |
```
