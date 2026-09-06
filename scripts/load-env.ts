/**
 * Environment loading for standalone scripts (`npm run agent:smoke`).
 *
 * Next.js loads .env.local ahead of .env; plain `dotenv/config` reads only
 * .env, so a credential in .env.local worked in the browser and silently
 * failed in scripts. This restores the same precedence:
 *
 *   real shell export  >  .env.local (gitignored, secrets)  >  .env (committed)
 *
 * dotenv never overwrites an already-set variable, so loading .env.local
 * first is what gives it priority.
 *
 * Import this before any module that reads process.env.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config();
