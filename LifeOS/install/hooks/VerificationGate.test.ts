/**
 * VerificationGate claim detectors. T5 must-fire cases are the founding incident's
 * sentences and logged true positives; T5 must-pass cases are paraphrases of false
 * positives the gate actually blocked, each a sentence that once stopped a turn.
 * The quote cases pin the shared rule in stripNoise: a quoted clause is a mention.
 */
import { describe, expect, test } from "bun:test";
import { classifyClaim, publicityClaimUnit } from "./VerificationGate.hook";

const T5_MUST_FIRE = [
  "7.23.2 is public right now",
  "LifeOS 7.40.4 is already published",
  "Binaries and bridge are live on 1.0.1",
  "The public repo is live at github.com/example/repo",
  "Both repos now live on GitHub",
  "The release is out",
  "The fork is published",
  "No issues: 7.40.4 is live on GitHub",
  'v7.40.4 is live on the "main" branch on GitHub',
];

const T5_MUST_PASS = [
  // a client's internal standards and process
  "The drafts follow the review's rule: no standard is published until the team that enforces it has agreed in writing",
  "One design pattern is published",
  "The architect said one design pattern is published (MFA)",
  "**Patterns:** Three patterns are published",
  "artifacts are published (V8 / V5)",
  // pentest findings about a client's own exposure
  "F-012's 15 mentions are the finding proving the key is published",
  "working credentials are published in the client's own storefront JavaScript",
  "the window is the period the key was published",
  "Their portal is published through Azure AD Application Proxy",
  // negations and non-publicity uses of the verbs
  "None of it is published anywhere yet: the site's four positions",
  "No version is live on GitHub yet",
  "and all Kali processes are now released",
  // quoting a claim is not making it
  'Only "Binaries and bridge are live on 1.0.1" was a real claim, and it still fires',
  "The log recorded “7.23.2 is public right now” as the founding sentence",
  // local and staged state
  "7.40.4 is live locally",
  "The payload is staged and 7.40.4 is released to the candidate tree",
];

describe("T5 publicity detector", () => {
  for (const s of T5_MUST_FIRE) test(`fires: ${s}`, () => expect(publicityClaimUnit(s)).not.toBeNull());
  for (const s of T5_MUST_PASS) test(`passes: ${s}`, () => expect(publicityClaimUnit(s)).toBeNull());
});

describe("quoted clauses are mentions for T1-T4", () => {
  const typed: [string, string][] = [
    ['The "Sign in" flow works', "T2"],
    ["The site is live at https://example.com", "T1"],
    ["All tests pass", "T4"],
  ];
  for (const [s, type] of typed) test(`classifies ${type}: ${s}`, () => expect(classifyClaim(s)?.type).toBe(type));

  const mentions = [
    'You flagged that the "login flow works" line was premature',
    'The old summary said "the site is live and deployed to prod"',
    "I copied “tests pass” from the CI banner",
  ];
  for (const s of mentions) test(`no claim: ${s}`, () => expect(classifyClaim(s)).toBeNull());
});
