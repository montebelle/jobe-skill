# Contacto Mode

Draft LinkedIn outreach messages for job applications.

## Input
`$ARGUMENTS` after "contacto": company name, role, and optionally contact type.

## 4 Contact Types

### Recruiter
- Mention you applied for the specific role
- Brief hook (one sentence about your most relevant experience)
- Ask if the role is still active
- Professional, concise

### Hiring Manager
- A hook specific to their team's work
- Reference a specific initiative, publication, or announcement from company research
- Connect your experience directly to their team's challenges
- Do NOT ask for a referral; express interest in the role

### Peer (Team Member)
- Ask about team culture, how the work is done, or what they enjoy about the role
- Mention a shared professional interest
- Genuine, curious tone
- Do NOT mention you're applying (let conversation develop naturally)

### Interviewer (Post-Interview)
- Thank them for the conversation
- Reference something specific from the interview
- Reiterate one point you wish you'd expanded on
- Brief (2-3 sentences)

## Constraints
- **300 characters max** (LinkedIn connection request limit)
- Every message references specific JD requirements and portfolio evidence. Portfolio evidence comes from `${WORKSPACE}/reference.md`; the JD and analysis for the role come from its report folder, which can sit in any lifecycle bucket (`${WORKSPACE}/reports/{bucket}/{slug}/`). Resolve it from `${JOBE_HOME}`:
  ```bash
  node -e "console.log(require('./lib/tracker-writer').locateReportDir(require('./lib/config').getProjectRoot(), '{slug}'))"
  ```
- Real figures only, and no term from the user's do not render list (`output.forbiddenTerms`)
- NO generic templates
- NO "I'd love to connect" without substance
- NO copy-paste vibes

## Known contacts (optional)
If `${WORKSPACE}/data/contacts.json` exists, check it first (from `${JOBE_HOME}`): `node -e "console.log(JSON.stringify(require('./lib/network').referralStatus('<company>'), null, 2))"`. It matches the user's own contacts to the company (`strong-tie`, `weak-tie`, or `cold`), and a real connection changes which contact type to draft. Never invent a contact.

## Output
Draft the message. Show the character count. The user reviews and sends it themselves; never send a message or a connection request on their behalf.
