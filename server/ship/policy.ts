import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

export const SHIP_POLICY_FILE = "ship-policy.json";

const patternRuleSchema = z.object({
  pattern: z.string().min(1).max(500),
  message: z.string().min(1).max(500),
}).strict();

export const shipPolicySchema = z.object({
  version: z.literal(1),
  autoApprove: z.boolean(),
  autoMerge: z.boolean(),
  requiredChecks: z.array(z.string().min(1).max(200)).max(100),
  forbiddenPatterns: z.array(patternRuleSchema).max(100),
  styleRules: z.array(patternRuleSchema).max(100),
}).strict();

export type ShipPolicy = z.infer<typeof shipPolicySchema>;
export type PatternRule = z.infer<typeof patternRuleSchema>;

export class ShipPolicyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The policy a team has not configured yet: nothing auto-approved, nothing auto-merged. */
export function defaultShipPolicy(): ShipPolicy {
  return { version: 1, autoApprove: false, autoMerge: false, requiredChecks: [], forbiddenPatterns: [], styleRules: [] };
}

function patternError(rules: PatternRule[]): string | null {
  for (const rule of rules) {
    try {
      new RegExp(rule.pattern);
    } catch {
      return `The pattern ${JSON.stringify(rule.pattern)} is not a valid pattern. Fix it before saving the policy.`;
    }
  }
  return null;
}

/** Parses unknown input into a policy, in plain words when it does not fit. */
export function validateShipPolicy(input: unknown): ShipPolicy {
  const parsed = shipPolicySchema.safeParse(input);
  if (!parsed.success) throw new ShipPolicyError("That policy does not fit the expected shape. Send autoApprove and autoMerge as true or false, and requiredChecks, forbiddenPatterns and styleRules as lists.");
  const bad = patternError(parsed.data.forbiddenPatterns) ?? patternError(parsed.data.styleRules);
  if (bad) throw new ShipPolicyError(bad);
  if (parsed.data.autoMerge && !parsed.data.autoApprove) {
    throw new ShipPolicyError("Auto-merge needs auto-approve turned on as well. A pull request is only merged after it has been approved.");
  }
  return parsed.data;
}

export class ShipPolicyStore {
  private readonly file: string;
  private cache: ShipPolicy | null = null;

  constructor(options: { dataDir: string }) {
    this.file = join(options.dataDir, SHIP_POLICY_FILE);
  }

  get(): ShipPolicy {
    if (this.cache) return structuredClone(this.cache);
    if (!existsSync(this.file)) return defaultShipPolicy();
    try {
      const policy = validateShipPolicy(JSON.parse(readFileSync(this.file, "utf8")));
      this.cache = policy;
      return structuredClone(policy);
    } catch {
      console.warn("ship policy: ship-policy.json could not be read; the default policy is in use until it is saved again");
      return defaultShipPolicy();
    }
  }

  save(policy: ShipPolicy): ShipPolicy {
    const valid = validateShipPolicy(policy);
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(valid, null, 2)}\n`);
    this.cache = valid;
    return structuredClone(valid);
  }
}
