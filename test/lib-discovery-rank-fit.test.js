'use strict';
// lib/rank.js fullScore calibration. Two bars, synthetic data only (a
// registered nurse and a tax accountant; no real person, employer, or posting):
//   1. a user with a full hand rated skill table is scored by the rated
//      coverage formula alone (mean level of the rated skills the JD names);
//   2. a user who rated nothing, or a few skills, is scored on full length job
//      descriptions in every common shape: exact fit 80 or above, partial fit
//      65 to 79, adjacent role 55 to 64, unrelated role below 55.
// Also pinned: side sections of any wording (under a requirements heading
// too), unmet duties under a heading of any wording, an employer named after
// the user's field, a snippet in place of a posting, a posting in the
// employer's own voice, look alike words from another field, and a library of
// hundreds of bullets. Each profile lives in its own temp workspace; the process root is
// an empty temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-rank-fit-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body));
  }
  return root;
}

process.env.JOBE_USER_ROOT = workspace();
const { buildProfile, fullScore, EMPTY_PROFILE } = require('../lib/rank');

// --- Fixtures ---------------------------------------------------------------
const b = (id, text, keywords) => ({ id, text, keywords });
const NURSE_BULLETS = [
  b('n1', 'Managed a five patient assignment on a 32 bed medical surgical unit, completing head to toe patient assessment each shift.', ['patient assessment', 'medical surgical', 'acute care']),
  b('n2', 'Cut medication administration errors 40 percent by leading the barcode scanning rollout on the unit.', ['medication administration', 'barcode scanning', 'patient safety']),
  b('n3', 'Started and maintained peripheral IV therapy for 12 patients a day, with a first attempt success rate of 92 percent.', ['IV therapy', 'IV insertion', 'phlebotomy']),
  b('n4', 'Lowered hospital acquired pressure injuries by a third through a weekly wound care round and turning schedule.', ['wound care', 'pressure injury prevention']),
  b('n5', 'Monitored telemetry for cardiac step down patients and escalated early signs of deterioration to the rapid response team.', ['telemetry', 'cardiac monitoring', 'rapid response']),
  b('n6', 'Wrote individualized care plans with physicians, pharmacists, and therapists during daily interdisciplinary rounds.', ['care plans', 'interdisciplinary rounds', 'care coordination']),
  b('n7', 'Led discharge planning for 8 patients a day, lowering 30 day readmissions on the unit from 14 to 9 percent.', ['discharge planning', 'readmission reduction', 'case management']),
  b('n8', 'Taught patients and families about medications, diabetes management, and home care before discharge.', ['patient education', 'diabetes management', 'family education']),
  b('n9', 'Documented assessments, interventions, and outcomes in Epic within the hour for every patient.', ['Epic', 'electronic health records', 'clinical documentation']),
  b('n10', 'Served as relief charge nurse for 12 staff, making patient assignments and handling bed flow each shift.', ['charge nurse', 'staffing', 'patient flow']),
  b('n11', 'Precepted 9 new graduate nurses through a 12 week orientation, all retained past one year.', ['precepting', 'orientation', 'mentoring']),
  b('n12', 'Managed post operative patients after orthopedic and abdominal surgery, including pain management and early mobility.', ['post operative care', 'pain management', 'early mobility']),
  b('n13', 'Responded to 30 code blue and rapid response events as a trained first responder with current ACLS.', ['code blue', 'ACLS', 'BLS']),
  b('n14', 'Reduced catheter associated urinary tract infections to zero for 11 months with a nurse driven removal protocol.', ['infection control', 'infection prevention', 'quality improvement']),
  b('n15', 'Administered blood transfusions and monitored for reactions under hospital policy.', ['blood transfusion', 'blood administration']),
  b('n16', 'Performed blood glucose monitoring and insulin administration for diabetic patients on sliding scale orders.', ['blood glucose monitoring', 'insulin administration']),
  b('n17', 'Cut falls on the unit by 25 percent with hourly rounding and bed alarm audits.', ['fall prevention', 'hourly rounding']),
  b('n18', 'Gave structured SBAR handoff reports at shift change and during transfers to other units.', ['SBAR', 'handoff', 'shift report']),
  b('n19', 'Cared for patients with tracheostomy, chest tubes, and feeding tubes, including suctioning and tube feeding.', ['tracheostomy care', 'chest tubes', 'tube feeding']),
  b('n20', 'Collected lab specimens and reviewed lab results, notifying physicians of critical values within 15 minutes.', ['specimen collection', 'lab results', 'critical values']),
  b('n21', 'Raised patient satisfaction scores for nurse communication from the 48th to the 77th percentile.', ['patient satisfaction', 'communication', 'bedside manner']),
  b('n22', 'Supported patients and families through end of life care with the palliative care team.', ['palliative care', 'end of life care']),
  b('n23', 'Chaired the unit practice council and rewrote the admission checklist used by 60 nurses.', ['unit council', 'evidence based practice', 'policy development']),
  b('n24', 'Admitted and transferred patients, completing medication reconciliation with pharmacy for each one.', ['admission', 'medication reconciliation', 'patient transfer']),
  b('n25', 'Delegated tasks to nursing assistants and licensed practical nurses and supervised their work.', ['delegation', 'supervision', 'teamwork']),
  b('n26', 'Applied isolation precautions and safe patient handling for patients with infectious disease.', ['isolation precautions', 'safe patient handling']),
];
const NURSE_BASELINE = {
  skills: { Clinical: 'Patient Assessment, Medication Administration, IV Therapy, Wound Care, Telemetry', Certifications: 'Registered Nurse License, BLS, ACLS', Systems: 'Epic, Pyxis' },
  education: [{ degree: 'Bachelor of Science in Nursing', school: 'Example State University' }],
};
const ACCT_BULLETS = [
  b('a1', 'Prepared 140 individual and business tax returns each season with a 98 percent first pass acceptance rate.', ['tax preparation', 'tax returns', 'individual tax']),
  b('a2', 'Prepared federal and state corporate income tax returns for 35 S corporation and partnership clients.', ['corporate tax', 'partnership returns', 'S corporation', 'federal and state tax']),
  b('a3', 'Researched tax law changes and wrote memos on client positions, citing the code and regulations.', ['tax research', 'tax law', 'technical memos']),
  b('a4', 'Calculated quarterly estimated tax payments and annual tax provision for 20 business clients.', ['estimated tax payments', 'tax provision', 'tax planning']),
  b('a5', 'Reconciled general ledger accounts to supporting schedules before each filing.', ['general ledger', 'account reconciliation', 'reconciliation']),
  b('a6', 'Represented 15 clients in audits and notices from tax authorities, closing 12 with no change.', ['tax audit', 'tax notices', 'client representation']),
  b('a7', 'Prepared multistate sales and use tax returns and reviewed nexus for e commerce clients.', ['sales and use tax', 'multistate tax', 'nexus']),
  b('a8', 'Reviewed returns prepared by 4 junior staff and coached them on workpaper standards.', ['return review', 'workpapers', 'staff training']),
  b('a9', 'Built Excel models to project tax liability under different entity structures.', ['Excel', 'tax projections', 'entity structure']),
  b('a10', 'Used tax software and a document management system to prepare, file, and archive returns.', ['tax software', 'e-filing', 'document management']),
  b('a11', 'Prepared depreciation schedules and fixed asset rollforwards for 30 clients.', ['depreciation', 'fixed assets']),
  b('a12', 'Closed the books monthly for 8 small business clients, including bank reconciliation and journal entries.', ['month-end close', 'bank reconciliation', 'journal entries', 'bookkeeping']),
  b('a13', 'Prepared payroll tax filings and year end wage statements for 25 employers.', ['payroll tax', 'year end reporting']),
  b('a14', 'Compiled financial statements under generally accepted accounting principles for lender packages.', ['financial statements', 'GAAP', 'compilation']),
  b('a15', 'Advised clients on deductions, credits, and retirement contributions, saving a median of 9 percent in tax.', ['deductions and credits', 'client advisory', 'tax savings']),
  b('a16', 'Managed a portfolio of 120 client relationships and answered tax questions within one business day.', ['client relationships', 'client communication']),
  b('a17', 'Prepared trust and estate income tax returns and gift tax returns for 18 families.', ['trust and estate tax', 'gift tax']),
  b('a18', 'Tracked filing deadlines and extensions for 300 returns with no late filings in four seasons.', ['filing deadlines', 'extensions', 'compliance']),
  b('a19', 'Converted 40 clients to cloud accounting software and cleaned up their charts of accounts.', ['accounting software', 'chart of accounts', 'QuickBooks']),
  b('a20', 'Analyzed the tax effect of equipment purchases and entity changes for owner managed businesses.', ['tax analysis', 'small business']),
  b('a21', 'Prepared accounts payable and accounts receivable agings for monthly client reporting.', ['accounts payable', 'accounts receivable', 'aging reports']),
  b('a22', 'Documented internal controls over cash for three nonprofit clients ahead of their annual audit.', ['internal controls', 'nonprofit accounting', 'audit support']),
  b('a23', 'Prepared information returns and reviewed vendor forms each January for 60 businesses.', ['information returns', 'vendor compliance']),
  b('a24', 'Presented year end tax planning meetings to business owners with written recommendations.', ['year end planning', 'presentations', 'recommendations']),
];
const ACCT_BASELINE = {
  skills: { Tax: 'Tax Preparation, Tax Research, Tax Planning, Multistate Tax', Credentials: 'Certified Public Accountant, CPA', Software: 'Excel, QuickBooks, Tax Software' },
  education: [{ degree: 'Bachelor of Science in Accounting', school: 'Example State University' }],
};

// --- JD parts -------------------------------------------------------------
const J = {
  nurse: {
    company: 'Example Regional Hospital', title: 'Registered Nurse, Medical Surgical',
    intro: 'Example Regional Hospital is a 210 bed community hospital that has served three counties since 1958. Our nurses tell us they stay because of the people they work with. We are looking for a Registered Nurse to join our medical surgical unit on the day shift.',
    held: [
      'Complete a head to toe patient assessment at the start of each shift and reassess as conditions change',
      'Provide safe medication administration, including IV therapy, using barcode scanning',
      'Perform wound care and follow the pressure injury prevention protocol',
      'Monitor telemetry and respond to changes in cardiac rhythm',
      'Develop and update care plans with the interdisciplinary team during daily rounds',
      'Lead discharge planning and patient education for patients and their families',
      'Document assessments and interventions in Epic in a timely manner',
      'Care for post operative patients, including pain management and early mobility',
      'Follow infection control and fall prevention practices on every shift',
      'Give SBAR handoff at shift change and delegate tasks to nursing assistants',
    ],
    unheld: [
      'Titrate vasoactive drips and manage ventilator settings for intubated patients',
      'Circulate in the operating room and maintain the sterile field during procedures',
      'Perform hemodialysis treatments and cannulate fistulas and grafts',
      'Triage walk in emergency patients using the emergency severity index',
      'Assist with labor and delivery, including fetal heart monitoring',
      'Administer chemotherapy and manage central line ports for oncology infusions',
      'Run continuous renal replacement therapy and invasive hemodynamic monitoring',
      'Conduct utilization review against payer criteria and submit prior authorizations',
      'Perform pediatric sedation monitoring and neonatal resuscitation',
      'Scrub for endoscopy procedures and reprocess scopes',
    ],
    qualsShort: ['Current Registered Nurse license in the state', 'Bachelor of Science in Nursing preferred', 'Current BLS certification, ACLS within six months', '2+ years of acute care experience', 'Strong communication and teamwork skills', 'Able to work rotating weekends'],
    qualsLong: ['You hold a current Registered Nurse license in the state, and a Bachelor of Science in Nursing is preferred.', 'You have at least two years of recent acute care experience on a medical surgical or telemetry unit and current BLS certification.', 'You communicate clearly with patients, families, and physicians, and you are comfortable with teamwork on a busy unit.'],
  },
  accountant: {
    company: 'Example and Partners', title: 'Tax Accountant',
    intro: 'Example and Partners is a 40 person public accounting firm serving owner managed businesses and their families since 1987. We keep a 50 hour cap in busy season and mean it. We are hiring a Tax Accountant for our business tax group.',
    held: [
      'Prepare federal and state tax returns for individuals, partnerships, and S corporation clients',
      'Research tax law questions and write technical memos supporting client positions',
      'Calculate quarterly estimated tax payments and the annual tax provision',
      'Reconcile general ledger accounts and prepare journal entries before each filing',
      'Respond to tax notices and support clients through a tax audit',
      'Prepare multistate sales and use tax returns and review nexus',
      'Review returns and workpapers prepared by junior staff',
      'Build Excel models for tax projections and year end tax planning',
      'Prepare depreciation schedules and maintain fixed assets records',
      'Manage client relationships and track filing deadlines and extensions',
    ],
    unheld: [
      'Lead the annual operating budget and rolling forecast with department heads',
      'Underwrite commercial loans and spread borrower cash flow',
      'Perform technical accounting for derivatives and hedge documentation',
      'Run the equity compensation plan and cap table administration',
      'Build transfer pricing studies and benchmark intercompany margins',
      'Plan and execute external audit fieldwork, including substantive testing and sampling',
      'Administer the treasury function, including cash pooling and foreign exchange hedging',
      'Prepare actuarial reserve estimates for the insurance carrier',
      'Configure the revenue recognition module during the enterprise system migration',
      'Model mergers and acquisitions valuation and purchase price allocation',
    ],
    qualsShort: ['Bachelor degree in accounting', 'CPA license or actively pursuing', '3+ years of public accounting experience', 'Working knowledge of tax software and MS Excel', 'Strong attention to detail', 'Able to meet deadlines in busy season'],
    qualsLong: ['You hold a bachelor degree in accounting and a CPA license, or you are actively working toward one.', 'You bring at least three years of recent public accounting experience preparing business tax returns, with a working knowledge of tax software and MS Excel.', 'You pay close attention to detail, communicate clearly with clients, and meet deadlines in busy season.'],
  },
};
// Roles next to each profession, and roles far from both.
const EXTRA = {
  nurseAdjacent: { company: 'Example Health Plan', title: 'Hospital Case Manager',
    intro: 'Example Health Plan coordinates care for 60,000 members across the region. We are hiring a Hospital Case Manager to work with our partner hospitals.',
    held: ['Assess patient needs at admission and build the discharge planning timeline with the care team', 'Arrange home care, medical equipment, and placement with community agencies', 'Conduct utilization review against payer criteria',
      'Submit prior authorizations and appeal denied claims', 'Give patient education to patients and families about medications and follow up care', 'Attend interdisciplinary rounds and track length of stay',
      'Document case notes in the electronic health records system', 'Call patients after discharge to lower readmission rates'],
    qualsShort: ['Registered Nurse or social work license', '3+ years of acute care experience', 'Case management certification preferred', 'Comfortable with payer rules'],
    qualsLong: ['You hold a Registered Nurse or social work license and have at least three years of acute care experience.', 'Case management certification is preferred, and you are comfortable with payer rules.'] },
  accountantAdjacent: { company: 'Example Manufacturing Group', title: 'Financial Analyst',
    intro: 'Example Manufacturing Group makes packaging equipment at four plants. We are hiring a Financial Analyst to support plant controllers and the finance director.',
    held: ['Build the annual budget and the monthly rolling forecast with plant managers', 'Analyze variances between actual results and plan and explain the drivers', 'Prepare monthly management reporting packages for leadership',
      'Reconcile general ledger accounts and support the month end close', 'Build Excel models for pricing and capital investment decisions', 'Maintain dashboards in the business intelligence tool',
      'Partner with operations on inventory and standard cost analysis', 'Complete ad hoc analysis for the finance director'],
    qualsShort: ['Bachelor degree in finance or accounting', '3+ years of financial planning and analysis experience', 'Advanced Excel skills', 'Comfortable presenting to senior leaders'],
    qualsLong: ['You hold a bachelor degree in finance or accounting and bring at least three years of financial planning and analysis experience.', 'You have advanced Excel skills and are comfortable presenting to senior leaders.'] },
  warehouse: { company: 'Example Freight Lines', title: 'Warehouse Supervisor',
    intro: 'Example Freight Lines moves 9,000 pallets a week through its regional distribution center. We are hiring a Warehouse Supervisor for second shift.',
    held: ['Supervise 25 forklift operators and pickers across inbound and outbound docks', 'Plan dock schedules and assign trailers to doors', 'Run cycle counts and investigate inventory variances in the warehouse management system',
      'Enforce lockout and forklift safety rules and lead toolbox talks', 'Track pick rates and coach associates who fall behind', 'Coordinate carrier pickups and resolve freight claims',
      'Train new associates on scanners and pallet jacks', 'Keep aisles, racking, and loading equipment in good repair'],
    qualsShort: ['High school diploma or equivalent', '2+ years of warehouse leadership', 'Forklift certification', 'Able to lift 50 pounds'],
    qualsLong: ['You have a high school diploma or equivalent and at least two years leading a warehouse crew.', 'You hold a forklift certification and can lift 50 pounds.'] },
  marketing: { company: 'Example Outdoor Goods', title: 'Marketing Coordinator',
    intro: 'Example Outdoor Goods sells camping gear online and through 200 retailers. We are hiring a Marketing Coordinator for the brand team.',
    held: ['Schedule social media posts and write captions in the brand voice', 'Build email campaigns and segment subscriber lists', 'Coordinate photo shoots with freelancers and agencies',
      'Update product pages and search keywords on the storefront', 'Track campaign results in the analytics dashboard', 'Prepare trade show materials and retailer sell sheets',
      'Manage the influencer gifting calendar', 'Proofread copy for catalogs and packaging'],
    qualsShort: ['Bachelor degree in marketing or communications', '1+ years in a marketing role', 'Experience with an email platform and a design tool', 'Strong writing skills'],
    qualsLong: ['You hold a bachelor degree in marketing or communications and have at least a year in a marketing role.', 'You have used an email platform and a design tool, and you write well.'] },
};
const FLUFF = 'Our mission is to improve the lives of the people and communities we serve, and our values of respect, integrity, and curiosity guide every decision. We invest in growth through mentorship, clear career paths, and regular feedback, and we celebrate wins together. If you want to do meaningful work alongside colleagues who care, you will feel at home here.';
const BENEFITS = 'We offer medical, dental, and vision coverage from day one, a retirement plan with employer match, tuition reimbursement, and generous paid time off.';
const PAY = 'The pay range for this position is $68,000 to $96,000 per year, depending on experience.';
const EEO = 'We are an equal opportunity employer. All qualified applicants will receive consideration for employment without regard to race, color, religion, sex, sexual orientation, gender identity, national origin, disability, or veteran status.';
const APPLY = 'To apply, submit your resume through our careers page. Applicants who need an accommodation during the hiring process may contact human resources.';
const SCHEDULE_LIST = '- Monday to Friday, 8am to 5pm\n- Occasional weekend coverage\n- On site, with free parking';
const BENEFITS_LIST = '- Medical, dental, and vision coverage\n- Retirement plan with employer match\n- Paid time off and paid holidays\n- Tuition reimbursement\n- Employee assistance program';
const SCHEDULE = 'Monday to Friday, 8am to 5pm, with occasional weekend coverage. This position is based on site.';

// Sections that are neither duties nor requirements, worded outside any list a
// scorer could carry: perks as noun phrases, working conditions, screening.
const ASIDES = {
  nurse: [['Why Example Regional', ['Magnet designated since 2015', 'Free parking and a staffed cafeteria', 'Relocation assistance for moves over 50 miles', 'Shared governance and a clinical ladder', 'Student loan forgiveness', 'Wellness program and uniform allowance']],
    ['Physical demands', ['Standing and walking for most of a 12 hour shift', 'Lifting and moving up to 50 pounds', 'Possible exposure to bloodborne pathogens']],
    ['Other information', ['Offers are contingent on a background check and drug screen', 'Proof of vaccination is needed before the first day']]],
  accountant: [['Life at the firm', ['Summer Fridays and a stocked kitchen', 'Annual retreat at a lake lodge', 'Firm paid professional dues', 'Volunteer days and a charity match', 'Downtown office near the train', 'Mentor pairing from the first week']],
    ['Other information', ['Offers are contingent on a background check', 'Evening and Saturday hours are expected from February to April', 'Occasionally lift file boxes of up to 30 pounds']]],
};
// The same sections under headings that say Requirements.
const REQ_WORDED = { 'Physical demands': 'Physical Requirements', 'Other information': 'Additional Requirements' };
// form: 'list' (dash items) | 'lines' (bare lines) | 'prose' (heading, then sentences) | 'label' ("Heading: sentences", for running text)
const asides = (who, form, reqWorded) => ASIDES[who].map(([h0, items]) => [(reqWorded && REQ_WORDED[h0]) || h0, items]).map(([h, items]) => (form === 'list' ? `${h}\n${items.map((i) => `- ${i}`).join('\n')}`
  : form === 'lines' ? `${h}\n${items.join('\n')}` : form === 'prose' ? `${h}\n${items.join('. ')}.` : `${h}: ${items.join('. ')}.`)).join(form === 'label' ? ' ' : '\n\n');

// Build one JD. opts: k (held duties), n (total duties), other (source of unmet duties: 'unheld' or another profession's part),
// style: 'headed' | 'plain' (headed, list items as bare lines, as stripped HTML reads) | 'inline' (heading shares a line with content)
//   | 'flat' (single line, no headings) | 'prose' (no headings, newlines)
// quals: 'short' | 'long' | 'none', trailing: bool
function jd(part0, { k = 10, n = 10, unmet = part0.unheld, style = 'headed', quals = 'short', trailing = true, fluff = false } = {}) {
  const part = fluff ? { ...part0, intro: `${part0.intro} ${FLUFF}` } : part0;
  const duties = [...part.held.slice(0, k), ...(unmet || []).slice(0, n - k)];
  const q = quals === 'short' ? part.qualsShort : quals === 'long' ? part.qualsLong : [];
  const tail = !trailing ? [] : trailing === 'list' ? [['Schedule', SCHEDULE_LIST], ['Pay range', '$68,000 to $96,000 per year'], ['Benefits', BENEFITS_LIST], ['Equal Opportunity', EEO], ['How to Apply', APPLY]]
    : [['Schedule', SCHEDULE], ['Compensation', PAY], ['Benefits', BENEFITS], ['Equal Opportunity', EEO], ['How to Apply', APPLY]];
  if (style === 'headed' || style === 'plain') {
    const text = [`About ${part.company}`, part.intro, '', 'Responsibilities', ...duties.map((d) => `- ${d}`), '',
      ...(q.length ? ['Qualifications', ...q.map((d) => (quals === 'short' ? `- ${d}` : d)), ''] : []),
      ...tail.flatMap(([h, t]) => [h, t, ''])].join('\n');
    return style === 'plain' ? text.replace(/^- /gm, '') : text;
  }
  if (style === 'inline') {
    return [`About us: ${part.intro}`, `What you will do: ${duties.join('; ')}.`,
      ...(q.length ? [`What you bring: ${q.join(quals === 'short' ? '; ' : ' ')}${quals === 'short' ? '.' : ''}`] : []),
      ...tail.map(([h, t]) => `${h}: ${t}`)].join('\n');
  }
  const body = [part.intro, `In this role you will ${duties.map((d) => d[0].toLowerCase() + d.slice(1)).join('. You will ')}.`,
    ...(q.length ? [quals === 'short' ? `Requirements include: ${q.join('; ')}.` : q.join(' ')] : []), ...tail.map(([, t]) => t)];
  return body.join(style === 'flat' ? ' ' : '\n');
}

// --- Profiles ---------------------------------------------------------------
const SEEDS = { nurse: ['Registered Nurse', 'Charge Nurse'], accountant: ['Tax Accountant', 'Senior Tax Accountant'] };
const BULLETS = { nurse: NURSE_BULLETS, accountant: ACCT_BULLETS };
const BASELINE = { nurse: NURSE_BASELINE, accountant: ACCT_BASELINE };
const FEW_LEVELS = {
  nurse: { levels: { telemetry: 0.95, 'wound care': 0.9, epic: 0.7, ventilator: 0.3 }, gaps: ['hemodialysis'] },
  accountant: { levels: { 'multistate tax': 0.95, 'tax research': 0.9, 'transfer pricing': 0.3 }, gaps: ['external audit'] },
};
const padded = (bullets, n) => [...bullets, ...Array.from({ length: n / 4 }, (_, i) => (
  { id: `pad${i}`, text: `Padword${i} zzfiller${i} qqother${i}.`, keywords: [0, 1, 2, 3].map((j) => `padterm${i}x${j} unrelated`) }))];
const profileOf = (who, { baseline = true, skills, bullets = BULLETS[who] } = {}) => buildProfile({ root: workspace({
  'data/queries/seeds.json': { queries: SEEDS[who] },
  'data/bullet-library.json': { current: bullets },
  ...(baseline ? { 'data/resume-baseline.json': BASELINE[who] } : {}),
  'data/profile.json': { candidate: { yearsExperience: 6 }, ...(skills ? { skills } : {}) },
}) });
const score = (profile, part, opts) => fullScore({ title: part.title, company: part.company, jdText: jd(part, opts) }, { profile });
const whole = (part) => ({ k: part.held.length, n: part.held.length, unmet: [] });

const STYLES = ['headed', 'plain', 'inline', 'flat', 'prose'];
const QUALS = ['short', 'long', 'none'];
const CASES = [
  ['nurse', 'accountant', 'nurseAdjacent'],
  ['accountant', 'nurse', 'accountantAdjacent'],
];

for (const [who, other, adjacent] of CASES) {
  const variants = {
    'no levels': profileOf(who),
    'a few levels': profileOf(who, { skills: FEW_LEVELS[who] }),
    'library only': profileOf(who, { baseline: false }),
  };
  for (const [label, profile] of Object.entries(variants)) {
    test(`bands (${who}, ${label}): exact 80+, partial 65 to 79, adjacent 55 to 64, unrelated below 55, in every JD shape`, () => {
      for (const style of STYLES) for (const quals of QUALS) {
        const shape = { style, quals };
        const at = `${style}/${quals}`;
        const exact = score(profile, J[who], shape);
        assert.ok(exact.matchScore >= 80, `exact ${at}: ${exact.matchScore}`);
        assert.equal(exact.gatePass.gate1, true, `exact gate1 ${at}`);
        for (const k of [6, 5]) {
          const partial = score(profile, J[who], { ...shape, k });
          assert.ok(partial.matchScore >= 65 && partial.matchScore <= 79, `partial ${k}/10 ${at}: ${partial.matchScore}`);
          assert.equal(partial.gatePass.gate1, true, `partial gate1 ${at}`);
        }
        const adj = score(profile, EXTRA[adjacent], { ...shape, ...whole(EXTRA[adjacent]) });
        assert.ok(adj.matchScore >= 55 && adj.matchScore <= 64, `adjacent ${at}: ${adj.matchScore}`);
        for (const part of [J[other], EXTRA.warehouse, EXTRA.marketing]) {
          const far = score(profile, part, { ...shape, ...(part.unheld ? {} : whole(part)) });
          assert.ok(far.matchScore < 55, `unrelated ${part.title} ${at}: ${far.matchScore}`);
          assert.equal(far.gatePass.gate1, false, `unrelated gate1 ${part.title} ${at}`);
        }
      }
    });

    test(`monotonic (${who}, ${label}): the score never rises as fewer requirements are met, and coverage falls with each one from 8 of 10 down`, () => {
      for (const style of STYLES) for (const quals of QUALS) {
        const rows = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((k) => score(profile, J[who], { style, quals, k }));
        const trace = rows.map((p) => `${p.matchScore}/${p.fitCoverage}`).join(' ');
        for (let i = 1; i < rows.length; i++) {
          assert.ok(rows[i].matchScore <= rows[i - 1].matchScore, `${style}/${quals}: ${trace}`);
          // The top of the scale saturates; from 8 of 10 down every step costs.
          if (i >= 3) assert.ok(rows[i].fitCoverage < rows[i - 1].fitCoverage, `${style}/${quals}: ${trace}`);
        }
        assert.ok(rows[0].matchScore - rows[10].matchScore >= 25, `${style}/${quals}: ${trace}`);
      }
    });

    test(`stability (${who}, ${label}): trailing sections, a long company introduction, and library padding move the score by at most 2`, () => {
      const pad = profileOf(who, { baseline: label !== 'library only', skills: label === 'a few levels' ? FEW_LEVELS[who] : undefined, bullets: padded(BULLETS[who], 300) });
      assert.ok(pad.heldCount >= profile.heldCount + 300);
      for (const style of STYLES) for (const quals of QUALS) for (const k of [10, 6, 3, 0]) {
        const shape = { style, quals, k };
        const base = score(profile, J[who], shape).matchScore;
        const near = (other, what) => assert.ok(Math.abs(other - base) <= 2, `${what} ${style}/${quals} k=${k}: ${other} vs ${base}`);
        near(score(profile, J[who], { ...shape, trailing: false }).matchScore, 'no trailing sections');
        near(score(profile, J[who], { ...shape, trailing: 'list' }).matchScore, 'bulleted trailing sections');
        near(score(profile, J[who], { ...shape, fluff: true }).matchScore, 'long introduction');
        near(score(pad, J[who], shape).matchScore, 'padded library');
        if (!k) continue;
        // Perks, working conditions, and screening sections after the posting, in every layout.
        // Their headings in two wordings: plain, and saying Requirements.
        for (const trailing of [false, true]) for (const form of style === 'flat' ? ['label'] : ['list', 'lines', 'prose', 'label']) for (const reqWorded of [false, true]) {
          const body = jd(J[who], { ...shape, trailing });
          const plain = fullScore({ title: J[who].title, company: J[who].company, jdText: body }, { profile }).matchScore;
          const longer = fullScore({ title: J[who].title, company: J[who].company, jdText: body + (style === 'flat' ? ' ' : '\n\n') + asides(who, form, reqWorded) }, { profile }).matchScore;
          assert.ok(Math.abs(longer - plain) <= 2, `side sections (${form}${reqWorded ? ', requirements headings' : ''}) ${style}/${quals} k=${k} trailing=${trailing}: ${longer} vs ${plain}`);
        }
      }
    });

    test(`sub-headings (${who}, ${label}): unmet duties under a heading of their own, of any wording, still count`, () => {
      const P = J[who];
      const top = [`About ${P.company}`, P.intro, '', 'Responsibilities'];
      const held = (k) => P.held.slice(0, k).map((d) => `- ${d}`);
      const unmet = (h, k) => [h, ...P.unheld.slice(0, 10 - k).map((d) => `- ${d}`)];
      const qualsList = ['Qualifications', ...P.qualsShort.map((d) => `- ${d}`)];
      for (const h of ['Specialty work', 'Day to Day', 'Certifications', 'Bonus Points', 'Unit Specifics']) for (const quals of ['short', 'none']) for (const k of [5, 6]) {
        const q = quals === 'short' ? ['', ...qualsList] : [];
        const flat = score(profile, P, { k, quals, trailing: false }).matchScore;
        const shapes = {
          'inside the duties': [...top, 'Core work', ...held(k), ...unmet(h, k), ...q],
          'after the qualifications': [...top, ...held(k), ...q, '', ...unmet(h, k)],
        };
        for (const [where, lines] of Object.entries(shapes)) {
          const grouped = fullScore({ title: P.title, company: P.company, jdText: lines.join('\n') }, { profile }).matchScore;
          assert.ok(Math.abs(grouped - flat) <= 2, `'${h}' ${where}, ${k} of 10, quals ${quals}: ${grouped} vs ${flat}`);
        }
      }
    });
  }
}

// The same jobs in an employer's own words, not the words of the resume.
const OWN_WORDS = {
  nurse: ['Registered Nurse', `Position Summary: The Registered Nurse provides direct patient care to adult medical-surgical patients using the nursing process.
Essential Functions:
Assesses, plans, implements and evaluates nursing care for assigned patients.
Administers medications and treatments as ordered and monitors patient response.
Initiates and maintains intravenous therapy.
Performs wound assessment and dressing changes.
Monitors cardiac rhythms and vital signs and reports changes to the provider.
Provides patient and family teaching and prepares patients for discharge.
Documents care in the electronic medical record.
Collaborates with physicians, case managers and therapists.
Maintains a safe environment and follows infection prevention standards.
Participates in unit quality improvement activities.
Acts as a preceptor for new staff.
Requirements:
Graduate of an accredited school of nursing.
Current state RN licensure.
BLS required; ACLS preferred.
One year of acute care experience preferred.
Ability to lift 35 pounds.
Excellent interpersonal skills.`],
  accountant: ['Tax Accountant', `Job Summary: The Tax Accountant prepares and reviews federal, state and local income tax returns for corporate, partnership and individual clients and assists with tax planning projects.
Duties:
Prepare tax returns and supporting workpapers.
Research technical tax issues and document conclusions.
Prepare quarterly estimates and extension calculations.
Respond to notices from the tax authorities and state agencies.
Assist with the year-end tax provision.
Reconcile tax accounts to the general ledger.
Communicate with clients to gather information and resolve open items.
Identify tax saving opportunities.
Mentor interns and review their work.
Education and Experience:
Bachelor's degree in Accounting required.
CPA or progress toward CPA.
2-5 years of tax experience in public accounting.
Proficiency with tax preparation software and Microsoft Excel.
Strong organizational and analytical skills.`],
};
// Duties in one paragraph, then a qualifications section of licence, degree,
// years, and soft requirement lines that name no skill keyword at all.
const CREDENTIAL_QUALS = {
  nurse: ['Registered Nurse', `We are hiring a Registered Nurse for our inpatient unit. You will carry out patient assessment, medication administration, IV therapy, wound care, discharge planning and patient education, charting in Epic. You will monitor telemetry and escalate changes in cardiac rhythm, write care plans with physicians and therapists during interdisciplinary rounds, and manage post operative patients, including pain management and early mobility. You will follow infection control and fall prevention practices, give SBAR handoff at shift change, and delegate tasks to nursing assistants.
Qualifications
- Current registration with the college of nurses
- Bachelor of Science in Nursing
- Current BLS certification
- Minimum 2 years of recent acute care experience
- Excellent communication and interpersonal skills
- Ability to work rotating shifts including weekends
- Reliable attendance`],
  accountant: ['Tax Accountant', `We are hiring a Tax Accountant for our business tax group. You will handle tax preparation for partnership and S corporation clients, tax research, quarterly estimated tax payments, account reconciliation, and tax notices. You will prepare multistate sales and use tax returns and review nexus, prepare depreciation schedules for fixed assets, and build Excel models for tax projections and year end tax planning. You will review workpapers prepared by junior staff, manage client relationships, and track filing deadlines and extensions.
Qualifications
- Bachelor degree in accounting
- CPA license or actively pursuing
- Minimum 3 years of public accounting experience
- Strong attention to detail
- Able to meet deadlines in busy season`],
};

for (const who of ['nurse', 'accountant']) {
  test(`own job (${who}): 80 or above in the employer's words and with credential only qualifications; never below an unconfigured user`, () => {
    const profile = profileOf(who);
    for (const [title, jdText] of [OWN_WORDS[who], CREDENTIAL_QUALS[who]]) {
      const p = fullScore({ title, jdText }, { profile });
      assert.ok(p.matchScore >= 80, `${title}: ${p.matchScore} (${p.fitCoverage})`);
      assert.equal(p.gatePass.gate1, true);
      assert.ok(p.matchScore > fullScore({ title, jdText }, { profile: EMPTY_PROFILE }).matchScore);
      // The other profession's user is far from it.
      const stranger = fullScore({ title, jdText }, { profile: profileOf(who === 'nurse' ? 'accountant' : 'nurse') });
      assert.ok(stranger.matchScore < 55, `stranger on ${title}: ${stranger.matchScore}`);
      assert.equal(stranger.gatePass.gate1, false);
    }
  });
}

// A two line posting of the user's own job, then side sections longer than the
// job itself. Under FULL_WORDS content words, so its score is pulled toward
// neutral: a good fit, not an automatic strong one.
const SHORT_OWN = {
  nurse: ['Registered Nurse', `You will carry out patient assessment, medication administration, IV therapy, wound care, telemetry monitoring, discharge planning and patient education, charting in Epic.
Qualifications: Registered Nurse license, BLS, two years of acute care experience, Bachelor of Science in Nursing preferred.`],
  accountant: ['Tax Accountant', `You will handle tax preparation for partnership and S corporation clients, tax research, quarterly estimated tax payments, account reconciliation, and tax notices.
Qualifications: CPA license, three years of public accounting experience, working knowledge of tax software and Excel.`],
};
// The whole posting in the employer's own voice.
const EMPLOYER_VOICE = {
  nurse: ['Registered Nurse', `We are seeking a Registered Nurse for our medical surgical unit. Our nurses complete a head to toe patient assessment each shift. We need someone who can provide safe medication administration and IV therapy. We expect you to perform wound care, monitor telemetry, and update care plans. Our nurses lead discharge planning and patient education and document in Epic. We expect our nurses to care for post operative patients, including pain management and early mobility. We need someone who follows infection control and fall prevention practices on every shift. Our nurses must give SBAR handoff at shift change and delegate tasks to nursing assistants. We are looking for experience with blood glucose monitoring, insulin administration, and blood transfusion. We require a current Registered Nurse license, BLS, and two years of acute care experience.
We offer medical, dental, and vision coverage. We are an equal opportunity employer.`],
  accountant: ['Tax Accountant', `We are seeking a Tax Accountant for our business tax group. Our accountants prepare federal and state tax returns for partnership and S corporation clients. We need someone who can handle tax research and write technical memos. We expect you to calculate estimated tax payments, reconcile general ledger accounts, and respond to tax notices. Our accountants review workpapers and track filing deadlines. We expect our accountants to prepare multistate sales and use tax returns and review nexus. We need someone who can prepare depreciation schedules and maintain fixed assets records. Our accountants must build Excel models for tax projections and year end tax planning. We are looking for experience with payroll tax filings, bank reconciliation, and journal entries. We require a CPA license and three years of public accounting experience.
We offer medical, dental, and vision coverage. We are an equal opportunity employer.`],
};
// Another field whose words only begin like the user's ("audio" and "audience"
// next to "audit", "career" and "careful" next to "care").
const LOOK_ALIKE = {
  accountant: ['Media Planner', `Example Media Group plans advertising for regional retailers. You will plan paid media campaigns across audio, video, and social channels. Build audience segments and size each audience against the brief. Negotiate audio ad buys with stations and streaming networks. Handle account management for six advertisers. Deliver weekly reporting and client presentations.
Requirements
- 3+ years of media planning experience
- Comfortable with audience research tools
- Strong presentation skills`],
  nurse: ['Career Coach', `Example Career Center helps adults change careers. You will coach clients through a career change and build a career plan with each one. Be careful and patient with nervous clients. Run mock interviews and review resumes. Track media mentions and manage the nursery school partnership. Lead workshops on career planning.
Requirements
- 2+ years of career coaching experience
- Patience and good listening
- Comfortable presenting to groups`],
};

for (const who of ['nurse', 'accountant']) {
  const other = who === 'nurse' ? 'accountant' : 'nurse';

  test(`short posting (${who}): an exact fit in two lines is a good fit, and side sections longer than the job itself do not move it`, () => {
    const profile = profileOf(who);
    const [title, jdText] = SHORT_OWN[who];
    const base = fullScore({ title, jdText }, { profile });
    assert.ok(base.matchScore >= 65 && base.matchScore <= 79, `${base.matchScore}`);
    assert.equal(base.gatePass.gate1, true);
    assert.ok(base.matchScore < score(profile, J[who], {}).matchScore);
    for (const form of ['list', 'lines', 'prose']) {
      const longer = fullScore({ title, jdText: `${jdText}\n\n${asides(who, form)}` }, { profile });
      assert.ok(Math.abs(longer.matchScore - base.matchScore) <= 2, `${form}: ${longer.matchScore} vs ${base.matchScore}`);
      // The same side sections do not lift the other profession's user.
      const stranger = fullScore({ title, jdText: `${jdText}\n\n${asides(who, form)}` }, { profile: profileOf(other) });
      assert.ok(stranger.matchScore < 55, `stranger ${form}: ${stranger.matchScore}`);
      assert.equal(stranger.gatePass.gate1, false);
    }
  });

  test(`employer voice (${who}): asks phrased "We are seeking", "We need", "We require" still count`, () => {
    const [title, jdText] = EMPLOYER_VOICE[who];
    const own = fullScore({ title, jdText }, { profile: profileOf(who) });
    const stranger = fullScore({ title, jdText }, { profile: profileOf(other) });
    assert.ok(own.matchScore >= 80, `own ${own.matchScore}`);
    assert.ok(own.matchScore - stranger.matchScore >= 20, `${own.matchScore} vs ${stranger.matchScore}`);
    assert.ok(stranger.matchScore < 55, `stranger ${stranger.matchScore}`);
    assert.equal(stranger.gatePass.gate1, false);
  });

  test(`look alike words (${who}): a role whose words only begin like the user's is unrelated`, () => {
    const [title, jdText] = LOOK_ALIKE[who];
    const libraryOnly = buildProfile({ root: workspace({ 'data/bullet-library.json': { current: BULLETS[who] } }) });
    for (const profile of [profileOf(who), profileOf(who, { baseline: false }), libraryOnly]) {
      const p = fullScore({ title, jdText }, { profile });
      assert.ok(p.matchScore < 55, `${title}: ${p.matchScore} (${p.fitCoverage})`);
      assert.equal(p.gatePass.gate1, false);
    }
  });
}

// A snippet in place of a posting (aggregator and guest listings carry them).
const SNIPPET = {
  nurse: ['Registered Nurse', 'Registered Nurse needed for our medical surgical unit. Day shift. Apply today.'],
  accountant: ['Tax Accountant', 'Tax Accountant needed for our business tax group. Busy season hours. Apply today.'],
};
// Employers named after the field, and after nothing.
const COMPANIES = {
  nurse: ['Example Regional Hospital', 'Compassionate Patient Care Nursing', 'Nurse Care Partners', 'Medical Surgical Associates'],
  accountant: ['Example and Partners', 'Summit Client Tax Group', 'Tax and Accounting Partners'],
};
// Side sections whose heading says Requirements, after an employer worded posting.
const REQUIREMENT_ASIDES = [
  ['Standing for up to 12 hours', 'Lifting 50 pounds', 'Visual acuity to read small print', 'Possible exposure to bloodborne pathogens'],
  ['Background check and immunization records', 'Rotating weekends and holidays', 'Reliable transportation'],
  ['Must be able to lift 50 pounds', 'Ability to stand for 12 hours', 'Must pass a background check and drug screen'],
];

for (const who of ['nurse', 'accountant']) {
  test(`snippet (${who}): a three sentence listing stays under 80 and below the full posting of the same job`, () => {
    const [title, jdText] = SNIPPET[who];
    for (const profile of [profileOf(who), profileOf(who, { skills: FEW_LEVELS[who] }), profileOf(who, { baseline: false })]) {
      const snippet = fullScore({ title, jdText }, { profile });
      const full = score(profile, J[who], {});
      assert.ok(snippet.matchScore < 80, `${snippet.matchScore} (${snippet.fitCoverage})`);
      assert.ok(snippet.matchScore < full.matchScore - 10, `${snippet.matchScore} vs ${full.matchScore}`);
      assert.ok(snippet.fitCoverage > 0.5 && snippet.fitCoverage < 0.7, `${snippet.fitCoverage}`);
    }
  });

  test(`gate1 (${who}): with nothing rated the skills gate is the score floor alone, with or without the title bonus`, () => {
    const profile = profileOf(who);
    assert.equal(profile.ratedness, 0);
    let lowCoveragePass = 0;
    for (const style of STYLES) for (const quals of QUALS) for (const k of [10, 8, 6, 5, 4, 3, 2, 1, 0]) {
      const p = score(profile, J[who], { style, quals, k });
      // The gate reads the unrounded score, so a displayed 55 can sit on either side.
      if (p.matchScore !== 55) assert.equal(p.gatePass.gate1, p.matchScore > 55, `${style}/${quals} k=${k}: ${p.matchScore} on ${p.fitCoverage}`);
      if (p.fitCoverage < 0.5 && p.gatePass.gate1) lowCoveragePass++;
    }
    // The title of the user's own target role carries a weak fit over the floor.
    assert.ok(lowCoveragePass > 0);
  });

  test(`requirements worded side sections (${who}): physical and screening sections do not move an employer worded exact fit`, () => {
    const profile = profileOf(who);
    const [title, jdText] = OWN_WORDS[who];
    const base = fullScore({ title, jdText }, { profile }).matchScore;
    for (const h of ['Physical demands', 'Physical Requirements', 'Essential Physical Functions', 'Additional Requirements', 'Other Requirements', 'Job Requirements']) {
      for (const items of REQUIREMENT_ASIDES) for (const text of [`${h}\n${items.map((i) => `- ${i}`).join('\n')}`, `${h}\n${items.join('\n')}`, `${h}: ${items.join('. ')}.`]) {
        const longer = fullScore({ title, jdText: `${jdText}\n${text}` }, { profile }).matchScore;
        assert.ok(Math.abs(longer - base) <= 2, `${JSON.stringify(text.slice(0, 60))}: ${longer} vs ${base}`);
      }
    }
  });

  test(`company name (${who}): an employer named after the user's field scores like any other`, () => {
    const profile = profileOf(who);
    const stranger = profileOf(who === 'nurse' ? 'accountant' : 'nurse');
    // An employer worded posting that never names the firm, and a partial fit that names it throughout.
    for (const text of [() => OWN_WORDS[who][1], (company) => jd({ ...J[who], company, intro: J[who].intro.split(J[who].company).join(company) }, { k: 6 })]) {
      const title = J[who].title;
      const neutral = fullScore({ title, company: 'Example Holdings', jdText: text('Example Holdings') }, { profile }).matchScore;
      for (const company of [...COMPANIES.nurse, ...COMPANIES.accountant]) {
        const jdText = text(company);
        const p = fullScore({ title, company, jdText }, { profile });
        assert.ok(Math.abs(p.matchScore - neutral) <= 1, `${company}: ${p.matchScore} vs ${neutral}`);
        // Naming the firm after the other profession does not help that profession's user either.
        assert.ok(fullScore({ title, company, jdText }, { profile: stranger }).matchScore < 55, `stranger at ${company}`);
      }
    }
  });
}

test('differentiator bonus: several rated spellings of one strength add less than as many separate strengths would', () => {
  const profile = profileOf('accountant', { skills: { levels: { 'tax research': 1, 'tax law': 1, 'technical memos': 0.9, 'tax planning': 0.95 } } });
  const bonus = (jdText) => +((/\+([\d.]+) differentiators/.exec(fullScore({ title: 'Tax Accountant', jdText }, { profile }).rankReason) || [0, 0])[1]);
  assert.equal(bonus('The work covers: tax research.'), 1.2);
  assert.equal(bonus('The work covers: tax research; tax law.'), 2.0);
  assert.equal(bonus('The work covers: tax research; tax law; technical memos; tax planning.'), 3.4);
});

test('a posting with nothing left to judge passes no skills gate for a configured user and stays neutral for an empty one', () => {
  const jdText = 'We offer a friendly office. Our team loves a challenge. We are growing fast. If you like people, come by.';
  const configured = fullScore({ title: 'Office Assistant', jdText }, { profile: profileOf('nurse') });
  assert.equal(configured.fitCoverage, 0.5);
  assert.equal(configured.gatePass.gate1, false);
  const none = fullScore({ title: 'Office Assistant', jdText }, { profile: EMPTY_PROFILE });
  assert.equal(none.matchScore, 56);
  assert.equal(none.gatePass.gate1, true);
});

// A library of hundreds of bullets: the staples stay full evidence, a skill one
// bullet mentions in passing does not, and the bands do not saturate.
test('large library: one passing mention is thin evidence, the staples are not', () => {
  const once = b('x1', 'Performed hemodialysis treatments and cannulated fistulas and grafts during a float assignment.', ['hemodialysis']);
  const many = [];
  for (let r = 0; r < 12; r++) for (const x of NURSE_BULLETS) many.push({ ...x, id: `${x.id}r${r}`, text: `${x.text} Rotation ${r}.` });
  const small = profileOf('nurse', { bullets: [...NURSE_BULLETS, once] });
  const large = profileOf('nurse', { bullets: [...many, once] });
  const dialysis = { title: 'Registered Nurse, Dialysis', company: 'Example Kidney Care', jdText: `Responsibilities
- Perform hemodialysis treatments and cannulate fistulas and grafts
- Monitor patients during hemodialysis and respond to complications
- Teach patients about fistula care
- Assess fistulas and grafts before each hemodialysis treatment
- Cannulate new fistulas and grafts with the charge nurse
- Document hemodialysis treatments and patient response in Epic
- Administer medications ordered during hemodialysis treatments
- Review lab results before and after hemodialysis
- Precept new staff on hemodialysis treatments and fistula care
- Monitor fistulas and grafts for infection during hemodialysis treatments
- Give SBAR handoff after hemodialysis treatments
- Cannulate fistulas and grafts for every hemodialysis treatment
Qualifications
- Registered Nurse license
- Hemodialysis experience` };
  const s = fullScore({ ...dialysis }, { profile: small }).matchScore;
  const l = fullScore({ ...dialysis }, { profile: large }).matchScore;
  assert.ok(s >= 80, `small ${s}`);
  assert.ok(l >= 65 && l <= 79 && s - l >= 8, `large ${l} vs small ${s}`);
  for (const style of STYLES) {
    assert.ok(score(large, J.nurse, { style }).matchScore >= 80);
    const partial = score(large, J.nurse, { style, k: 5 }).matchScore;
    assert.ok(partial >= 65 && partial <= 79, `partial ${style}: ${partial}`);
    assert.ok(score(large, J.accountant, { style }).matchScore < 55);
  }
});

test('a user with no skills on file gets the neutral score and never outranks an exact fit of a configured user', () => {
  for (const who of ['nurse', 'accountant']) {
    const seedsOnly = buildProfile({ root: workspace({ 'data/queries/seeds.json': { queries: SEEDS[who] } }) });
    const configured = profileOf(who);
    for (const style of STYLES) for (const part of [J.nurse, J.accountant, EXTRA.warehouse]) {
      const shape = { style, ...(part.unheld ? {} : whole(part)) };
      const none = score(EMPTY_PROFILE, part, shape);
      assert.equal(none.matchScore, 56);
      assert.equal(none.fitCoverage, 0.5);
      // Seeds but no skills: the fit part stays neutral; only the title
      // bonuses (role words up to 8, a seed seniority word 3) can move it.
      const seeded = score(seedsOnly, part, shape);
      assert.equal(seeded.fitCoverage, 0.5);
      assert.ok(seeded.matchScore >= 56 && seeded.matchScore <= 67, `${seeded.matchScore}`);
      assert.ok(seeded.matchScore < score(configured, J[who], { style }).matchScore);
    }
  }
});

test('a JD whose requirements sentence has one to three fragments does not invert a strong and a weak fit', () => {
  const profile = profileOf('accountant');
  const strong = 'You will prepare partnership and S corporation tax returns, handle tax research and tax planning, reconcile general ledger accounts, post journal entries, prepare depreciation schedules for fixed assets, and answer tax notices. You will also calculate quarterly estimated tax payments and the annual tax provision, prepare multistate sales and use tax returns, review workpapers prepared by junior staff, build Excel models for tax projections, and track filing deadlines and extensions. Our requirements are simple; our office dog is named Biscuit and loves visitors; lunch is catered every Friday for everyone.';
  const weak = 'You will stock shelves, drive the delivery van, and greet customers at the counter. Requirements include a valid license; proven tax returns preparation history; flexibility to travel when needed.';
  const s = fullScore({ title: 'Tax Accountant', jdText: strong }, { profile });
  const w = fullScore({ title: 'Tax Accountant', jdText: weak }, { profile });
  assert.ok(s.matchScore >= 80, `strong ${s.matchScore}`);
  assert.equal(s.gatePass.gate1, true);
  assert.ok(w.matchScore < 65, `weak ${w.matchScore}`);
  assert.ok(s.matchScore - w.matchScore >= 15, `${s.matchScore} vs ${w.matchScore}`);
});

// --- Bar 1: a full hand rated table ------------------------------------------
// With FULL_TABLE (40) or more rated terms, about a fifth of them (WEAK_SHARE)
// rated below 0.6, the user's own table stands alone on a posting in the
// user's field:
//   coverage = mean level of the rated skills the JD names (0.5 when none)
//   score    = 34 + 44 * coverage + min(8, 1.2 * n ** 0.75), n rated skills at 0.9 or above
//              (dampened: a table lists several spellings of one skill)
//              + 3 when the title carries a seniority word from the seeds
//   gate1    = coverage of at least half and a score of at least 55
// and nothing else (no vocabulary estimate, no title role bonus).
test('a fully rated skill table is scored by rated coverage alone', () => {
  const cycle = [1, 0.9, 0.6, 0.3];
  for (const who of ['nurse', 'accountant']) {
    const terms = [...new Set(BULLETS[who].flatMap((b) => b.keywords.map((k) => k.toLowerCase().replace(/-/g, ' '))))].slice(0, 44);
    assert.ok(terms.length >= 40);
    const levels = Object.fromEntries(terms.map((t, i) => [t, cycle[i % 4]]));
    const profile = profileOf(who, { skills: { levels } });
    assert.equal(profile.ratedness, 1);
    const expected = (named, senior) => {
      const lv = named.map((t) => levels[t]);
      const coverage = lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0.5;
      const raw = 34 + 44 * coverage + Math.min(8, 1.2 * lv.filter((x) => x >= 0.9).length ** 0.75) + (senior ? 3 : 0);
      // A JD that names none of the rated skills and has too few words to judge passes no gate.
      return { matchScore: Math.round(raw), gate1: named.length > 0 && coverage >= 0.5 && raw >= 55 };
    };
    // [0, 3, 7, 11] is one strength next to three weak skills: 56 points on coverage 0.48, so gate1 fails.
    const picks = [[0, 1, 2, 3], [0, 4, 8, 12, 16], [3, 7, 11], [0, 3, 7, 11], [2, 3, 6, 7, 10, 11], [0, 1, 4, 5, 8, 9, 12, 13, 16, 17], []];
    assert.equal(expected([0, 3, 7, 11].map((i) => terms[i]), false).gate1, false);
    for (const idx of picks) {
      const named = idx.map((i) => terms[i]);
      for (const [title, senior] of [[who === 'nurse' ? 'Registered Nurse' : 'Tax Accountant', false], ['Senior Tax Accountant', who === 'accountant']]) {
        const jdText = `Zzalpha qqbeta xxgamma. The work covers: ${named.join('; ')}. Zzdelta qqepsilon.`;
        const p = fullScore({ title, jdText }, { profile });
        const want = expected(named, senior);
        assert.equal(p.matchScore, want.matchScore, `${who} ${title} [${named.join(', ')}]: ${p.rankReason}`);
        assert.equal(p.gatePass.gate1, want.gate1, `gate1 ${who} ${title} [${named.join(', ')}]: ${p.matchScore} on ${p.fitCoverage}`);
        assert.doesNotMatch(p.rankReason, /role-match/);
      }
    }
  }
});

// A table of strengths alone (every bullet proven keyword at 1.0) can say a
// skill is present, never that one is missing. Two measures follow from that:
// a rated hit counts by the table's mean distance below 0.9 (ratedTrust, in
// full at 0.12), and the table stands alone by the share of its terms rated
// below 0.6 (ratedness, in full at one in five of a table of 40).
const topTerms = (who) => Object.fromEntries([...new Set(BULLETS[who].flatMap((b) => b.keywords.map((k) => k.toLowerCase().replace(/-/g, ' '))))].slice(0, 40).map((t) => [t, 1]));
const WEAK = { nurse: ['hemodialysis', 'ventilator'], accountant: ['external audit', 'transfer pricing'] };

test('a table that rates only strengths never stands alone: unrelated roles stay below 55 and a 3 of 10 match below 80', () => {
  for (const [who, other] of [['nurse', 'accountant'], ['accountant', 'nurse']]) {
    const top = topTerms(who), gaps = WEAK[who];
    assert.ok(Object.keys(top).length >= 30, `${who} rated terms`);
    for (const skills of [{ levels: top }, { levels: top, gaps }, { levels: { ...top, ...Object.fromEntries(gaps.map((g) => [g, 0.2])) } }]) {
      const profile = profileOf(who, { skills });
      assert.ok(profile.ratedness < 0.5 && profile.ratedTrust < 0.5, `${who} ratedness ${profile.ratedness} trust ${profile.ratedTrust}`);
      for (const part of [J[other], EXTRA.warehouse, EXTRA.marketing]) {
        const p = score(profile, part, part === J[other] ? undefined : whole(part));
        assert.ok(p.matchScore < 55 && !p.gatePass.gate1, `${who} on ${part.title}: ${p.matchScore} ${p.rankReason}`);
      }
      assert.ok(score(profile, J[who], { k: 3 }).matchScore < 80, `${who} 3 of 10`);
      assert.ok(score(profile, J[who]).matchScore >= 80, `${who} exact fit`);
    }
  }
});

test('an all strengths table scores another field as the same user with nothing rated does, and one rated weakness does not unlock it', () => {
  for (const [who, other] of [['nurse', 'accountant'], ['accountant', 'nurse']]) {
    const top = topTerms(who);
    const none = profileOf(who), all = profileOf(who, { skills: { levels: top } });
    const oneWeak = profileOf(who, { skills: { levels: { ...top, [WEAK[who][0]]: 0.2 } } });
    assert.equal(all.ratedTrust, 0);
    assert.equal(all.ratedness, 0);
    for (const part of [J[other], EXTRA.warehouse, EXTRA.marketing]) {
      const opts = part === J[other] ? undefined : whole(part);
      const base = score(none, part, opts), p = score(all, part, opts), q = score(oneWeak, part, opts);
      assert.ok(Math.abs(p.matchScore - base.matchScore) <= 3 && !p.gatePass.gate1, `${who} on ${part.title}: ${p.matchScore} vs ${base.matchScore}`);
      assert.ok(q.matchScore < 65, `${who} on ${part.title} with one weakness rated: ${q.matchScore}`);
    }
  }
});

// Differentiators of a table that rates no weakness take the place of title
// role points and add none of their own: a partial fit stays out of the 80
// band (the automatic evaluate band) and an adjacent role out of the 65 band,
// for a full table of strengths and for a table of three to six differentiators.
const DIFFERENTIATORS = {
  nurse: { telemetry: 0.95, 'wound care': 0.9, 'iv therapy': 0.95, 'discharge planning': 0.9, 'care plans': 0.9, 'patient education': 1 },
  accountant: { 'multistate tax': 0.95, 'tax research': 0.9, 'tax provision': 0.95, 'sales and use tax': 0.9, 'tax notices': 0.9, 'fixed assets': 1 },
};
test('a table that rates only strengths scores a partial fit and an adjacent role as the same user with nothing rated does, in every JD shape', () => {
  for (const [who, , adjacent] of CASES) {
    const none = profileOf(who);
    const few = (n) => Object.fromEntries(Object.entries(DIFFERENTIATORS[who]).slice(0, n));
    const tables = { 'all strengths': topTerms(who), 'three differentiators': few(3), 'four differentiators': few(4), 'six differentiators': few(6) };
    for (const [label, levels] of Object.entries(tables)) {
      const profile = profileOf(who, { skills: { levels } });
      assert.equal(profile.ratedTrust, 0, `${who} ${label}`);
      let named = 0;
      for (const style of STYLES) for (const quals of QUALS) {
        const at = `${who}, ${label}, ${style}/${quals}`;
        for (const k of [6, 5]) {
          const p = score(profile, J[who], { style, quals, k }), base = score(none, J[who], { style, quals, k });
          assert.ok(p.matchScore >= 65 && p.matchScore <= 79, `partial ${k}/10 ${at}: ${p.matchScore} ${p.rankReason}`);
          assert.ok(Math.abs(p.matchScore - base.matchScore) <= 1, `partial ${k}/10 ${at}: ${p.matchScore} vs ${base.matchScore} unrated`);
          if (/differentiators/.test(p.rankReason)) named++;
        }
        assert.ok(score(profile, J[who], { style, quals }).matchScore >= 80, `exact ${at}`);
        const shape = { style, quals, ...whole(EXTRA[adjacent]) };
        const adj = score(profile, EXTRA[adjacent], shape), adjBase = score(none, EXTRA[adjacent], shape);
        assert.ok(adj.matchScore >= 55 && adj.matchScore <= 64, `adjacent ${at}: ${adj.matchScore} ${adj.rankReason}`);
        assert.ok(Math.abs(adj.matchScore - adjBase.matchScore) <= 1, `adjacent ${at}: ${adj.matchScore} vs ${adjBase.matchScore} unrated`);
        // No target role word in this title: no role points to replace, so none added.
        assert.doesNotMatch(adj.rankReason, /differentiators|role-match/, `adjacent ${at}`);
      }
      assert.ok(named > 0, `${who} ${label}: the partial fit names a differentiator`);
    }
    // One or two rated weaknesses next to 40 strengths (trust 0.14 and 0.28) do not lift a partial fit to 80 either.
    for (const n of [1, 2]) {
      const profile = profileOf(who, { skills: { levels: { ...topTerms(who), ...Object.fromEntries(WEAK[who].slice(0, n).map((g) => [g, 0.2])) } } });
      assert.ok(profile.ratedTrust > 0 && profile.ratedTrust < 0.3);
      for (const style of STYLES) for (const quals of QUALS) for (const k of [6, 5]) {
        const p = score(profile, J[who], { style, quals, k });
        assert.ok(p.matchScore >= 65 && p.matchScore <= 79, `${who}, ${n} weak, partial ${k}/10 ${style}/${quals}: ${p.matchScore} ${p.rankReason}`);
      }
    }
  }
});

test('differentiator points: added in full by a table that rates weaknesses, in place of title role points by one that rates none', () => {
  const jdText = 'The work covers: tax research; tax law; technical memos; tax planning.';
  const strengths = { 'tax research': 1, 'tax law': 1, 'technical memos': 0.9, 'tax planning': 0.95 };
  const parts = (profile, title) => {
    const p = fullScore({ title, jdText }, { profile });
    const num = (re) => +((re.exec(p.rankReason) || [0, 0])[1]);
    return { d: num(/\+([\d.]+) differentiators/), role: num(/\+([\d.]+) role-match/), score: p.matchScore };
  };
  const none = profileOf('accountant'), only = profileOf('accountant', { skills: { levels: strengths } });
  const honest = profileOf('accountant', { skills: { levels: { ...strengths, 'transfer pricing': 0.3 } } });
  assert.equal(only.ratedTrust, 0);
  assert.equal(honest.ratedTrust, 1);
  // Two target role words in the title (6 role points for a user who rated nothing).
  assert.deepEqual(parts(none, 'Tax Accountant'), { d: 0, role: 6, score: parts(none, 'Tax Accountant').score });
  const o = parts(only, 'Tax Accountant'), h = parts(honest, 'Tax Accountant');
  assert.deepEqual([o.d, o.role], [3.4, 2.6]);
  assert.ok(Math.abs(o.score - parts(none, 'Tax Accountant').score) <= 1, `${o.score}`);
  assert.equal(h.d, 3.4);
  assert.ok(h.d + h.role > 7.9 && h.d + h.role <= 8, `${h.d} + ${h.role}`);
  // No target role word in the title.
  assert.deepEqual([parts(only, 'Office Assistant').d, parts(only, 'Office Assistant').role], [0, 0]);
  assert.deepEqual([parts(honest, 'Office Assistant').d, parts(honest, 'Office Assistant').role], [3.4, 0]);
});

test('two measures of a rated table: hits count by its mean distance below 0.9, it stands alone by its share of rated weaknesses', () => {
  const terms = Object.keys(topTerms('nurse')).slice(0, 20);
  const of = (levelAt) => profileOf('nurse', { skills: { levels: Object.fromEntries(terms.map((t, i) => [t, levelAt(i)])) } });
  // ratedTrust: mean of max(0, 0.9 - level) over 0.12, capped at 1.
  const trust = (weak) => +of((i) => (i < weak ? 0.3 : 1)).ratedTrust.toFixed(2);
  assert.deepEqual([0, 1, 2, 4, 10].map(trust), [0, 0.25, 0.5, 1, 1]);
  assert.equal(of(() => 0.95).ratedTrust, 0);
  assert.equal(of(() => 0.6).ratedTrust, 1);
  assert.equal(+of((i) => (i < 8 ? 0.6 : 1)).ratedTrust.toFixed(2), 1);
  assert.equal(+of((i) => (i < 2 ? 0.6 : 1)).ratedTrust.toFixed(2), 0.25);
  // ratedness: size over 40, times the share rated below 0.6 over one in five.
  // A term counts as a weakness in full at 0.5 or below, in proportion above.
  const alone = (levelAt) => +of(levelAt).ratedness.toFixed(3);
  assert.deepEqual([0, 1, 2, 4, 10].map((weak) => alone((i) => (i < weak ? 0.3 : 1))), [0, 0.125, 0.25, 0.5, 0.5]);
  assert.equal(alone(() => 0.6), 0);
  assert.equal(alone(() => 0.59), 0.25);
  assert.equal(alone((i) => (i % 2 ? 0.59 : 1)), 0.125);
  assert.equal(alone(() => 0.5), 0.5);
  assert.equal(profileOf('nurse').ratedTrust, 0);
  assert.equal(EMPTY_PROFILE.ratedTrust, 0);
});

// A level of 0.6 is the documented way to mark a skill as held but not proven
// (templates/profile.template.json shows {"...": 1, "...": 0.6}). It must lower
// the score like any other rating, with no step between 0.6 and 0.59.
test('a level of 0.6 changes the score, and 0.59 scores within 3 points of it', () => {
  for (const [who, other] of [['nurse', 'accountant'], ['accountant', 'nurse']]) {
    const terms = Object.keys(topTerms(who));
    const none = profileOf(who);
    const table = (n, lv, rest) => profileOf(who, { skills: { levels: Object.fromEntries(terms.slice(0, n).map((t, i) => [t, rest != null && i % 2 === 0 ? rest : lv])) } });
    for (const style of STYLES) {
      const at = `${who} ${style}`;
      const base = score(none, J[who], { style }).matchScore;
      // Eight proven skills lowered to 0.6.
      const eight = score(table(8, 0.6), J[who], { style }).matchScore;
      assert.ok(base - eight >= 4, `eight at 0.6 ${at}: ${eight} vs ${base} unrated`);
      assert.ok(eight >= 65, `eight at 0.6 ${at}: ${eight}`);
      assert.ok(Math.abs(eight - score(table(8, 0.59), J[who], { style }).matchScore) <= 3, `0.6 vs 0.59 ${at}`);
      // The template example shape: one skill at 1, one at 0.6.
      const two = score(table(2, 0.6, 1), J[who], { style });
      assert.ok(two.matchScore < base && two.matchScore >= 80, `template shape ${at}: ${two.matchScore} vs ${base}`);
      // A table of 40, half at 1 and half at 0.6 or 0.59: both count, both keep
      // the order of fits, and neither lifts another field.
      for (const lv of [0.6, 0.59]) {
        const tier = table(40, lv, 1);
        assert.equal(tier.ratedTrust, 1);
        const [exact, six, three, zero] = [10, 6, 3, 0].map((k) => score(tier, J[who], { style, k }).matchScore);
        assert.ok(exact < base && exact >= 75, `two tier ${lv} exact ${at}: ${exact} vs ${base}`);
        assert.ok(exact >= six && six > three && three > zero, `two tier ${lv} order ${at}: ${exact} ${six} ${three} ${zero}`);
        assert.ok(exact - zero >= 12, `two tier ${lv} spread ${at}: ${exact} ${zero}`);
        for (const part of [J[other], EXTRA.warehouse, EXTRA.marketing]) {
          const far = score(tier, part, { style, ...(part.unheld ? {} : whole(part)) });
          assert.ok(far.matchScore < 55 && !far.gatePass.gate1, `two tier ${lv} on ${part.title} ${style}: ${far.matchScore} ${far.rankReason}`);
        }
      }
    }
  }
});

// The table an honest user ends with: 40 proven strengths at 1.0 and the
// skills postings in the field name that the user holds weakly, at 0.2. It is
// trusted in full and stands alone, so only the field check keeps it from
// rating another field by the one generic keyword that posting happens to name.
const HONEST_WEAK = {
  nurse: ['ventilator', 'operating room', 'hemodialysis', 'triage', 'labor and delivery', 'chemotherapy', 'endoscopy', 'sterile field', 'fetal heart monitoring', 'vasoactive drips', 'renal replacement', 'utilization review', 'prior authorizations', 'pediatric sedation', 'neonatal resuscitation'],
  accountant: ['budget', 'forecast', 'commercial loans', 'derivatives', 'equity compensation', 'transfer pricing', 'external audit', 'treasury', 'foreign exchange', 'actuarial', 'revenue recognition', 'mergers and acquisitions', 'valuation', 'cap table', 'hedge documentation'],
};
const honest = (who, weak = 15) => profileOf(who, { skills: { levels: { ...topTerms(who), ...Object.fromEntries(HONEST_WEAK[who].slice(0, weak).map((t) => [t, 0.2])) } } });

test('a fully trusted table does not rate another field: unrelated roles stay below 55 with gate1 false in every JD shape', () => {
  for (const [who, other] of [['nurse', 'accountant'], ['accountant', 'nurse']]) {
    for (const weak of [15, 4]) {
      const profile = honest(who, weak);
      if (weak === 15) assert.deepEqual([profile.ratedness, profile.ratedTrust], [1, 1]);
      else assert.ok(profile.ratedTrust > 0.4 && profile.ratedTrust < 0.6, `${profile.ratedTrust}`);
      for (const style of STYLES) for (const quals of QUALS) {
        const at = `${who}, ${weak} weak, ${style}/${quals}`;
        for (const part of [J[other], EXTRA.warehouse, EXTRA.marketing]) {
          const far = score(profile, part, { style, quals, ...(part.unheld ? {} : whole(part)) });
          assert.ok(far.matchScore < 55 && !far.gatePass.gate1, `${part.title} ${at}: ${far.matchScore} ${far.rankReason}`);
        }
        const [exact, six, three, zero] = [10, 6, 3, 0].map((k) => score(profile, J[who], { style, quals, k }).matchScore);
        assert.ok(exact >= 80, `exact ${at}: ${exact}`);
        assert.ok(six >= 65 && six <= 79, `6 of 10 ${at}: ${six}`);
        assert.ok(exact > six && six > three && three > zero, `order ${at}: ${exact} ${six} ${three} ${zero}`);
      }
    }
  }
});

test('the field check: a target role word in the title keeps the table; rated skills named keep it only on a posting the evidence half covers', () => {
  const profile = honest('nurse'), none = profileOf('nurse');
  const body = jd(J.accountant);
  const near = (o, base) => Math.abs(o.matchScore - base.matchScore) <= 3 && !o.gatePass.gate1;
  // The accountant posting names one of the nurse's rated strengths, in passing.
  const one = fullScore({ title: 'Tax Accountant', company: 'Example and Partners', jdText: body }, { profile });
  const base = fullScore({ title: 'Tax Accountant', company: 'Example and Partners', jdText: body }, { profile: none });
  assert.match(one.rankReason, /fit:/);
  assert.ok(near(one, base), `${one.matchScore} vs ${base.matchScore} unrated: ${one.rankReason}`);
  // Three rated skills named by a posting from another field do not open the table.
  const tacked = `${body}\nWound care and telemetry experience is required.`;
  const three = fullScore({ title: 'Tax Accountant', company: 'Example and Partners', jdText: tacked }, { profile });
  const base3 = fullScore({ title: 'Tax Accountant', company: 'Example and Partners', jdText: tacked }, { profile: none });
  assert.match(three.rankReason, /skills:3\//);
  assert.ok(near(three, base3), `${three.matchScore} vs ${base3.matchScore} unrated: ${three.rankReason}`);
  // A posting in the field under a title with no target role word, covered
  // under the field mark: the rated skills it names open the table in full.
  for (const who of ['nurse', 'accountant']) {
    const p = honest(who), own = jd(J[who], { k: 2 });
    const plain = fullScore({ title: 'Program Coordinator', company: 'Example Co', jdText: own }, { profile: profileOf(who) });
    assert.ok(plain.fitCoverage < 0.5, `${who}: derived ${plain.fitCoverage}`);
    const untitled = fullScore({ title: 'Program Coordinator', company: 'Example Co', jdText: own }, { profile: p });
    const titled = fullScore({ title: J[who].title, company: 'Example Co', jdText: own }, { profile: p });
    assert.strictEqual(untitled.fitCoverage, titled.fitCoverage, `${who}: ${untitled.rankReason}`);
    assert.notStrictEqual(untitled.fitCoverage, plain.fitCoverage, who);
  }
});

// General tools and methods that postings in the user's own field ask for and
// other fields ask for too. Rated, they must not rate a posting from another
// field that names several of them among its own duties (measured on 1361 real
// postings of a third field: 62 at 65 or above for a tax accountant before the
// named skills arm was scaled by the derived estimate, none after).
// Limit, not fixed: rated terms are evidence too, so a short posting that
// names six or more of them is covered by them and is scored by the table.
test('a rated table holding tools shared across fields does not rate a posting from another field that names them', () => {
  const SHARED = ['excel', 'sql', 'reporting', 'data analysis', 'forecasting', 'process improvement', 'project management', 'automation'];
  const ASK = 'Strong Excel and SQL skills and experience with reporting.';
  for (const [who, other] of [['nurse', 'accountant'], ['accountant', 'nurse']]) {
    const levels = { ...topTerms(who), ...Object.fromEntries(SHARED.map((t, i) => [t, i % 3 ? 0.85 : 1])), ...Object.fromEntries(HONEST_WEAK[who].slice(0, 15).map((t) => [t, 0.2])) };
    const profile = profileOf(who, { skills: { levels } });
    assert.strictEqual(profile.ratedTrust, 1, who);
    assert.strictEqual(profile.ratedness, 1, who);
    for (const style of STYLES) {
      const posting = { title: J[other].title, company: J[other].company, jdText: `${jd(J[other], { style })}\n${ASK}` };
      const o = fullScore({ ...posting }, { profile });
      assert.match(o.rankReason, /fit:[^,;]*sql/, `${who}: the posting names the shared tools`);
      assert.ok(o.matchScore < 55 && !o.gatePass.gate1, `${who}, ${style}: ${o.matchScore} ${o.rankReason}`);
    }
  }
});

// Known limits of a fully trusted table, measured and not fixed: it is scored
// by the rated skills a posting names alone (the private formula), so
//   an adjacent role that names the user's strengths lands in the 65 band,
//   and so does a table that rates only a few weaknesses;
//   a title that shares a word with a target role switches the field check off.
// todo: weigh rated hits by where in the posting they sit, tuned against the
// owner equivalent parity run (Spearman 0.85, 6 points, 75 percent same band).
test('todo: under a fully trusted table an adjacent role stays in the 55 to 64 band', { todo: true }, () => {
  for (const [who, , adjacent] of CASES) for (const weak of [15, 4]) {
    const profile = honest(who, weak);
    for (const style of STYLES) for (const quals of QUALS) {
      const adj = score(profile, EXTRA[adjacent], { style, quals, ...whole(EXTRA[adjacent]) });
      assert.ok(adj.matchScore >= 55 && adj.matchScore <= 64, `${who}, ${weak} weak, ${style}/${quals}: ${adj.matchScore} ${adj.rankReason}`);
    }
  }
});
test('todo: under a fully trusted table another field under a target title stays below 55', { todo: true }, () => {
  for (const [who, other] of [['nurse', 'accountant'], ['accountant', 'nurse']]) {
    const p = fullScore({ title: J[who].title, company: J[other].company, jdText: jd(J[other]) }, { profile: honest(who) });
    assert.ok(p.matchScore < 55 && !p.gatePass.gate1, `${who}: ${p.matchScore} ${p.rankReason}`);
  }
});

// A trademark or service mark sign after a product name ("Name(TM)" as one
// character) must not glue letters onto the name.
test('a skill followed by a trademark sign in a raw description counts as held', () => {
  for (const [who, name] of [['nurse', 'Epic'], ['accountant', 'Excel']]) {
    for (const levels of [undefined, { [name.toLowerCase()]: 0.95, [who === 'nurse' ? 'ventilator' : 'transfer pricing']: 0.3 }]) {
      const profile = profileOf(who, levels ? { skills: { levels } } : {});
      const plain = jd(J[who]);
      assert.ok(plain.includes(name));
      for (const sign of ['™', '℠']) {
        const marked = plain.replace(new RegExp(`\\b${name}\\b`, 'g'), `${name}${sign}`);
        assert.notEqual(marked, plain);
        const a = fullScore({ title: J[who].title, company: J[who].company, jdText: plain }, { profile });
        const m = fullScore({ title: J[who].title, company: J[who].company, jdText: marked }, { profile });
        assert.equal(m.rankReason, a.rankReason);
        assert.equal(m.matchScore, a.matchScore);
        assert.match(fullScore({ title: 'Zzrole', jdText: `The work covers: ${name}${sign}.` }, { profile }).rankReason, new RegExp(`fit:${name.toLowerCase()}`));
      }
    }
  }
});

// Posting text is stored ASCII folded (lib/posting.js); the user's words keep
// their accents. Both sides are folded for matching.
test('accented skills in the user files match a posting whose text was folded to ASCII', () => {
  const { stripHtml } = require('../lib/posting');
  const cases = [
    { seeds: ['Infirmi\u00e8re'], title: 'Infirmi\u00e8re en r\u00e9animation', held: 'r\u00e9animation', rated: 'h\u00e9modialyse', gap: 'p\u00e9diatrie',
      bullets: [b('f1', 'Soins aux patients intub\u00e9s en r\u00e9animation, surveillance h\u00e9modynamique.', ['r\u00e9animation', 'surveillance h\u00e9modynamique']), b('f2', 'Pr\u00e9paration des perfusions et tra\u00e7abilit\u00e9 des soins.', ['perfusion', 'tra\u00e7abilit\u00e9'])],
      jd: '<p>Missions : soins en r\u00e9animation, surveillance h\u00e9modynamique, s\u00e9ances d\'h\u00e9modialyse.</p><p>Required: exp\u00e9rience en p\u00e9diatrie.</p>' },
    { seeds: ['Comptable'], title: 'Comptable fiscalit\u00e9', held: 'fiscalit\u00e9', rated: 'cl\u00f4ture mensuelle', gap: 'consolidation ifrs',
      bullets: [b('g1', 'D\u00e9clarations de TVA et fiscalit\u00e9 des soci\u00e9t\u00e9s pour 30 clients.', ['fiscalit\u00e9', 'd\u00e9claration tva']), b('g2', 'R\u00e9vision des comptes et rapprochements bancaires.', ['r\u00e9vision comptable', 'rapprochement bancaire'])],
      jd: '<p>Missions : fiscalit\u00e9 des soci\u00e9t\u00e9s, d\u00e9claration TVA, cl\u00f4ture mensuelle.</p><p>Required: ma\u00eetrise de la consolidation IFRS.</p>' },
  ];
  for (const c of cases) {
    const profile = buildProfile({ root: workspace({
      'data/queries/seeds.json': { queries: c.seeds },
      'data/bullet-library.json': { current: c.bullets },
      'data/profile.json': { skills: { levels: { [c.rated]: 0.95 }, gaps: [c.gap] } },
    }) });
    const folded = stripHtml(c.jd);
    assert.doesNotMatch(folded, /[^\x00-\x7F]/);
    const fold = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const raw = fullScore({ title: c.title, jdText: c.jd.replace(/<[^>]+>/g, '\n') }, { profile });
    const p = fullScore({ title: fold(c.title), jdText: folded }, { profile });
    assert.match(p.rankReason, new RegExp(`fit:[^,]*${fold(c.held)}`), p.rankReason);
    assert.match(p.rankReason, /differentiators/, p.rankReason);
    assert.match(p.rankReason, new RegExp(`gap:[^,]*${fold(c.gap)}`), p.rankReason);
    assert.deepEqual(p.minimumsUnmet, [c.gap]);
    assert.deepEqual(raw.minimumsUnmet, [c.gap]);
    assert.equal(p.matchScore, raw.matchScore, `${p.rankReason} vs ${raw.rankReason}`);
  }
});

// Letters with no ASCII form (Maltese, Azerbaijani) are dropped from stored
// posting text and a Catalan middle dot is stored as a space; the user's words
// are folded the same way, so they find the posting raw and stored alike.
test('user words with a middle dot or a letter that has no ASCII form match a stored posting', () => {
  const { stripHtml } = require('../lib/posting');
  const keywords = ['col·laboració interdisciplinària', 'ħaddiem tas-saħħa', 'mühasibə', 'post–operative care'];
  const profile = buildProfile({ root: workspace({
    'data/bullet-library.json': { current: [b('m1', 'Zzalpha qqbeta.', keywords)] },
    'data/profile.json': { skills: { gaps: ['ħlas tat-taxxa'] } },
  }) });
  const html = `<p>Zzgamma qqdelta: ${keywords.join('; ')}.</p><p>Required: Ħlas tat-taxxa.</p>`;
  const stored = stripHtml(html);
  assert.doesNotMatch(stored, /[^\x00-\x7F]/);
  const raw = fullScore({ title: 'Zzrole', jdText: html.replace(/<[^>]+>/g, '\n') }, { profile });
  const p = fullScore({ title: 'Zzrole', jdText: stored }, { profile });
  for (const r of [raw, p]) {
    assert.match(r.rankReason, /skills:4\/4/, r.rankReason);
    assert.deepEqual(r.minimumsUnmet, ['ħlas tat-taxxa']);
  }
  assert.equal(p.matchScore, raw.matchScore, `${p.rankReason} vs ${raw.rankReason}`);
  // Spellings with punctuation of their own are untouched.
  const tech = buildProfile({ root: workspace({ 'data/bullet-library.json': { current: [b('t1', 'Zzalpha.', ['C++', '.NET', 'follow-up'])] } }) });
  const t = fullScore({ title: 'Zzrole', jdText: 'The work covers: C++; .NET; follow up calls.' }, { profile: tech });
  assert.match(t.rankReason, /skills:3\/3/, t.rankReason);
  const miss = fullScore({ title: 'Zzrole', jdText: 'The work covers: C; NET income; the internet; following.' }, { profile: tech });
  assert.match(miss.rankReason, /skills:0\/3/, miss.rankReason);
});
