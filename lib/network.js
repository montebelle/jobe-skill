/**
 * Referral network lookup.
 *
 * Replaces the stub "referral check" in find.md. Reads a user-supplied
 * contacts file at data/contacts.json with entries shaped like:
 *   {
 *     "name": "Jane Doe",
 *     "company": "Stripe",
 *     "role": "Senior ML Engineer",
 *     "how": "former colleague at Acme Corp 2023",
 *     "linkedinUrl": "https://linkedin.com/in/...",
 *     "strongTie": true
 *   }
 *
 * If the file does not exist, lookupReferrals returns [] and the caller
 * may choose to prompt the user to populate it. No stub "possible contacts"
 * are fabricated.
 *
 * Empirical basis for the feature: Burks et al (QJE 2015), Friebel et al
 * (NBER 2019): referred candidates show roughly an order-of-magnitude
 * higher hire rate and 12-20% lower turnover. Surfacing contacts is the
 * single highest-leverage lever in the skill.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');
const { companySlug } = require('./posting');

const CONTACTS_PATH = () => path.join(getProjectRoot(), 'data', 'contacts.json');

function loadContacts() {
  const file = CONTACTS_PATH();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.contacts || []);
  } catch { return []; }
}

function lookupReferrals(company) {
  const slug = companySlug(company || '');
  if (!slug) return [];
  const contacts = loadContacts();
  return contacts.filter(c => companySlug(c.company || '') === slug);
}

function referralStatus(company) {
  const hits = lookupReferrals(company);
  if (!hits.length) return { status: 'cold', contacts: [] };
  const strong = hits.filter(c => c.strongTie);
  return {
    status: strong.length ? 'strong-tie' : 'weak-tie',
    contacts: hits,
    strongTieCount: strong.length,
    totalCount: hits.length,
  };
}

/**
 * For a list of companies, return referral status per company.
 * Used by find.md Step 3.
 */
function referralCheck(companyNames) {
  return companyNames.map(name => ({ company: name, ...referralStatus(name) }));
}

// Bootstrap helper: write an empty contacts file with usage instructions
function ensureContactsFileExists() {
  const file = CONTACTS_PATH();
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seed = {
    $schema: 'Each entry: { name, company, role, how, linkedinUrl, strongTie }. strongTie=true if the candidate worked directly with this person. Populate from LinkedIn export.',
    contacts: [],
  };
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  return true;
}

module.exports = {
  loadContacts,
  lookupReferrals,
  referralStatus,
  referralCheck,
  ensureContactsFileExists,
};
