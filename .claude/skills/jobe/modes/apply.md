# Apply Mode

Fill out a job application form using Chrome browser automation. ALWAYS human-in-the-loop: fills everything, shows what was filled, waits for explicit "submit" approval.

## Input
`$ARGUMENTS` after "apply": a company-role slug (matching a reports/ folder) or a URL.

## Prerequisites

1. A completed evaluation must exist in `reports/{slug}/` with resume JSON and DOCX
2. Chrome MCP tools must be available (Claude in Chrome extension connected)
3. `_profile.md` must have contact info

## Step 1: Load Application Data

Read from the evaluation:
- `reports/{slug}/resume-{date}-{slug}.json` for structured resume data
- `reports/{slug}/resume-{date}-{slug}.docx` for file upload
- Contact info from `modes/_profile.md`
- Cover letter text from the JSON's `coverLetter` field

## Step 2: Navigate to Application Page

```
Use mcp__Claude_in_Chrome__tabs_context_mcp to get current tabs.
Use mcp__Claude_in_Chrome__tabs_create_mcp to open a new tab.
Use mcp__Claude_in_Chrome__navigate to go to the job posting URL.
```

Find the "Apply" button:
```
Use mcp__Claude_in_Chrome__find with query "apply button" or "apply now"
Click it to open the application form.
```

## Step 3: Read the Form

```
Use mcp__Claude_in_Chrome__read_page to get all form fields.
```

Identify field types:
- **Contact fields**: name, email, phone, location, LinkedIn URL
- **Resume upload**: file input for resume/CV
- **Cover letter**: text area or file upload
- **Work authorization**: dropdown or radio (select "Yes" if authorized)
- **Experience fields**: current company, title, years
- **Education fields**: school, degree, field of study
- **Free-text questions**: "Why do you want to work here?", "Describe relevant experience", etc.
- **Salary expectations**: use comp data from evaluation Block D
- **Referral source**: select "Company website" or "Job board"

## Step 4: Fill Fields

For each identified field:

**Contact info** (from _profile.md):
```
Use mcp__Claude_in_Chrome__form_input to fill name, email, phone, LinkedIn.
```

**Resume upload**:
```
Use mcp__Claude_in_Chrome__find to locate the file input element.
Use mcp__Claude_in_Chrome__file_upload with the resume DOCX path.
```

**Cover letter**: 
If text area: paste the coverLetter content from the JSON.
If file upload: upload the cover-letter DOCX.

**Work authorization**: Read from `_profile.md` (candidate's declared authorization status).

**Experience/Education**: Fill from _profile.md and resume JSON.

**Free-text questions**: Generate answers using:
- The evaluation analysis (Block B portfolio match, Block F STAR stories)
- JD requirements (from the JSON)
- Company research (from the evaluation)
- Keep answers concise (150-250 words per question)
- Use specific metrics and projects, not generic statements
- Apply Talebian lenses: lead with antifragile claims, address inversion concerns

**Salary**: Use the midpoint from Block D compensation research. If the field is optional, leave blank.

## Step 5: Review Before Submit

CRITICAL: DO NOT CLICK SUBMIT. Instead:

1. Take a screenshot of the filled form:
```
Use mcp__Claude_in_Chrome__computer with action "screenshot"
```

2. Show the user everything that was filled:
```
=== APPLICATION REVIEW ===

Company: {company}
Role: {role}
URL: {posting URL}

Fields filled:
- Name: {candidate name from _profile.md}
- Email: {candidate email from _profile.md}
- Phone: {candidate phone from _profile.md}
- Resume: {filename}.docx (uploaded)
- Cover letter: {first 100 chars}...
- Work authorization: Yes
- [Free-text Q1]: {first 100 chars}...
- [Free-text Q2]: {first 100 chars}...
- Salary: {amount or "left blank"}

READY TO SUBMIT. Type "submit" to proceed, or tell me what to change.
```

3. Wait for explicit user confirmation.

## Step 6: Submit (only after approval)

Only after the user explicitly says "submit", "yes", "go", or "send":

```
Use mcp__Claude_in_Chrome__find to locate the submit button.
Use mcp__Claude_in_Chrome__computer with action "left_click" on the submit button.
```

After submission:
1. Take a confirmation screenshot
2. Update tracker: change status from "Evaluated" to "Applied"
3. Add entry to `data/followups.md` with next follow-up date (7 days from now)
4. Report success to user

## Step 7: Handle Edge Cases

- **Multi-page forms**: After each page, fill visible fields, click "Next", repeat
- **CAPTCHA/bot detection**: Stop and tell user "I've encountered a CAPTCHA. Please complete it manually and tell me when done."
- **Login required**: Stop and tell user "This application requires you to log in first. Please log in and tell me when ready."
- **Form errors**: Screenshot the error, report to user, suggest fixes
- **Required fields I can't fill**: List them and ask user to provide the information

## NEVER

- Never click Submit without explicit user approval
- Never guess at answers for questions about disability, veteran status, or demographics (leave blank or select "Prefer not to answer")
- Never enter salary information without asking the user first
- Never create accounts on the user's behalf
- Never enter passwords or authentication credentials
